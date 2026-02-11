const { supabaseAdmin } = require('../config/supabase');
const { successResponse, errorResponse, addMinutesToTime, hashPassword } = require('../utils/helpers');
const bcrypt = require('bcrypt');
const { createRealMeetLink } = require('../utils/meetEventHelper'); // Use real Meet link creation
const meetLinkService = require('../utils/meetLinkService'); // New Meet Link Service
const emailService = require('../utils/emailService');

const DEFAULT_ASSESSMENT_DOCTOR = {
  email: process.env.FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL || 'assessment.koott@gmail.com',
  firstName: process.env.FREE_ASSESSMENT_PSYCHOLOGIST_FIRST_NAME || 'Assessment',
  lastName: process.env.FREE_ASSESSMENT_PSYCHOLOGIST_LAST_NAME || 'Specialist',
};

const ensureAssessmentPsychologist = async () => {
  try {
    const { data: existing, error } = await supabaseAdmin
      .from('psychologists')
      .select('id, email, first_name, last_name, password_hash')
      .eq('email', DEFAULT_ASSESSMENT_DOCTOR.email)
      .single();

    if (existing && !error) {
      // Account exists - update password only when env is set and hash differs
      const envPassword = process.env.FREE_ASSESSMENT_PSYCHOLOGIST_PASSWORD;
      if (envPassword && typeof envPassword === 'string' && envPassword.trim() !== '') {
        try {
          // Use bcrypt.compare to check if password actually differs
          const passwordMatches = await bcrypt.compare(envPassword, existing.password_hash);
          if (!passwordMatches) {
            // Password differs, compute new hash and update
            const newHash = await hashPassword(envPassword);
            const { error: updateError } = await supabaseAdmin
              .from('psychologists')
              .update({ password_hash: newHash })
              .eq('id', existing.id);
            if (updateError) {
              console.error('⚠️ Failed to update assessment psychologist password:', updateError);
            } else {
              console.log('✅ Updated assessment psychologist password');
            }
          }
        } catch (pwError) {
          console.error('⚠️ Error updating password:', pwError);
        }
      }
      return existing;
    }
  } catch (lookupError) {
    if (lookupError?.code !== 'PGRST116') {
      console.error('Failed to lookup default assessment psychologist:', lookupError);
    }
  }

  try {
      let passwordToUse = process.env.FREE_ASSESSMENT_PSYCHOLOGIST_PASSWORD;
      if (!passwordToUse || typeof passwordToUse !== 'string' || passwordToUse.trim() === '') {
        if (process.env.NODE_ENV === 'production') {
          console.error('FREE_ASSESSMENT_PSYCHOLOGIST_PASSWORD is required in production');
          throw new Error('Assessment psychologist password not configured');
        }
        const crypto = require('crypto');
        passwordToUse = crypto.randomBytes(32).toString('hex');
        console.log('Generated secure password for assessment psychologist (non-production)');
      }
      const passwordHash = await hashPassword(passwordToUse);

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('psychologists')
      .insert([{
        email: DEFAULT_ASSESSMENT_DOCTOR.email,
        password_hash: passwordHash,
        first_name: DEFAULT_ASSESSMENT_DOCTOR.firstName,
        last_name: DEFAULT_ASSESSMENT_DOCTOR.lastName,
        phone: '',
        ug_college: 'N/A',
        pg_college: 'N/A',
        phd_college: 'N/A',
        area_of_expertise: ['Assessments'],
        description: 'Default specialist for free assessment sessions.',
        experience_years: 0,
        individual_session_price: 0,
        cover_image_url: null,
        personality_traits: ['Supportive', 'Assessment-focused']
      }])
      .select('id, email, first_name, last_name')
      .single();

    if (insertError) {
      console.error('Failed to create default assessment psychologist:', insertError);
      throw insertError;
    }

    return inserted;
  } catch (createError) {
    console.error('Error ensuring default assessment psychologist:', createError);
    return null;
  }
};

// Get client's free assessment status
const getFreeAssessmentStatus = async (req, res) => {
  try {
    const userId = req.user.id;
    console.log('🔍 Getting free assessment status for user:', userId);

    // Get or create client details (auto-provision if missing)
    // Note: userId is from users.id, so we need to match clients.user_id, not clients.id
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    let { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('id, user_id, free_assessment_count, free_assessment_available')
      .eq('user_id', userId)
      .single();

    if (clientError || !client) {
      console.warn('Client profile missing, attempting auto-provision from users table:', { userId, clientError });
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: userRow, error: userFetchError } = await supabaseAdmin
        .from('users')
        .select('id, email, first_name, last_name')
        .eq('id', userId)
        .single();

      if (userFetchError || !userRow) {
        return res.status(404).json(
          errorResponse('Client profile not found')
        );
      }

      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: createdClient, error: createClientError } = await supabaseAdmin
        .from('clients')
        .insert({
          user_id: userRow.id,
          free_assessment_count: 0,
          free_assessment_available: true
        })
        .select('id, user_id, free_assessment_count, free_assessment_available')
        .single();

      if (createClientError) {
        console.error('Failed to auto-provision client profile:', createClientError);
        return res.status(404).json(
          errorResponse('Client profile not found')
        );
      }

      client = createdClient;
    }

    // Get existing free assessments
    // Note: client_id in free_assessments refers to clients.id, not users.id
    const { data: assessments, error: assessmentsError } = await supabaseAdmin
      .from('free_assessments')
      .select(`
        id,
        assessment_number,
        scheduled_date,
        scheduled_time,
        status,
        psychologist:psychologists(
          first_name,
          last_name
        )
      `)
      .eq('client_id', client.id)
      .order('assessment_number', { ascending: true });

    if (assessmentsError) {
      console.error('Error fetching assessments:', assessmentsError);
      return res.status(500).json(
        errorResponse('Failed to fetch assessment status')
      );
    }

    const availableAssessments = 3 - client.free_assessment_count;
    const nextAssessmentNumber = client.free_assessment_count + 1;

    res.json(
      successResponse({
        totalAssessments: 3,
        usedAssessments: client.free_assessment_count,
        availableAssessments,
        canBook: availableAssessments > 0,
        nextAssessmentNumber: availableAssessments > 0 ? nextAssessmentNumber : null,
        assessments: assessments || []
      }, 'Free assessment status retrieved successfully')
    );

  } catch (error) {
    console.error('Get free assessment status error:', error);
    res.status(500).json(
      errorResponse('Internal server error')
    );
  }
};

