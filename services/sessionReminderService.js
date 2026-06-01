const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const interaktService = require('../utils/interaktService');
const { getClientDisplayName } = require('../utils/sessionTitleFormatter');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

dayjs.extend(utc);
dayjs.extend(timezone);

class SessionReminderService {
  constructor() {
    this.isRunning = false;
  }

  /**
   * Start the session reminder service
   * Runs every hour to check for sessions and free assessments in the next 1 hour (0-1 hour from now)
   */
  start() {
    console.log('🔔 Starting Session Reminder Service...');
    
    // Run every hour at minute 0 (e.g., 1:00, 2:00, 3:00, etc.)
    cron.schedule('0 * * * *', async () => {
      if (this.isRunning) {
        console.log('⏭️  Session reminder check already running, skipping...');
        return;
      }
      
      await this.checkAndSendReminders();
    });

    console.log('✅ Session Reminder Service scheduled (runs every hour)');
  }

  /**
   * Check for sessions and free assessments in the next 1 hour (0-1 hour from now)
   * and send WhatsApp reminders to both clients and psychologists
   * Runs every hour to catch all sessions in the upcoming 1-hour window
   */
  async checkAndSendReminders() {
    this.isRunning = true;
    console.log('🔍 Checking for sessions and free assessments requiring reminders...');

    try {
      // Get current time and calculate 2 hours from now (per spec)
      const now = dayjs().tz('Asia/Kolkata');
      const endTime = now.add(2, 'hour');
      
      console.log(`📅 Current time: ${now.format('YYYY-MM-DD HH:mm:ss')}`);
      console.log(`📅 Checking for sessions between: ${now.format('YYYY-MM-DD HH:mm:ss')} and ${endTime.format('YYYY-MM-DD HH:mm:ss')}`);

      // Get date range (today and tomorrow in case sessions span across dates)
      const startDate = now.format('YYYY-MM-DD');
      const endDate = endTime.format('YYYY-MM-DD');
      const datesToCheck = [];
      
      let currentDate = dayjs(now).tz('Asia/Kolkata').startOf('day');
      const finalDate = dayjs(endTime).tz('Asia/Kolkata').startOf('day');
      
      // Use isBefore or isSame instead of isSameOrBefore (which requires a plugin)
      while (currentDate.isBefore(finalDate, 'day') || currentDate.isSame(finalDate, 'day')) {
        datesToCheck.push(currentDate.format('YYYY-MM-DD'));
        currentDate = currentDate.add(1, 'day');
      }
      
      console.log(`📅 Checking dates: ${datesToCheck.join(', ')}`);
      
      // Get all sessions scheduled for the date range
      // Use supabaseAdmin to bypass RLS and avoid fetch errors
      // NOTE: Excluding free_assessment sessions only - they are handled via free_assessments table.
      // Use .or() so paid sessions with session_type IS NULL are included (SQL: NULL != 'x' excludes rows).
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(`
          id,
          client_id,
          psychologist_id,
          scheduled_date,
          scheduled_time,
          status,
          google_meet_link,
          reminder_sent,
          session_type,
          client:clients(
            id,
            first_name,
            last_name,
            child_name,
            phone_number,
            email
          ),
          psychologist:psychologists(
            id,
            first_name,
            last_name,
            phone,
            email
          )
        `)
        .in('scheduled_date', datesToCheck)
        .in('status', ['booked', 'rescheduled', 'confirmed', 'scheduled', 'reschedule_requested', 'upcoming'])
        .or('session_type.neq.free_assessment,session_type.is.null')
        .order('scheduled_date', { ascending: true })
        .order('scheduled_time', { ascending: true });

      if (sessionsError) {
        console.error('❌ Error fetching sessions:', {
          message: sessionsError.message,
          details: sessionsError.details || sessionsError.toString(),
          hint: sessionsError.hint || '',
          code: sessionsError.code || ''
        });
        this.isRunning = false;
        return;
      }

      console.log(`📋 Found ${sessions?.length || 0} sessions in date range`);

      // Log details of sessions found (for debugging)
      if (sessions && sessions.length > 0) {
        console.log('📋 Sessions found:');
        sessions.forEach((session, index) => {
          if (session.scheduled_time) {
            // Parse directly in IST timezone to avoid UTC conversion issues
            const sessionTime = dayjs.tz(`${session.scheduled_date} ${session.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
            const timeDiffMinutes = sessionTime.diff(now, 'minute');
            console.log(`   ${index + 1}. Session ${session.id}: ${session.scheduled_date} ${session.scheduled_time} (${timeDiffMinutes} minutes from now)`);
          } else {
            console.log(`   ${index + 1}. Session ${session.id}: ${session.scheduled_date} [NO TIME]`);
          }
        });
      }

      // Filter sessions that are in the next 1 hour (0 to 1 hour from now) and haven't received reminders yet
      const reminderSessions = (sessions || []).filter(session => {
        if (!session.scheduled_time) return false;
        
        // Skip if reminder already sent
        if (session.reminder_sent === true) {
          return false;
        }
        
        // Parse directly in IST timezone to avoid UTC conversion issues
        const sessionTime = dayjs.tz(`${session.scheduled_date} ${session.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
        const timeDiffMinutes = sessionTime.diff(now, 'minute'); // Difference in minutes
        
        // Check if session is between 0 and 120 minutes from now (next 2 hours)
        return timeDiffMinutes >= 0 && timeDiffMinutes <= 120;
      });

      console.log(`🔔 Found ${reminderSessions.length} sessions in the next 1 hour requiring reminders`);
      
      // Log details of sessions that will receive reminders
      if (reminderSessions.length > 0) {
        console.log('🔔 Sessions receiving reminders:');
        reminderSessions.forEach((session, index) => {
          // Parse directly in IST timezone to avoid UTC conversion issues
          const sessionTime = dayjs.tz(`${session.scheduled_date} ${session.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
          const timeDiffMinutes = sessionTime.diff(now, 'minute');
          const clientName = getClientDisplayName(session.client, 'Unknown');
          console.log(`   ${index + 1}. Session ${session.id} for ${clientName}: ${session.scheduled_date} ${session.scheduled_time} (${timeDiffMinutes} minutes from now)`);
        });
      }

      // Get free assessments in the next 1 hour
      const { data: freeAssessments, error: freeAssessmentsError } = await supabaseAdmin
        .from('free_assessments')
        .select(`
          id,
          client_id,
          psychologist_id,
          scheduled_date,
          scheduled_time,
          status,
          user_id,
          client:clients(
            id,
            first_name,
            last_name,
            child_name,
            phone_number,
            email,
            user_id
          ),
          psychologist:psychologists(
            id,
            first_name,
            last_name,
            phone,
            email
          )
        `)
        .in('scheduled_date', datesToCheck)
        .in('status', ['booked', 'rescheduled'])
        .order('scheduled_date', { ascending: true })
        .order('scheduled_time', { ascending: true });

      if (freeAssessmentsError) {
        console.error('❌ Error fetching free assessments:', {
          message: freeAssessmentsError.message,
          details: freeAssessmentsError.details || freeAssessmentsError.toString()
        });
      } else {
        console.log(`📋 Found ${freeAssessments?.length || 0} free assessments in date range`);
      }

      // Filter free assessments that are in the next 1 hour
      const reminderFreeAssessments = (freeAssessments || []).filter(assessment => {
        if (!assessment.scheduled_time) return false;
        
        // Parse directly in IST timezone to avoid UTC conversion issues
        const assessmentTime = dayjs.tz(`${assessment.scheduled_date} ${assessment.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
        const timeDiffMinutes = assessmentTime.diff(now, 'minute');
        
        // Check if assessment is between 0 and 120 minutes from now (next 2 hours)
        return timeDiffMinutes >= 0 && timeDiffMinutes <= 120;
      });

      console.log(`🔔 Found ${reminderFreeAssessments.length} free assessments in the next 1 hour requiring reminders`);

      // Process sessions in batches with parallel processing within each batch
      // This balances speed with API rate limiting
      const BATCH_SIZE = 5; // Process 5 sessions at a time
      const BATCH_DELAY = 1000; // 1 second delay between batches
      
      for (let i = 0; i < reminderSessions.length; i += BATCH_SIZE) {
        const batch = reminderSessions.slice(i, i + BATCH_SIZE);
        
        // Process batch in parallel (up to 5 sessions concurrently)
        await Promise.all(
          batch.map(session => this.sendReminderForSession(session))
        );
        
        // Add delay between batches (except for the last batch)
        if (i + BATCH_SIZE < reminderSessions.length) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
      }

      // Process free assessments
      for (let i = 0; i < reminderFreeAssessments.length; i += BATCH_SIZE) {
        const batch = reminderFreeAssessments.slice(i, i + BATCH_SIZE);
      
        // Process batch in parallel
        await Promise.all(
          batch.map(assessment => this.sendReminderForFreeAssessment(assessment))
        );
        
        // Add delay between batches
        if (i + BATCH_SIZE < reminderFreeAssessments.length) {
          await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
      }

      console.log('✅ Reminder check completed (sessions and free assessments)');
    } catch (error) {
      console.error('❌ Error in session reminder check:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Send WhatsApp reminder for a specific session
   */
  async sendReminderForSession(session) {
    try {
      // Free assessments get reminder only from free_assessments table (one reminder per session)
      if (session.session_type === 'free_assessment') {
        console.log(`⏭️  Session ${session.id} is free_assessment; reminder handled via free_assessments table, skipping...`);
        return;
      }

      // ATOMIC CHECK AND LOCK: Try to update reminder_sent from false to true
      // This acts as a distributed lock - only one process can successfully update
      // If update affects 0 rows, it means reminder_sent was already true (or another process got there first)
      const { data: updateData, error: lockError } = await supabaseAdmin
        .from('sessions')
        .update({ reminder_sent: true })
        .eq('id', session.id)
        .eq('reminder_sent', false) // Only update if it's currently false
        .select('id')
        .single();

      // If no rows were updated, it means reminder was already sent (or being processed by another instance)
      if (lockError || !updateData) {
        console.log(`⏭️  Reminder already sent or being processed for session ${session.id}, skipping...`);
        return;
      }

      console.log(`🔒 Lock acquired for session ${session.id}, proceeding with reminder...`);

      const client = session.client;
      const psychologist = session.psychologist;

      if (!client || !psychologist) {
        console.warn(`⚠️  Missing client or psychologist data for session ${session.id}`);
        return;
      }

      // Format session date and time
      // Parse directly in IST timezone to avoid UTC conversion issues
      const sessionDateTime = dayjs.tz(`${session.scheduled_date} ${session.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
      const formattedDate = sessionDateTime.format('DD MMM YYYY');
      const formattedTime = sessionDateTime.format('h:mm A');

      const clientName = getClientDisplayName(client, 'Client');
      const psychologistName = `${psychologist.first_name} ${psychologist.last_name}`.trim();

      // Send reminder to CLIENT ONLY via Interakt `sessionreminderautomatic` template.
      // Therapists do not receive automatic reminders (per product spec).
      const meetLink = session.google_meet_link || null;

      // Compute time-to-start label based on actual time until session
      const minsUntil = sessionDateTime.diff(dayjs().tz('Asia/Kolkata'), 'minute');
      let timeToStart;
      if (minsUntil <= 0) timeToStart = 'a few minutes';
      else if (minsUntil <= 35) timeToStart = '30 minutes';
      else if (minsUntil <= 75) timeToStart = '1 hour';
      else if (minsUntil <= 105) timeToStart = '1.5 hours';
      else timeToStart = '2 hours';

      if (client.phone_number) {
        try {
          const result = await interaktService.sendSessionReminder(client.phone_number, {
            recipientName: clientName,
            otherPartyName: psychologistName,
            meetLink,
            timeToStart,
          });
          if (result?.success) {
            console.log(`✅ sessionreminderautomatic sent to client for session ${session.id}`);
          } else {
            console.warn(`⚠️  Failed to send reminder to client for session ${session.id}:`, result?.error || result?.reason);
          }
        } catch (err) {
          console.error(`❌ Error sending reminder to client for session ${session.id}:`, err);
        }
      } else {
        console.log(`ℹ️  No phone number for client in session ${session.id}`);
      }

      // Note: reminder_sent was already set to true at the start of this function (atomic lock)
      // This ensures no duplicate reminders are sent even if multiple cron jobs run concurrently

      // Create in-app notification for the client only
      await supabaseAdmin
        .from('notifications')
        .insert([
          {
            user_id: client.id,
            user_role: 'client',
            type: 'session_reminder_2h',
            title: 'Session Reminder',
            message: `Your session with ${psychologistName} is scheduled`,
            related_id: session.id,
            is_read: false
          }
        ]);

      console.log(`✅ Reminder notification created for session ${session.id}`);
    } catch (error) {
      console.error(`❌ Error sending reminder for session ${session.id}:`, error);
    }
  }

  /**
   * Send WhatsApp reminder for a specific free assessment
   */
  async sendReminderForFreeAssessment(assessment) {
    try {
      // Already-sent check: only one reminder per free assessment (cron can run every hour; same assessment can fall in window twice)
      const { data: existingReminder } = await supabaseAdmin
        .from('notifications')
        .select('id')
        .eq('type', 'free_assessment_reminder_2h')
        .eq('related_id', assessment.id)
        .limit(1);

      if (existingReminder && existingReminder.length > 0) {
        console.log(`⏭️  Reminder already sent for free assessment ${assessment.id}, skipping...`);
        return;
      }

      // ATOMIC CHECK: Try to insert a "lock" notification first
      // This acts as a distributed lock - only one process can successfully insert
      // We'll insert a temporary lock notification, then send reminders, then update it
      const lockNotification = {
        user_id: assessment.user_id || assessment.client?.user_id || assessment.client?.id,
        user_role: 'client',
        type: 'free_assessment_reminder_2h',
        title: 'Free Assessment Reminder',
        message: 'Reminder lock', // Temporary message
        related_id: assessment.id,
        is_read: false
      };

      // Try to insert the lock notification
      // If it fails (duplicate), it means another process is already handling this
      const { data: insertedLock, error: lockError } = await supabaseAdmin
        .from('notifications')
        .insert([lockNotification])
        .select('id')
        .single();

      // If insert failed (likely due to unique constraint or duplicate), skip
      if (lockError || !insertedLock) {
        // Check if notification already exists (to confirm it's a duplicate, not another error)
        const { data: existingNotifications } = await supabaseAdmin
          .from('notifications')
          .select('id')
          .eq('related_id', assessment.id)
          .eq('type', 'free_assessment_reminder_2h')
          .limit(1);

        if (existingNotifications && existingNotifications.length > 0) {
          console.log(`⏭️  Reminder already sent for free assessment ${assessment.id}, skipping...`);
          return;
        } else {
          // If it's a different error, log it but still proceed (fail-safe)
          console.warn(`⚠️  Error creating lock notification for free assessment ${assessment.id}:`, lockError);
        }
      } else {
        console.log(`🔒 Lock acquired for free assessment ${assessment.id}, proceeding with reminder...`);
      }

      const client = assessment.client;
      const psychologist = assessment.psychologist;

      if (!client) {
        console.warn(`⚠️  Missing client data for free assessment ${assessment.id}`);
        return;
      }

      // Format assessment date and time
      // Parse directly in IST timezone to avoid UTC conversion issues
      const assessmentDateTime = dayjs.tz(`${assessment.scheduled_date} ${assessment.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
      const formattedDate = assessmentDateTime.format('DD MMM YYYY');
      const formattedTime = assessmentDateTime.format('h:mm A');

      const clientName = getClientDisplayName(client, 'Client');
      const psychologistName = psychologist ? `${psychologist.first_name} ${psychologist.last_name}`.trim() : 'our specialist';

      // Client reminder via Interakt template (free assessment uses the same reminder template)
      if (client.phone_number) {
        try {
          const meetLink = assessment.google_meet_link || null;
          const result = await interaktService.sendSessionReminder(client.phone_number, {
            recipientName: clientName,
            otherPartyName: psychologistName,
            meetLink,
            timeToStart: '30 minutes',
          });
          if (result?.success) {
            console.log(`✅ sessionreminderautomatic sent to client for free assessment ${assessment.id}`);
          } else {
            console.warn(`⚠️  Failed to send reminder to client for free assessment ${assessment.id}:`, result?.error || result?.reason);
          }
        } catch (err) {
          console.error(`❌ Error sending reminder to client for free assessment ${assessment.id}:`, err);
        }
      } else {
        console.log(`ℹ️  No phone number for client in free assessment ${assessment.id}`);
      }

      // Therapist reminder intentionally removed — per product spec, only the client gets the reminder.

      // Update the lock notification with proper messages, or create new ones if lock wasn't created
      const notificationsToInsert = [
        {
          user_id: assessment.user_id || client.user_id || client.id,
          user_role: 'client',
          type: 'free_assessment_reminder_2h',
          title: 'Free Assessment Reminder',
          message: `Your free assessment session is scheduled`,
          related_id: assessment.id,
          is_read: false
        }
      ];

      // Psychologist in-app notification intentionally removed — per spec, reminders are client-only.

      // Update the lock notification or insert new ones
      if (insertedLock) {
        // Update the lock notification with proper message
        await supabaseAdmin
          .from('notifications')
          .update({ message: notificationsToInsert[0].message })
          .eq('id', insertedLock.id);

        // No psychologist notification — reminders are client-only.
      } else {
        // If lock wasn't created, try to insert all notifications (may fail if duplicates exist)
        const { error: insertError } = await supabaseAdmin
          .from('notifications')
          .insert(notificationsToInsert);
        if (insertError) {
          // Ignore duplicate errors - it means another process already created them
          if (!insertError.message?.includes('duplicate') && !insertError.code?.includes('23505')) {
            console.error(`Error inserting notifications for free assessment ${assessment.id}:`, insertError);
          }
        }
      }

      console.log(`✅ Reminder notifications created for free assessment ${assessment.id}`);
    } catch (error) {
      console.error(`❌ Error sending reminder for free assessment ${assessment.id}:`, error);
    }
  }

  /**
   * Check for any new sessions that were created/rescheduled during the reminder processing
   * This catches edge cases where a booking/reschedule happened while reminders were being sent
   * Checks for sessions in the next 1 hour (0-1 hour from now)
   */
  async checkForNewSessionsDuringProcessing(originalCheckTime) {
    try {
      const now = dayjs().tz('Asia/Kolkata');
      const endTime = now.add(1, 'hour');
      const startDate = now.format('YYYY-MM-DD');
      const endDate = endTime.format('YYYY-MM-DD');
      const datesToCheck = [];
      
      let currentDate = dayjs(now).tz('Asia/Kolkata').startOf('day');
      const finalDate = dayjs(endTime).tz('Asia/Kolkata').startOf('day');
      
      // Use isBefore or isSame instead of isSameOrBefore (which requires a plugin)
      while (currentDate.isBefore(finalDate, 'day') || currentDate.isSame(finalDate, 'day')) {
        datesToCheck.push(currentDate.format('YYYY-MM-DD'));
        currentDate = currentDate.add(1, 'day');
      }
      
      // Query for sessions in the next 1 hour
      // Check for both newly created sessions AND recently rescheduled sessions
      const checkTimeMinus1Min = originalCheckTime.subtract(1, 'minute').toISOString();
      
      // Query for sessions created or updated in the last minute
      // We'll fetch and filter in JavaScript to avoid complex OR query syntax
      // Use supabaseAdmin to bypass RLS
      const { data: allTargetSessions, error: sessionsError } = await supabaseAdmin
        .from('sessions')
        .select(`
          id,
          client_id,
          psychologist_id,
          scheduled_date,
          scheduled_time,
          status,
          google_meet_link,
          created_at,
          updated_at,
          session_type,
          client:clients(
            id,
            first_name,
            last_name,
            child_name,
            phone_number,
            email
          ),
          psychologist:psychologists(
            id,
            first_name,
            last_name,
            phone,
            email
          )
        `)
        .in('scheduled_date', datesToCheck)
        .in('status', ['booked', 'rescheduled', 'confirmed', 'scheduled', 'reschedule_requested', 'upcoming'])
        .order('scheduled_date', { ascending: true })
        .order('scheduled_time', { ascending: true });

      if (sessionsError || !allTargetSessions) {
        return;
      }

      // Filter for sessions created or updated after the original check time
      const newSessions = allTargetSessions.filter(session => {
        const created = new Date(session.created_at);
        const updated = new Date(session.updated_at);
        const checkTime = new Date(checkTimeMinus1Min);
        return created >= checkTime || updated >= checkTime;
      });

      if (!newSessions || newSessions.length === 0) {
        return; // No new sessions found
      }

      // Filter for sessions that are in the next 1 hour (0-1 hour from now)
      const newReminderSessions = newSessions.filter(session => {
        if (!session.scheduled_time) return false;
        
        // Parse directly in IST timezone to avoid UTC conversion issues
        const sessionTime = dayjs.tz(`${session.scheduled_date} ${session.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
        const timeDiffMinutes = sessionTime.diff(now, 'minute');
        
        return timeDiffMinutes >= 0 && timeDiffMinutes <= 120;
      });

      if (newReminderSessions.length > 0) {
        console.log(`🔄 Found ${newReminderSessions.length} new session(s) created during reminder processing, sending reminders...`);
        
        // Process new sessions (smaller batch since these are edge cases)
        for (const session of newReminderSessions) {
          await this.sendReminderForSession(session);
        }
        
        console.log('✅ New session reminders sent');
      }
    } catch (error) {
      console.error('❌ Error checking for new sessions during processing:', error);
      // Don't throw - this is a catch-up check, shouldn't break the main flow
    }
  }

  /**
   * Check and send reminder immediately for a specific session (PRIORITY)
   * This is called when a new booking/reschedule happens to give it immediate priority
   * over the batch reminder processing
   * Checks if session is in the next 1 hour (0-1 hour from now)
   * @param {string} sessionId - Session ID to check
   */
  async checkAndSendReminderForSessionId(sessionId) {
    try {
      console.log(`🔔 [PRIORITY] Checking immediate reminder for session ${sessionId}...`);
      
      const now = dayjs().tz('Asia/Kolkata');
      
      // Fetch the specific session with all required data
      // Use supabaseAdmin to bypass RLS
      const { data: session, error: sessionError } = await supabaseAdmin
        .from('sessions')
        .select(`
          id,
          client_id,
          psychologist_id,
          scheduled_date,
          scheduled_time,
          status,
          google_meet_link,
          reminder_sent,
          session_type,
          client:clients(
            id,
            first_name,
            last_name,
            child_name,
            phone_number,
            email
          ),
          psychologist:psychologists(
            id,
            first_name,
            last_name,
            phone,
            email
          )
        `)
        .eq('id', sessionId)
        .in('status', ['booked', 'rescheduled', 'confirmed', 'scheduled', 'reschedule_requested', 'upcoming'])
        .single();

      if (sessionError || !session) {
        console.log(`ℹ️  [PRIORITY] Session ${sessionId} not found or not in valid status`);
        return;
      }

      // Free assessments get reminder only from free_assessments batch (one reminder per session)
      if (session.session_type === 'free_assessment') {
        console.log(`⏭️  [PRIORITY] Session ${sessionId} is free_assessment; reminder handled via free_assessments table, skipping...`);
        return;
      }

      // Check if reminder already sent
      if (session.reminder_sent === true) {
        console.log(`⏭️  [PRIORITY] Reminder already sent for session ${sessionId}, skipping...`);
        return;
      }

      // Check if session is in the next 1 hour
      if (!session.scheduled_time) {
        console.log(`ℹ️  [PRIORITY] Session ${sessionId} has no scheduled time`);
        return;
      }

      // Parse directly in IST timezone to avoid UTC conversion issues
      const sessionTime = dayjs.tz(`${session.scheduled_date} ${session.scheduled_time}`, 'YYYY-MM-DD HH:mm:ss', 'Asia/Kolkata');
      const timeDiffMinutes = sessionTime.diff(now, 'minute');

      // Check if session is between 0 and 60 minutes from now (next 1 hour)
      if (timeDiffMinutes >= 0 && timeDiffMinutes <= 120) {
        console.log(`✅ [PRIORITY] Session ${sessionId} is in next 1 hour, sending reminder immediately...`);
        await this.sendReminderForSession(session);
        console.log(`✅ [PRIORITY] Reminder sent immediately for session ${sessionId}`);
      } else {
        console.log(`ℹ️  [PRIORITY] Session ${sessionId} is ${timeDiffMinutes} minutes away (not in next 1 hour)`);
      }
    } catch (error) {
      console.error(`❌ [PRIORITY] Error checking reminder for session ${sessionId}:`, error);
      // Don't throw - this is a priority check, shouldn't break the booking flow
    }
  }

  /**
   * Manually trigger reminder check (for testing/admin use)
   */
  async triggerReminderCheck() {
    console.log('🔔 Manually triggering reminder check...');
    await this.checkAndSendReminders();
  }
}

// Export singleton instance
const sessionReminderService = new SessionReminderService();
module.exports = sessionReminderService;