// Get free assessment availability range for calendar
const getFreeAssessmentAvailabilityRange = async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
      return res.status(400).json(
        errorResponse('Start date and end date are required')
      );
    }

    console.log('🔍 Getting free assessment availability range:', startDate, 'to', endDate);

    // Get all active free assessment timeslots
    const { data: timeslots, error: timeslotsError } = await supabaseAdmin
      .from('free_assessment_timeslots')
      .select('time_slot, is_active, max_bookings_per_slot')
      .eq('is_active', true);

    if (timeslotsError) {
      console.error('Error fetching timeslots:', timeslotsError);
      return res.status(500).json(
        errorResponse('Failed to fetch timeslots')
      );
    }

    console.log('🔍 Found global timeslots:', timeslots?.length || 0);
    console.log('🔍 Sample global timeslots:', timeslots?.slice(0, 3) || []);

    // Get date-specific configurations for the range
    const { data: dateConfigs, error: dateConfigsError } = await supabaseAdmin
      .from('free_assessment_date_configs')
      .select('date, time_slots, max_bookings_per_slot')
      .gte('date', startDate)
      .lte('date', endDate)
      .eq('is_active', true);

    if (dateConfigsError) {
      console.error('Error fetching date configs:', dateConfigsError);
      return res.status(500).json(
        errorResponse('Failed to fetch date configurations')
      );
    }

    console.log('🔍 Found date-specific configs:', dateConfigs?.length || 0);

    // Convert date configs to object for easier lookup
    // Store the full config object, not just time_slots
    const dateConfigsByDate = {};
    dateConfigs.forEach(config => {
      dateConfigsByDate[config.date] = config;
    });

    console.log('🔍 Date configs by date:', dateConfigsByDate);
    console.log('🔍 Available dates in configs:', Object.keys(dateConfigsByDate));

    // If no global timeslots exist, check if we have date-specific configurations
    if (!timeslots || timeslots.length === 0) {
      console.log('⚠️ No global timeslots found, checking date-specific configurations...');
      
      // If we have date-specific configurations, use them
      if (dateConfigs && dateConfigs.length > 0) {
        console.log('✅ Found date-specific configurations, processing them...');
        
        // Get existing bookings for the date range to calculate available slots correctly
        const { data: existingBookings, error: bookingsError } = await supabaseAdmin
          .from('free_assessments')
          .select('scheduled_date, scheduled_time')
          .gte('scheduled_date', startDate)
          .lte('scheduled_date', endDate)
          .eq('status', 'booked');

        if (bookingsError) {
          console.error('Error fetching existing bookings:', bookingsError);
          // Continue without booking data - will overestimate availability
        }

        // Count bookings per date and time
        const bookingCounts = {};
        if (existingBookings) {
          existingBookings.forEach(booking => {
            const key = `${booking.scheduled_date}_${booking.scheduled_time}`;
            bookingCounts[key] = (bookingCounts[key] || 0) + 1;
          });
        }
        
        // Generate availability for each date in range using date-specific configs
        const availability = [];
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, '0');
          const d = String(date.getDate()).padStart(2, '0');
          const dateStr = `${y}-${m}-${d}`;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          // Only show future dates
          if (date >= today) {
            const dateConfig = dateConfigsByDate[dateStr];
            
            if (dateConfig) {
              console.log(`🔍 Processing configured date ${dateStr}:`, dateConfig);
              
              // Extract slots (support both grouped object and flat array)
              const extractAllSlots = (ts) => {
                if (Array.isArray(ts)) return ts;
                if (ts && typeof ts === 'object') {
                  return [
                    ...(ts.morning || []),
                    ...(ts.noon || []),
                    ...(ts.evening || []),
                    ...(ts.night || [])
                  ];
                }
                return [];
              };
              const allSlots = extractAllSlots(dateConfig.time_slots);
              
              // Calculate available slots (subtract booked slots)
              let availableSlots = 0;
              const maxBookingsPerSlot = dateConfig?.max_bookings_per_slot ?? 1; // Use DB value or default to 1
              
              allSlots.forEach(slot => {
                const time24Hour = toHms24(slot);
                const bookingKey = `${dateStr}_${time24Hour}`;
                const currentBookings = bookingCounts[bookingKey] || 0;
                
                if (currentBookings < maxBookingsPerSlot) {
                  availableSlots++;
                }
              });
              
              // Include all dates that have slots configured (even if availableSlots is 0)
              // Frontend will handle highlighting based on availableSlots > 0
              if (allSlots.length > 0) {
                availability.push({
                  date: dateStr,
                  availableSlots, // Use calculated available slots (can be 0 if all booked)
                  totalSlots: allSlots.length,
                  isConfigured: true
                });
              }
            }
            // Don't include dates without configs - only dates with configs that have available slots
          }
        }
        
        return res.json(successResponse(availability, 'Free assessment availability fetched successfully'));
      } else {
        console.log('⚠️ No date-specific configurations found either');
        
        // Generate empty availability for each date in range
        const availability = [];
        const start = new Date(startDate);
        const end = new Date(endDate);
        
        for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
          const y = date.getFullYear();
          const m = String(date.getMonth() + 1).padStart(2, '0');
          const d = String(date.getDate()).padStart(2, '0');
          const dateStr = `${y}-${m}-${d}`;
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          
          // Only show future dates
          if (date >= today) {
            availability.push({
              date: dateStr,
              availableSlots: 0,
              totalSlots: 0,
              isConfigured: false
            });
          }
        }
        
        return res.json(
          successResponse(availability, 'No timeslots configured. Please contact admin.')
        );
      }
    }

    // Get existing bookings for the date range
    const { data: existingBookings, error: bookingsError } = await supabaseAdmin
      .from('free_assessments')
      .select('scheduled_date, scheduled_time')
      .gte('scheduled_date', startDate)
      .lte('scheduled_date', endDate)
      .eq('status', 'booked');

    if (bookingsError) {
      console.error('Error fetching existing bookings:', bookingsError);
      return res.status(500).json(
        errorResponse('Failed to fetch existing bookings')
      );
    }

    // Count bookings per date and time
    const bookingCounts = {};
    existingBookings.forEach(booking => {
      const key = `${booking.scheduled_date}_${booking.scheduled_time}`;
      bookingCounts[key] = (bookingCounts[key] || 0) + 1;
    });

    // Generate availability for each date in range
    const availability = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    
    for (let date = new Date(start); date <= end; date.setDate(date.getDate() + 1)) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      const dateStr = `${y}-${m}-${d}`;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      
      // Only show future dates
      if (date >= today) {
        let availableSlots = 0;
        let totalSlots = 0;
        let isConfigured = false;
        
        // Check if this date has specific configuration
        const dateConfig = dateConfigsByDate[dateStr];
        console.log(`🔍 Processing date ${dateStr}:`, { hasConfig: !!dateConfig, config: dateConfig });
        
        if (dateConfig) {
          isConfigured = true;
          console.log(`🔍 Date ${dateStr} has config:`, dateConfig);
          
          // Use date-specific timeslots (support both grouped object and flat array)
          const extractAllSlots = (ts) => {
            if (Array.isArray(ts)) return ts;
            if (ts && typeof ts === 'object') {
              return [
                ...(ts.morning || []),
                ...(ts.noon || []),
                ...(ts.evening || []),
                ...(ts.night || [])
              ];
            }
            return [];
          };
          const allSlots = extractAllSlots(dateConfig.time_slots);
          
          console.log(`🔍 Date ${dateStr} allSlots:`, allSlots);
          totalSlots = allSlots.length;
          
          const maxBookingsPerSlot = Math.max(1, (typeof dateConfig?.maxBookingsPerSlot === 'number' ? dateConfig.maxBookingsPerSlot : 1));
          // Check availability for each configured slot
          allSlots.forEach(slot => {
            // Convert to HH:MM:SS for comparison
            const time24Hour = toHms24(slot);
            const bookingKey = `${dateStr}_${time24Hour}`;
            const currentBookings = bookingCounts[bookingKey] || 0;
            
            if (currentBookings < maxBookingsPerSlot) { // Default max bookings per slot
              availableSlots++;
            }
          });
          
          console.log(`🔍 Date ${dateStr} final: availableSlots=${availableSlots}, totalSlots=${totalSlots}`);
        } else {
          // Use global timeslots
          totalSlots = timeslots.length;
          
          // Check each timeslot for availability
          timeslots.forEach(timeslot => {
            const bookingKey = `${dateStr}_${timeslot.time_slot}`;
            const currentBookings = bookingCounts[bookingKey] || 0;
            const maxBookingsPerSlot = Math.max(1, timeslot.max_bookings_per_slot || 1);
            
            if (currentBookings < maxBookingsPerSlot) {
              availableSlots++;
            }
          });
        }
        
        console.log(`🔍 Date ${dateStr}: configured=${isConfigured}, availableSlots=${availableSlots}, totalSlots=${totalSlots}`);
        
        // Include all dates that have a configuration (even if availableSlots is 0)
        // Also include dates without configs if they have available slots from global timeslots
        // Frontend will handle highlighting based on availableSlots > 0
        if (isConfigured || availableSlots > 0) {
          availability.push({
            date: dateStr,
            availableSlots, // Can be 0 if all slots are booked
            totalSlots,
            isConfigured
          });
        }
      }
    }

    res.json(
      successResponse(availability, 'Free assessment availability retrieved successfully')
    );

  } catch (error) {
    console.error('Get free assessment availability range error:', error);
    res.status(500).json(
      errorResponse('Internal server error')
    );
  }
};

// Helper function to convert 12-hour format to 24-hour
const convertTo24Hour = (time12Hour) => {
  try {
    // Handle different time formats
    if (!time12Hour || typeof time12Hour !== 'string') {
      console.warn('Invalid time format:', time12Hour);
      return '00:00:00';
    }
    
    // If already in 24-hour format, return as is
    if (time12Hour.includes(':') && !time12Hour.includes('AM') && !time12Hour.includes('PM')) {
      const [hours, minutes] = time12Hour.split(':');
      return `${hours.padStart(2, '0')}:${minutes}:00`;
    }
    
    // Handle 12-hour format with AM/PM
    const [time, period] = time12Hour.split(' ');
    if (!time || !period) {
      console.warn('Invalid 12-hour format:', time12Hour);
      return '00:00:00';
    }
    
    const [hours, minutes] = time.split(':');
    let hour24 = parseInt(hours);
    
    if (period === 'PM' && hour24 !== 12) {
      hour24 += 12;
    } else if (period === 'AM' && hour24 === 12) {
      hour24 = 0;
    }
    
    return `${hour24.toString().padStart(2, '0')}:${minutes}:00`;
  } catch (error) {
    console.error('Error converting time format:', time12Hour, error);
    return '00:00:00';
  }
};

// Normalize any time string to HH:MM:SS (supports HH:MM, HH:MM:SS, and 12-hour with AM/PM)
function toHms24(t) {
  try {
    if (!t || typeof t !== 'string') return '00:00:00';
    const s = t.trim();
    const hmsMatch = /^([01]?\d|2[0-3]):([0-5]\d):([0-5]\d)$/.exec(s);
    const hmMatch = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(s);
    const ampmMatch = /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i.exec(s);
    if (hmsMatch) return `${hmsMatch[1].padStart(2,'0')}:${hmsMatch[2].padStart(2,'0')}:${hmsMatch[3].padStart(2,'0')}`;
    if (hmMatch) return `${hmMatch[1].padStart(2,'0')}:${hmMatch[2].padStart(2,'0')}:00`;
    if (ampmMatch) {
      let hours = parseInt(ampmMatch[1], 10);
      const minutes = ampmMatch[2];
      const meridiem = ampmMatch[3].toUpperCase();
      if (meridiem === 'AM') {
        if (hours === 12) hours = 0;
      } else if (meridiem === 'PM') {
        if (hours !== 12) hours += 12;
      }
      return `${String(hours).padStart(2,'0')}:${minutes}:00`;
    }
    return '00:00:00';
  } catch (e) {
    return '00:00:00';
  }
}

async function removeTimeSlotFromDateConfig(date, time) {
  try {
    const normalizedTime = toHms24(time);
    if (!normalizedTime) {
      return;
    }

    const { data: config, error: fetchError } = await supabaseAdmin
      .from('free_assessment_date_configs')
      .select('id, time_slots')
      .eq('date', date)
      .eq('is_active', true)
      .single();

    if (fetchError) {
      if (fetchError.code !== 'PGRST116') {
        console.error('❌ Failed to fetch date config for slot removal:', fetchError);
      }
      return;
    }

    if (!config) {
      return;
    }

    const existingSlots = Array.isArray(config.time_slots) ? config.time_slots : [];
    const updatedSlots = existingSlots.filter(slot => slot !== normalizedTime);

    if (updatedSlots.length === existingSlots.length) {
      return;
    }

    const updatePayload = {
      time_slots: updatedSlots,
      updated_at: new Date().toISOString(),
      is_active: updatedSlots.length > 0
    };

    const { error: updateError } = await supabaseAdmin
      .from('free_assessment_date_configs')
      .update(updatePayload)
      .eq('id', config.id);

    if (updateError) {
      console.error('❌ Failed to update date config after booking:', updateError);
    } else {
      console.log(`✅ Removed booked slot ${normalizedTime} from free assessment config on ${date}`);
    }
  } catch (error) {
    console.error('❌ Error removing time slot from date config:', error);
  }
}

// Get available time slots for free assessments
const getAvailableTimeSlots = async (req, res) => {
  try {
    const { date } = req.query;
    
    if (!date) {
      return res.status(400).json(
        errorResponse('Date parameter is required')
      );
    }

    console.log('🔍 Getting available time slots for date:', date);

    // First check if there's a date-specific configuration
    const { data: dateConfig, error: dateConfigError } = await supabaseAdmin
      .from('free_assessment_date_configs')
      .select('time_slots')
      .eq('date', date)
      .eq('is_active', true)
      .single();

    if (dateConfigError && dateConfigError.code !== 'PGRST116') {
      console.error('Error fetching date config:', dateConfigError);
      return res.status(500).json(
        errorResponse('Failed to fetch date configuration')
      );
    }

    let availableSlots = [];

    if (dateConfig) {
      // Use date-specific configuration
      console.log('🔍 Using date-specific configuration for:', date);
      
      // Get booked free assessments for this date
      const { data: bookedAssessments, error: assessmentsError } = await supabaseAdmin
        .from('free_assessments')
        .select('scheduled_time')
        .eq('scheduled_date', date)
        .eq('status', 'booked');

      if (assessmentsError) {
        console.error('Error fetching booked assessments:', assessmentsError);
        return res.status(500).json(
          errorResponse('Failed to fetch booked assessments')
        );
      }

      // Get booked regular sessions for this date (to account for total bookings)
      const { data: bookedSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select('scheduled_time')
        .eq('scheduled_date', date)
        .eq('status', 'booked');

      if (sessionsError) {
        console.error('Error fetching booked sessions:', sessionsError);
        return res.status(500).json(
          errorResponse('Failed to fetch booked sessions')
        );
      }

      // Count total bookings per time (both assessments and sessions)
      const bookingCounts = {};
      
      // Count free assessment bookings
      bookedAssessments.forEach(booking => {
        bookingCounts[booking.scheduled_time] = (bookingCounts[booking.scheduled_time] || 0) + 1;
      });
      
      // Count regular session bookings
      bookedSessions.forEach(booking => {
        bookingCounts[booking.scheduled_time] = (bookingCounts[booking.scheduled_time] || 0) + 1;
      });

      console.log('🔍 Booking counts for date:', date, bookingCounts);

      // Process date-specific timeslots (support grouped or flat array)
      const flattenSlots = (ts) => {
        if (Array.isArray(ts)) return ts;
        if (ts && typeof ts === 'object') {
          return [
            ...(ts.morning || []),
            ...(ts.noon || []),
            ...(ts.evening || []),
            ...(ts.night || [])
          ];
        }
        return [];
      };
      const allSlots = flattenSlots(dateConfig.time_slots);

      allSlots.forEach(slot => {
        // Normalize to HH:MM:SS for comparison
        const time24Hour = toHms24(slot);
        const currentBookings = bookingCounts[time24Hour] || 0;
        
        console.log(`🔍 Processing slot ${slot} (${time24Hour}): ${currentBookings} bookings`);
        
        if (currentBookings < 20) { // Changed from 3 to 20 for testing
          availableSlots.push({
            time: time24Hour,
            displayTime: (() => { try { const [hh,mm] = time24Hour.split(':'); const h = parseInt(hh,10); const m = parseInt(mm,10)||0; const ampm = h>=12?'PM':'AM'; const h12 = h%12||12; return `${h12}:${m.toString().padStart(2,'0')} ${ampm}`;} catch { return slot; } })(),
            availableBookings: 20 - currentBookings,
            maxBookings: 20,
            currentBookings
          });
        } else {
          console.log(`❌ Slot ${slot} (${time24Hour}) is fully booked (${currentBookings}/20)`);
        }
      });
    } else {
      // Use global timeslots (fallback)
      console.log('🔍 Using global timeslots for:', date);
      
      // Get all psychologists who have availability on this date
      const { data: availability, error: availabilityError } = await supabaseAdmin
        .from('availability')
        .select(`
          psychologist_id,
          time_slots,
          psychologist:psychologists(
            id,
            first_name,
            last_name
          )
        `)
        .eq('date', date)
        .eq('is_available', true);

      if (availabilityError) {
        console.error('Error fetching availability:', availabilityError);
        return res.status(500).json(
          errorResponse('Failed to fetch availability')
        );
      }

      // Get booked sessions for this date
      const { data: bookedSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select('scheduled_time, psychologist_id')
        .eq('scheduled_date', date);

      if (sessionsError) {
        console.error('Error fetching booked sessions:', sessionsError);
        return res.status(500).json(
          errorResponse('Failed to fetch booked sessions')
        );
      }

      // Get booked free assessments for this date
      const { data: bookedAssessments, error: assessmentsError } = await supabaseAdmin
        .from('free_assessments')
        .select('scheduled_time, psychologist_id')
        .eq('scheduled_date', date)
        .eq('status', 'booked');

      if (assessmentsError) {
        console.error('Error fetching booked assessments:', assessmentsError);
        return res.status(500).json(
          errorResponse('Failed to fetch booked assessments')
        );
      }

      // Combine all booked times
      const allBookedTimes = [
        ...bookedSessions.map(s => ({ time: s.scheduled_time, psychologistId: s.psychologist_id })),
        ...bookedAssessments.map(a => ({ time: a.scheduled_time, psychologistId: a.psychologist_id }))
      ];

      // Get active timeslots from the timeslots table
      const { data: timeslots, error: timeslotsError } = await supabaseAdmin
        .from('free_assessment_timeslots')
        .select('time_slot, max_bookings_per_slot')
        .eq('is_active', true)
        .order('time_slot', { ascending: true });

      if (timeslotsError) {
        console.error('Error fetching timeslots:', timeslotsError);
        return res.status(500).json(
          errorResponse('Failed to fetch timeslots')
        );
      }

      // For each active timeslot, check if any psychologist is available
      timeslots.forEach(timeslot => {
        const bookedPsychologists = allBookedTimes
          .filter(booked => booked.time === timeslot.time_slot)
          .map(booked => booked.psychologistId);

        // Find psychologists who are available at this time
        const availablePsychologists = availability.filter(avail => {
          const hasTimeSlot = avail.time_slots.includes(timeslot.time_slot);
          const isNotBooked = !bookedPsychologists.includes(avail.psychologist_id);
          return hasTimeSlot && isNotBooked;
        });

        const maxBookingsForSlot = Math.max(1, timeslot.max_bookings_per_slot || 1);
        // Check if we haven't reached the maximum bookings for this slot
        if (availablePsychologists.length > 0 && bookedPsychologists.length < maxBookingsForSlot) {
          availableSlots.push({
            time: timeslot.time_slot,
            displayTime: (() => { try { const [hh,mm] = timeslot.time_slot.split(':'); const h = parseInt(hh,10); const m = parseInt(mm,10)||0; const ampm = h>=12?'PM':'AM'; const h12 = h%12||12; return `${h12}:${m.toString().padStart(2,'0')} ${ampm}`;} catch { return timeslot.time_slot; } })(),
            availablePsychologists: availablePsychologists.length,
            maxBookings: maxBookingsForSlot,
            currentBookings: bookedPsychologists.length,
            psychologists: availablePsychologists.map(p => ({
              id: p.psychologist.id,
              name: `${p.psychologist.first_name} ${p.psychologist.last_name}`
            }))
          });
        }
      });
    }

    res.json(
      successResponse({
        date,
        availableSlots,
        totalSlots: availableSlots.length,
        isConfigured: !!dateConfig
      }, 'Available time slots retrieved successfully')
    );

  } catch (error) {
    console.error('Get available time slots error:', error);
    res.status(500).json(
      errorResponse('Internal server error')
    );
  }
};

// Book a free assessment
const bookFreeAssessment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { scheduledDate, scheduledTime } = req.body;

    if (!scheduledDate || !scheduledTime) {
      return res.status(400).json(
        errorResponse('Scheduled date and time are required')
      );
    }

    console.log('🔍 Booking free assessment for user:', userId, 'on', scheduledDate, 'at', scheduledTime);

    // Get or create client details (auto-provision if missing)
    // Note: userId is from users.id, so we need to match clients.user_id, not clients.id
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    let { data: client, error: clientError } = await supabaseAdmin
      .from('clients')
      .select('id, user_id, free_assessment_count, free_assessment_available')
      .eq('user_id', userId)
      .single();

    if (clientError || !client) {
      console.warn('Client profile missing, attempting auto-provision from users table:', { userId, clientError });
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: userRow, error: userFetchError } = await supabaseAdmin
        .from('users')
        .select('id, email, first_name, last_name')
        .eq('id', userId)
        .single();

      if (userFetchError || !userRow) {
        return res.status(404).json(
          errorResponse('Client profile not found')
        );
      }

      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: createdClient, error: createClientError } = await supabaseAdmin
        .from('clients')
        .insert({
          user_id: userRow.id,
          free_assessment_count: 0,
          free_assessment_available: true
        })
        .select('id, user_id, free_assessment_count, free_assessment_available')
        .single();

      if (createClientError) {
        console.error('Failed to auto-provision client profile:', createClientError);
        return res.status(404).json(
          errorResponse('Client profile not found')
        );
      }

      client = createdClient;
    }

    // Check if client can book free assessment
    if (client.free_assessment_count >= 3) {
      return res.status(400).json(
        errorResponse('No free assessments available')
      );
    }

    // Ensure a linked users.id exists for FK (free_assessments.user_id NOT NULL)
    let userAccountId = client.user_id || null;
    try {
      if (!userAccountId) {
        // Try to find a users row by client email (clients table usually has email)
        if (!client.email) {
          const { data: clientWithEmail } = await supabaseAdmin
            .from('clients')
            .select('email')
            .eq('user_id', userId)
            .single();
          client.email = clientWithEmail?.email || client.email;
        }

        if (client.email) {
          const { data: existingUserByEmail } = await supabaseAdmin
            .from('users')
            .select('id')
            .eq('email', client.email)
            .single();
          if (existingUserByEmail) {
            userAccountId = existingUserByEmail.id;
            // Link it back to client for future
            await supabaseAdmin
              .from('clients')
              .update({ user_id: userAccountId })
              .eq('user_id', userId);
          }
        }

        // If still missing, create a minimal users row and link
        if (!userAccountId) {
          const { hashPassword } = require('../utils/helpers');
          const tempPassword = `Temp@${Math.random().toString(36).slice(-8)}`;
          const passwordHash = await hashPassword(tempPassword);

          const { data: createdUser, error: createUserError } = await supabaseAdmin
            .from('users')
            .insert({
              email: client.email || `client_${userId}@placeholder.local`,
              role: 'client',
              password_hash: passwordHash,
              created_at: new Date().toISOString()
            })
            .select('id, email')
            .single();

          if (createUserError) {
            console.error('Error auto-creating users row for client:', createUserError);
            return res.status(500).json(
              errorResponse('Failed to prepare client account for booking')
            );
          }

          userAccountId = createdUser.id;
          await supabaseAdmin
            .from('clients')
            .update({ user_id: userAccountId })
            .eq('user_id', userId);
        }
      }
    } catch (linkError) {
      console.error('Error ensuring users linkage for client:', linkError);
      return res.status(500).json(
        errorResponse('Failed to prepare client account')
      );
    }

    // Get the next available assessment number by checking existing assessments
    // Note: client_id in free_assessments refers to clients.id, not users.id
    const { data: existingAssessments, error: existingError } = await supabaseAdmin
      .from('free_assessments')
      .select('assessment_number')
      .eq('client_id', client.id)
      .order('assessment_number', { ascending: true });

    if (existingError) {
      console.error('Error fetching existing assessments:', existingError);
      return res.status(500).json(
        errorResponse('Failed to check existing assessments')
      );
    }

    // Find the next available assessment number (1..3) skipping used numbers
    let nextAssessmentNumber = 1;
    const usedNumbers = (existingAssessments || []).map(a => a.assessment_number);
    
    console.log('🔍 Raw existing assessments:', existingAssessments);
    console.log('🔍 Used numbers:', usedNumbers);
    
    for (let i = 1; i <= 3; i++) {
      if (!usedNumbers.includes(i)) {
        nextAssessmentNumber = i;
        break;
      }
    }

    console.log('🔍 Assessment number calculation:', {
      existingNumbers: usedNumbers,
      nextNumber: nextAssessmentNumber,
      clientCount: client.free_assessment_count,
      totalExisting: existingAssessments.length
    });

    // Check if user has already used all free assessments
    if (usedNumbers.length >= 3) {
      return res.status(400).json(
        errorResponse('You have already used all free assessments')
      );
    }

    // If no next number found (shouldn't happen), return error
    if (nextAssessmentNumber > 3) {
      return res.status(400).json(
        errorResponse('No free assessments available')
      );
    }

    const defaultPsychologist = await ensureAssessmentPsychologist();
    const defaultPsychologistId = defaultPsychologist?.id || null;
    
    // Fetch full psychologist data including Google Calendar credentials
    let defaultPsychologistWithCredentials = null;
    if (defaultPsychologistId) {
      const { data: psychWithCreds } = await supabaseAdmin
        .from('psychologists')
        .select('id, email, first_name, last_name, google_calendar_credentials')
        .eq('id', defaultPsychologistId)
        .single();
      defaultPsychologistWithCredentials = psychWithCreds;
    }
    
    const assessmentPsychologistPayload = defaultPsychologist
      ? {
          id: defaultPsychologist.id,
          first_name: defaultPsychologist.first_name || DEFAULT_ASSESSMENT_DOCTOR.firstName,
          last_name: defaultPsychologist.last_name || DEFAULT_ASSESSMENT_DOCTOR.lastName,
          email: defaultPsychologist.email || DEFAULT_ASSESSMENT_DOCTOR.email
        }
      : null;

    if (!defaultPsychologistId) {
      console.warn('⚠️ Default assessment psychologist missing; proceeding without assignment.');
    } else {
      console.log('✅ Default assessment psychologist:', {
        id: defaultPsychologistId,
        email: defaultPsychologist.email
      });
    }

    console.log('🔄 Creating free assessment record (auto-assigned)...');
    const { data: assessment, error: assessmentError } = await supabaseAdmin
      .from('free_assessments')
      .insert({
        // Use linked users.id (ensured above); client_id is the clients.id
        user_id: userAccountId,
        client_id: client.id,
        assessment_number: nextAssessmentNumber,
        scheduled_date: scheduledDate,
        scheduled_time: scheduledTime,
        psychologist_id: defaultPsychologistId,
        status: 'booked'
      })
      .select()
      .single();

    if (assessmentError) {
      console.error('❌ Error creating free assessment:', assessmentError);
      return res.status(500).json(
        errorResponse('Failed to book free assessment')
      );
    }
    
    console.log('✅ Free assessment record created:', assessment.id);

    // Create a session placeholder (no doctor), with a Meet link ready for admin assignment
    console.log('🔄 Creating session placeholder for free assessment...');
    // Note: client_id must be clients.id (primary key), not users.id
    const sessionData = {
      client_id: client.id,
      psychologist_id: defaultPsychologistId,
      scheduled_date: scheduledDate,
      scheduled_time: scheduledTime,
      status: 'booked',
      price: 0,
      session_type: 'free_assessment',
      original_scheduled_date: scheduledDate
    };

    // Create session first (don't wait for meet link - it will be created asynchronously)
    const { data: session, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert([sessionData])
      .select()
      .single();

    if (sessionError) {
      console.error('❌ Error creating session placeholder:', sessionError);
      // proceed without session, admin can create later
    } else {
      await supabaseAdmin
        .from('free_assessments')
        .update({ session_id: session.id })
        .eq('id', assessment.id);
      console.log('✅ Session placeholder created:', session.id);
      
      // Create meet link asynchronously (don't wait for it)
      (async () => {
        try {
          /**
           * Google Meet Configuration for Free Assessments:
           * 
           * PARTICIPANTS:
           * - Client email (from users table)
           * - Assessment psychologist email (assessment.koott@gmail.com)
           * 
           * HOST:
           * - The Google account that creates the event (assessment.koott@gmail.com if OAuth is connected)
           * - If OAuth is not connected, the service account creates it (no real host)
           * 
           * MEET SETTINGS:
           * - visibility: 'public' - Meeting is public
           * - anyoneCanAddSelf: true - Anyone with the link can join without approval (no waiting room)
           * - guestsCanInviteOthers: true - Guests can invite others
           * - guestsCanSeeOtherGuests: true - Guests can see who else is in the meeting
           * - sendUpdates: 'all' - Calendar invites sent to all attendees
           * 
           * This means:
           * - Client can join directly without waiting for host approval
           * - Anyone with the meet link can join without approval
           * - No waiting room is enabled
           */
          const meetSessionData = {
            summary: `Free Assessment`,
            description: `Free 20-minute assessment session with our specialist`,
            startDate: scheduledDate,
            startTime: scheduledTime,
            endTime: addMinutesToTime(scheduledTime, 20),
            attendees: []
          };

          // If the client has a linked users row, try to fetch their email for attendee
          try {
            const { data: userEmailRow } = await supabaseAdmin
              .from('users')
              .select('email')
              .eq('id', userAccountId)
              .single();
            if (userEmailRow?.email) {
              meetSessionData.attendees = [userEmailRow.email];
            }
          } catch (_) {}

          // Use email from credentials data if available, otherwise fallback to defaultPsychologist
          const psychologistEmail = defaultPsychologistWithCredentials?.email || defaultPsychologist?.email;
          if (psychologistEmail) {
            if (!meetSessionData.attendees.includes(psychologistEmail)) {
              meetSessionData.attendees.push(psychologistEmail);
            }
          }
          
          console.log('📋 Meet Participants:', {
            client: meetSessionData.attendees[0] || 'Not found',
            psychologist: psychologistEmail || 'Not found',
            host: psychologistEmail || 'Service Account (no real host)',
            totalAttendees: meetSessionData.attendees.length
          });

          // Use Little Care Google account's OAuth credentials for real Meet link creation
          // The FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL should be set to your Little Care Google account
          // This ensures calendar invites and Meet links come from Little Care, not assessment.koott@gmail.com
          let userAuth = null;
          if (defaultPsychologistWithCredentials?.google_calendar_credentials) {
            const credentials = defaultPsychologistWithCredentials.google_calendar_credentials;
            const now = Date.now();
            const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
            
            if (credentials.access_token) {
              const expiryDate = credentials.expiry_date ? new Date(credentials.expiry_date).getTime() : null;
              if (!expiryDate || expiryDate > (now + bufferTime)) {
                // Token is valid
                userAuth = {
                  access_token: credentials.access_token,
                  refresh_token: credentials.refresh_token,
                  expiry_date: credentials.expiry_date
                };
                console.log('✅ Using Little Care Google Calendar OAuth credentials for Meet link creation');
                console.log('   📧 Meet link will be created from:', psychologistEmail);
              } else if (credentials.refresh_token) {
                // Token expired but we have refresh token
                userAuth = {
                  access_token: credentials.access_token, // May be expired, service will refresh
                  refresh_token: credentials.refresh_token,
                  expiry_date: credentials.expiry_date
                };
                console.log('⚠️ Little Care OAuth token expired, but refresh token available - service will attempt refresh');
              } else {
                console.log('⚠️ Little Care OAuth credentials expired and no refresh token - will use fallback method');
              }
            }
          } else {
            console.log('⚠️ Little Care Google account does not have Google Calendar connected');
            console.log('   💡 Please connect Google Calendar for the free assessment psychologist account');
            console.log('   💡 Set FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL to your Little Care Google account email');
          }

          // Create meet link using Little Care Google account OAuth (creates real Meet links)
          const meetResult = await meetLinkService.generateSessionMeetLink(meetSessionData, userAuth);
          let finalMeetLink = null;
          
          // If tokens were refreshed, update them in the database
          if (userAuth && meetResult?.refreshedTokens) {
            try {
              await supabaseAdmin
                .from('psychologists')
                .update({
                  google_calendar_credentials: {
                    access_token: meetResult.refreshedTokens.access_token,
                    refresh_token: meetResult.refreshedTokens.refresh_token,
                    expiry_date: meetResult.refreshedTokens.expiry_date
                  }
                })
                .eq('id', defaultPsychologistId);
              console.log('✅ Updated refreshed OAuth tokens in database');
            } catch (updateError) {
              console.error('⚠️ Failed to update refreshed tokens in database:', updateError.message);
            }
          }
          
          if (meetResult?.success && meetResult.meetLink) {
            finalMeetLink = meetResult.meetLink;
            await supabaseAdmin
              .from('sessions')
              .update({
                google_calendar_event_id: meetResult.eventId || null,
                google_meet_link: finalMeetLink,
                google_meet_join_url: finalMeetLink,
                google_meet_start_url: finalMeetLink
              })
              .eq('id', session.id);
            console.log('✅ Meet link created asynchronously for free assessment:', finalMeetLink);
          } else {
            finalMeetLink = meetResult?.meetLink || 'https://meet.google.com/new?hs=122&authuser=0';
            await supabaseAdmin
              .from('sessions')
              .update({
                google_meet_link: finalMeetLink,
                google_meet_join_url: finalMeetLink,
                google_meet_start_url: finalMeetLink
              })
              .eq('id', session.id);
            console.log('⚠️ Meet link creation failed; using fallback (async)');
          }

          // Now send WhatsApp with the real meet link (or fallback if creation failed)
          try {
            console.log('📱 Sending WhatsApp notifications with meet link for free assessment booking...');
            const { sendBookingConfirmation, sendWhatsAppTextWithRetry } = require('../utils/whatsappService');
            
            // Get client phone number
            const { data: clientDetails } = await supabaseAdmin
              .from('clients')
              .select('phone_number, child_name, first_name, last_name')
              .eq('id', client.id)
              .single();
            
            const clientPhone = clientDetails?.phone_number || null;
            // Only include childName if child_name exists and is not empty/null/'Pending'
            const childName = clientDetails?.child_name && 
              clientDetails.child_name.trim() !== '' && 
              clientDetails.child_name.toLowerCase() !== 'pending'
              ? clientDetails.child_name 
              : null;
            
            // Define clientName for WhatsApp messages (same logic as email)
            const clientName = clientDetails?.child_name || 
                              (clientDetails?.first_name && clientDetails?.last_name 
                                ? `${clientDetails.first_name} ${clientDetails.last_name}`.trim()
                                : clientDetails?.first_name || 'Client');
            
            // Send WhatsApp to client with the real meet link
            if (clientPhone && finalMeetLink) {
              try {
                await sendBookingConfirmation(clientPhone, {
                  childName: childName,
                  date: scheduledDate,
                  time: scheduledTime,
                  meetLink: finalMeetLink,
                  isFreeAssessment: true
                });
                console.log('✅ Free assessment WhatsApp sent to client with meet link');
              } catch (clientWaError) {
                console.error('❌ Failed to send client WhatsApp for free assessment:', clientWaError?.message || clientWaError);
              }
            } else {
              console.log('ℹ️ No client phone or meet link; skipping client WhatsApp');
            }

            // Send WhatsApp to doctor at +919539007766
            const doctorPhone = '+919539007766';
            const psychologistName = assessmentPsychologistPayload
              ? `${assessmentPsychologistPayload.first_name} ${assessmentPsychologistPayload.last_name}`.trim()
              : 'Assessment Specialist';
            
            const doctorMessage =
              `🧸 New free assessment session booked.\n\n` +
              `Session details:\n\n` +
              `👧 Client: ${clientName}\n\n` +
              `📝 Assessment: Free Assessment (${nextAssessmentNumber} of 3)\n\n` +
              `👨‍⚕️ Assigned to: ${psychologistName}\n\n` +
              `📅 Date: ${scheduledDate}\n\n` +
              `⏰ Time: ${scheduledTime} (IST)\n\n` +
              `🔗 Google Meet: ${finalMeetLink}\n\n` +
              `🆔 Assessment ID: ${assessment.id}\n\n` +
              `📞 For support or scheduling issues, contact Little Care support:\n` +
              `WhatsApp / Call: +91 95390 07766`;

            try {
              await sendWhatsAppTextWithRetry(doctorPhone, doctorMessage);
              console.log('✅ Free assessment WhatsApp sent to doctor at +919539007766 with meet link');
            } catch (doctorWaError) {
              console.error('❌ Failed to send doctor WhatsApp for free assessment:', doctorWaError?.message || doctorWaError);
            }
          } catch (whatsappError) {
            console.error('❌ Error sending WhatsApp notifications for free assessment:', whatsappError);
          }

          // Send confirmation email AFTER Meet link is created (so email contains real link)
          try {
            // Fetch user details for email
            let userRowForEmail = null;
            if (userAccountId) {
              const result = await supabaseAdmin
                .from('users')
                .select('email')
                .eq('id', userAccountId)
                .single();
              userRowForEmail = result.data;
            }

            // Get client details for email
            const { data: clientDetails } = await supabaseAdmin
              .from('clients')
              .select('child_name, first_name, last_name')
              .eq('id', client.id)
              .single();

            const clientName = clientDetails?.child_name || 
                              (clientDetails?.first_name && clientDetails?.last_name 
                                ? `${clientDetails.first_name} ${clientDetails.last_name}`.trim()
                                : clientDetails?.first_name || 'Client');

            console.log('📧 Sending free assessment confirmation email with Meet link:', finalMeetLink);
            await emailService.sendFreeAssessmentConfirmation({
              clientName: clientName,
              psychologistName: assessmentPsychologistPayload
                ? `${assessmentPsychologistPayload.first_name} ${assessmentPsychologistPayload.last_name}`.trim()
                : 'Assessment Specialist',
              assessmentDate: scheduledDate,
              assessmentTime: scheduledTime,
              assessmentNumber: nextAssessmentNumber,
              clientEmail: userRowForEmail?.email,
              psychologistEmail: assessmentPsychologistPayload?.email || null,
              googleMeetLink: finalMeetLink // Use the real Meet link that was just created
            });
            console.log('✅ Free assessment confirmation email sent with Meet link');
          } catch (emailError) {
            console.error('❌ Error sending confirmation email:', emailError);
          }
        } catch (e) {
          console.error('❌ Error creating meet link asynchronously:', e);
          const fallbackLink = 'https://meet.google.com/new?hs=122&authuser=0';
          await supabaseAdmin
            .from('sessions')
            .update({
              google_meet_link: fallbackLink,
              google_meet_join_url: fallbackLink,
              google_meet_start_url: fallbackLink
            })
            .eq('id', session.id);
          
          // Still try to send email with fallback link
          try {
    let userRowForEmail = null;
    if (userAccountId) {
      const result = await supabaseAdmin
        .from('users')
        .select('email')
        .eq('id', userAccountId)
        .single();
      userRowForEmail = result.data;
            }
      await emailService.sendFreeAssessmentConfirmation({
        clientName: 'Client',
        psychologistName: assessmentPsychologistPayload
          ? `${assessmentPsychologistPayload.first_name} ${assessmentPsychologistPayload.last_name}`.trim()
          : 'Assessment Specialist',
        assessmentDate: scheduledDate,
        assessmentTime: scheduledTime,
        assessmentNumber: nextAssessmentNumber,
        clientEmail: userRowForEmail?.email,
        psychologistEmail: assessmentPsychologistPayload?.email || null,
              googleMeetLink: fallbackLink
      });
    } catch (emailError) {
            console.error('❌ Error sending fallback email:', emailError);
          }
        }
      })();
    }

    // Update client's free assessment count: atomic increment or recompute from actual assessments
    const { count: bookedCount } = await supabaseAdmin
      .from('free_assessments')
      .select('*', { count: 'exact', head: true })
      .eq('client_id', client.id)
      .in('status', ['booked', 'completed', 'scheduled']);
    const newCount = bookedCount ?? nextAssessmentNumber;
    await supabaseAdmin
      .from('clients')
      .update({ free_assessment_count: newCount })
      .eq('id', client.id);

    await removeTimeSlotFromDateConfig(scheduledDate, scheduledTime);

    res.json(
      successResponse({
        assessmentId: assessment.id,
        assessmentNumber: nextAssessmentNumber,
        psychologist: assessmentPsychologistPayload,
        scheduledDate,
        scheduledTime,
        meetLink: 'https://meet.google.com/new?hs=122&authuser=0' // Will be updated asynchronously
      }, 'Free assessment booked successfully')
    );

  } catch (error) {
    console.error('Book free assessment error:', error);
    res.status(500).json(
      errorResponse('Internal server error')
    );
  }
};

// Cancel a free assessment
const cancelFreeAssessment = async (req, res) => {
  try {
    const userId = req.user.id;
    const { assessmentId } = req.params;

    console.log('🔍 Cancelling free assessment:', assessmentId, 'for user:', userId);

    // Get the assessment - first get client by user_id, then check assessment belongs to that client
    const { data: clientRecord } = await supabaseAdmin
      .from('clients')
      .select('id')
      .eq('user_id', userId)
      .single();
    
    if (!clientRecord) {
      return res.status(404).json(
        errorResponse('Client profile not found')
      );
    }

    const { data: assessment, error: assessmentError } = await supabaseAdmin
      .from('free_assessments')
      .select('*')
      .eq('id', assessmentId)
      .eq('client_id', clientRecord.id)
      .single();

    if (assessmentError || !assessment) {
      return res.status(404).json(
        errorResponse('Free assessment not found')
      );
    }

    if (assessment.status !== 'booked') {
      return res.status(400).json(
        errorResponse('Assessment cannot be cancelled')
      );
    }

    // Update assessment status
    await supabaseAdmin
      .from('free_assessments')
      .update({ status: 'cancelled' })
      .eq('id', assessmentId);

    // Update session status if exists
    if (assessment.session_id) {
      await supabaseAdmin
        .from('sessions')
        .update({ status: 'cancelled' })
        .eq('id', assessment.session_id);
    }

    // Decrease client's free assessment count
    if (clientRecord) {
      const { data: clientData } = await supabaseAdmin
        .from('clients')
        .select('free_assessment_count')
        .eq('id', clientRecord.id)
        .single();
      
      if (clientData) {
        const newCount = Math.max(0, (clientData.free_assessment_count ?? 0) - 1);
        await supabaseAdmin
          .from('clients')
          .update({ 
            free_assessment_count: newCount
          })
          .eq('id', clientRecord.id);
      }
    }

    res.json(
      successResponse(null, 'Free assessment cancelled successfully')
    );

  } catch (error) {
    console.error('Cancel free assessment error:', error);
    res.status(500).json(
      errorResponse('Internal server error')
    );
  }
};

// Admin: List free assessments with optional status filter
const adminListFreeAssessments = async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabaseAdmin
      .from('free_assessments')
      .select(`
        id,
        assessment_number,
        scheduled_date,
        scheduled_time,
        status,
        session_id,
        client:clients(id, first_name, last_name, email),
        psychologist:psychologists(id, first_name, last_name, email),
        session:sessions(google_meet_link, feedback, rating)
      `)
      .order('scheduled_date', { ascending: true })
      .order('scheduled_time', { ascending: true });

    if (status) {
      // If status filter is provided, use it
      if (status === 'all') {
        // 'all' means show everything including completed
        // Don't add any status filter
      } else {
        query = query.eq('status', status);
      }
    } else {
      // Default: exclude completed assessments when no filter is provided
      query = query.neq('status', 'completed');
    }

    const { data, error } = await query;
    if (error) {
      console.error('Admin list free assessments error:', error);
      return res.status(500).json(errorResponse('Failed to fetch free assessments'));
    }

    // Normalize payload and ensure a meet link is available (generate on the fly if missing)
    const meetLinkService = require('../utils/meetLinkService');
    const assessments = [];
    for (const a of (data || [])) {
      let meetLink = a.session?.google_meet_link || null;
      if (!meetLink) {
        try {
          const result = await meetLinkService.generateSessionMeetLink({
            summary: 'Free Assessment',
            description: 'Free 20-minute assessment session (doctor to be assigned)',
            startDate: a.scheduled_date,
            startTime: a.scheduled_time,
            endTime: require('../utils/helpers').addMinutesToTime(a.scheduled_time, 20)
          });
          if (result.success && result.meetLink) {
            meetLink = result.meetLink;
          }
        } catch (e) {
          // ignore, leave meetLink null
        }
      }
      if (!meetLink) {
        meetLink = 'https://meet.google.com/new?hs=122&authuser=0';
      }
      assessments.push({
        id: a.id,
        assessmentNumber: a.assessment_number,
        scheduledDate: a.scheduled_date,
        scheduledTime: a.scheduled_time,
        status: a.status,
        session_id: a.session_id || null,
        client: a.client || null,
        psychologist: a.psychologist || null,
        meetLink,
        feedback: a.session?.feedback || null,
        rating: a.session?.rating || null
      });
    }

    return res.json(successResponse({ assessments }));
  } catch (error) {
    console.error('Admin list free assessments exception:', error);
    return res.status(500).json(errorResponse('Internal server error'));
  }
};

// Admin: Delete free assessment
const deleteFreeAssessment = async (req, res) => {
  try {
    const { assessmentId } = req.params;

    console.log('🗑️ Admin deleting free assessment:', assessmentId);

    // Defensive runtime check: ensure user is admin
    if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'superadmin')) {
      return res.status(403).json(
        errorResponse('Access denied. Admin role required.')
      );
    }

    // Get the assessment (include client_id for decrementing free_assessment_count)
    const { data: assessment, error: assessmentError } = await supabaseAdmin
      .from('free_assessments')
      .select('id, session_id, status, client_id')
      .eq('id', assessmentId)
      .single();

    if (assessmentError || !assessment) {
      return res.status(404).json(
        errorResponse('Free assessment not found')
      );
    }

    const clientId = assessment.client_id;
    const sessionId = assessment.session_id;

    // Delete the free assessment first (before session to prevent orphaned assessment)
    const { error: deleteError } = await supabaseAdmin
      .from('free_assessments')
      .delete()
      .eq('id', assessmentId);

    if (deleteError) {
      console.error('Error deleting free assessment:', deleteError);
      return res.status(500).json(
        errorResponse('Failed to delete free assessment')
      );
    }

    // Delete the associated session if it exists (after assessment deletion)
    if (sessionId) {
      try {
        const { error: sessionDeleteError } = await supabaseAdmin
          .from('sessions')
          .delete()
          .eq('id', sessionId);

        if (sessionDeleteError) {
          console.error('⚠️ Error deleting associated session after assessment deletion:', sessionDeleteError);
          // Assessment already deleted, but session deletion failed
          // Log error but don't fail the request since assessment deletion succeeded
          // In production, consider implementing a compensating restore or background cleanup
        } else {
          console.log('✅ Deleted associated session:', sessionId);
        }
      } catch (sessionError) {
        console.error('⚠️ Exception deleting associated session:', sessionError);
        // Assessment already deleted, but session deletion failed
        // Log error but don't fail the request since assessment deletion succeeded
      }
    }

    // Only decrement client's free_assessment_count after successful deletion
    if (clientId) {
      const { data: clientRow } = await supabaseAdmin
        .from('clients')
        .select('free_assessment_count')
        .eq('id', clientId)
        .single();
      if (clientRow) {
        const newCount = Math.max(0, (clientRow.free_assessment_count ?? 0) - 1);
        const { error: updateErr } = await supabaseAdmin
          .from('clients')
          .update({ free_assessment_count: newCount })
          .eq('id', clientId);
        if (updateErr) {
          console.warn('⚠️ Failed to decrement free_assessment_count:', updateErr);
        }
      }
    }

    console.log('✅ Free assessment deleted successfully:', assessmentId);
    return res.json(
      successResponse(null, 'Free assessment deleted successfully')
    );
  } catch (error) {
    console.error('Delete free assessment error:', error);
    return res.status(500).json(
      errorResponse('Internal server error while deleting free assessment')
    );
  }
};

// Test endpoint to check date-specific configurations

module.exports = {
  getFreeAssessmentStatus,
  getAvailableTimeSlots,
  getFreeAssessmentAvailabilityRange,
  bookFreeAssessment,
  cancelFreeAssessment,
  adminListFreeAssessments,
  deleteFreeAssessment
};
