const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { 
  createRateLimiters, 
  requestSizeLimiter, 
  memoryMonitor, 
  requestValidator 
} = require('./middleware/security');
const securityMonitor = require('./utils/securityMonitor');
// Load .env from backend directory so it works regardless of where you run the server from
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const authRoutes = require('./routes/auth');
const clientRoutes = require('./routes/clients');
const psychologistRoutes = require('./routes/psychologists');
const sessionRoutes = require('./routes/sessions');
const adminRoutes = require('./routes/admin');
const superadminRoutes = require('./routes/superadmin');
const availabilityRoutes = require('./routes/availability');
const availabilityControllerRoutes = require('./routes/availabilityControllerRoutes');
const oauthRoutes = require('./routes/oauth');
const meetRoutes = require('./routes/meet');
const notificationRoutes = require('./routes/notifications');
const clientNotificationRoutes = require('./routes/clientNotifications');
const messageRoutes = require('./routes/messages');
const paymentRoutes = require('./routes/payment');
const freeAssessmentRoutes = require('./routes/freeAssessments');
const freeAssessmentTimeslotRoutes = require('./routes/freeAssessmentTimeslots');
const emailVerificationRoutes = require('./routes/emailVerification');
const calendarSyncService = require('./services/calendarSyncService');
const sessionReminderService = require('./services/sessionReminderService');
const dailyAvailabilityService = require('./services/dailyAvailabilityService');
const dailyFreeAssessmentService = require('./services/dailyFreeAssessmentService');
const dailyCalendarConflictAlert = require('./services/dailyCalendarConflictAlert');
const googleCalendarRoutes = require('./routes/googleCalendar');
const blogRoutes = require('./routes/blogs');
const counsellingRoutes = require('./routes/counselling');
const assessmentsRoutes = require('./routes/assessments');
const careerRoutes = require('./routes/careers');
// Security routes removed - security page removed from admin dashboard
// const securityRoutes = require('./routes/security');
const betterParentingRoutes = require('./routes/betterParenting');
const financeRoutes = require('./routes/finance');

const app = express();
const PORT = process.env.PORT || 5001;

// Trust exactly one reverse proxy (e.g. Cloudflare, Nginx). Using a number instead of
// true avoids express-rate-limit ERR_ERL_PERMISSIVE_TRUST_PROXY (trust proxy true
// would allow clients to spoof X-Forwarded-For and bypass IP-based rate limiting).
app.set('trust proxy', 1);

// Initialize advanced security middleware
const {
  generalLimiter,
  authLimiter,
  uploadLimiter,
  passwordResetLimiter,
  emailVerificationLimiter
} = createRateLimiters();

// MEDIUM-RISK FIX: Request ID correlation middleware (must be early in chain)
const requestIdMiddleware = require('./middleware/requestId');
app.use(requestIdMiddleware);

// CORS: Handle preflight OPTIONS first so response always has Access-Control-* headers
// (Other middleware may return errors without CORS headers, causing "No 'Access-Control-Allow-Origin'" in browser)
// Use same ALLOWED_ORIGINS as CSRF middleware: set in production (e.g. Render) as comma-separated list
const DEFAULT_ORIGINS = [
  'https://kutikkal-one.vercel.app',
  'https://www.little.care',
  'https://little.care',
  'http://localhost:3000',
  'http://localhost:3001'
];
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
  : DEFAULT_ORIGINS;
const ALLOWED_HEADERS = [
  'Content-Type', 'Authorization', 'X-Requested-With', 'Origin', 'Accept',
  'x-posthog-distinct-id', 'x-posthog-session-id', 'x-posthog-token', 'x-posthog-window-id',
  'X-PostHog-Distinct-Id', 'X-PostHog-Session-Id', 'X-PostHog-Token', 'X-PostHog-Window-Id'
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS.join(', '));
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

// Security middleware stack
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'"], // Removed 'unsafe-inline' for better XSS protection
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// Trust Cloudflare proxy - Express will automatically use CF-Connecting-IP
// With 'trust proxy' set, req.ip will automatically use the correct IP
// No need to manually parse headers - Express handles it correctly

// Keep-alive headers for better connection reuse (especially for international users)
// Cloudflare-compatible: Cloudflare manages connections but these headers help with origin connections
app.use((req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=5, max=1000');
  
  // Cloudflare-specific headers for better caching and performance
  // CF-Cache-Status will be set by Cloudflare automatically
  // Add cache-control hints for Cloudflare
  const url = req.url || req.path || '';
  
  // Public endpoints that can be cached by Cloudflare
  if (url.includes('/api/public/') || url.includes('/health')) {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  }
  
  next();
});

// Health check endpoints (before other middleware for fast response)
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: Date.now(),
    region: process.env.REGION || 'unknown',
    uptime: process.uptime()
  });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    timestamp: Date.now(),
    service: 'api'
  });
});

// Note: IP filtering and bot detection handled by Cloudflare at the edge
// App-level filtering removed to avoid false positives and duplicate logic

// Request validation and size limiting
app.use(requestValidator);
app.use(requestSizeLimiter);

// Memory monitoring
app.use(memoryMonitor);

// Progressive slow down removed (was causing IPv6 issues)

// General rate limiting
app.use(generalLimiter);

// Compression middleware (reduces egress by 60-80% and transfer time)
// Note: Requires 'npm install compression' - install if not already installed
let compression;
try {
  compression = require('compression');
  app.use(compression({ level: 6, threshold: 1024 })); // Compress responses > 1KB
  console.log('✅ Response compression enabled (reduces egress by 60-80%)');
} catch (err) {
  console.warn('⚠️ Compression module not found. Install with: npm install compression');
  console.warn('   This reduces egress by 60-80% - highly recommended!');
}

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files for uploads
app.use('/uploads', express.static('uploads'));

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    message: 'Little Care Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Security status endpoint removed - security page removed from admin dashboard


// OAuth callback handler for Google Meet integration
app.get('/api/oauth2/callback', async (req, res) => {
  try {
    console.log('🔄 OAuth callback received');
    console.log('Query params:', req.query);
    
    const { code, error } = req.query;
    
    if (error) {
      console.log('❌ OAuth error:', error);
      return res.status(400).json({
        success: false,
        error: 'OAuth authorization failed',
        details: error
      });
    }
    
    if (!code) {
      console.log('❌ No authorization code received');
      return res.status(400).json({
        success: false,
        error: 'No authorization code received'
      });
    }
    
    console.log('✅ Authorization code received:', code);
    
    // Exchange code for tokens
    const { google } = require('googleapis');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      'http://localhost:5001/api/oauth2/callback' // Use local redirect URI
    );
    
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    
    console.log('✅ OAuth tokens obtained successfully');
    console.log('Access token:', tokens.access_token ? 'Present' : 'Missing');
    console.log('Refresh token:', tokens.refresh_token ? 'Present' : 'Missing');
    
    // Store OAuth tokens for future use
    const meetLinkService = require('./utils/meetLinkService');
    await meetLinkService.storeOAuthTokens(tokens);
    
    // Test creating a Meet link with the OAuth token
    
    const testSessionData = {
      summary: 'Test OAuth Meet Link',
      description: 'Testing real Meet link creation with OAuth token',
      startDate: '2024-09-07',
      startTime: '20:00:00',
      endTime: '21:00:00'
    };
    
    console.log('🔄 Testing Meet link creation with OAuth token...');
    const result = await meetLinkService.createMeetLinkWithOAuth(tokens.access_token, testSessionData);
    
    res.json({
      success: true,
      message: 'OAuth authorization successful!',
      tokens: {
        access_token: tokens.access_token ? 'Present' : 'Missing',
        refresh_token: tokens.refresh_token ? 'Present' : 'Missing',
        expires_in: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'Unknown'
      },
      meetLinkTest: result,
      instructions: [
        '✅ OAuth authorization completed successfully',
        '✅ Access token obtained for Google Meet API',
        '✅ Meet link creation tested',
        '🎉 Real Google Meet links can now be created!'
      ]
    });
    
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    res.status(500).json({
      success: false,
      error: 'OAuth callback failed',
      details: error.message
    });
  }
});






// Public endpoint to get all psychologists (no authentication required)
const formatPublicPsychologist = (psych) => {
  if (!psych) return null;

  let extractedPrice = psych.individual_session_price;
  if (!extractedPrice) {
    const priceMatch = psych.description?.match(/Individual Session Price: [₹\$](\d+(?:\.\d+)?)/);
    extractedPrice = priceMatch ? parseInt(priceMatch[1]) : null;
  }

  // OPTIMIZED: Removed languages_json processing (not displayed on frontend)
  // Default languages for all psychologists (if needed in future)
  const defaultLanguages = ['English', 'Malayalam'];
  const mergedLanguagesJson = JSON.stringify(defaultLanguages);

  return {
    id: psych.id,
    name: `${psych.first_name} ${psych.last_name}`.trim(),
    first_name: psych.first_name,
    last_name: psych.last_name,
    email: psych.email,
    area_of_expertise: psych.area_of_expertise || [],
    personality_traits: psych.personality_traits || [],
    experience_years: psych.experience_years || 0,
    designation: psych.designation || '',
    languages_json: mergedLanguagesJson, // Keep for backward compatibility, but uses defaults only
    description: psych.description || 'Professional psychologist dedicated to helping clients achieve mental wellness.',
    profile_picture_url: null,
    cover_image_url: psych.cover_image_url,
    price: extractedPrice
    // OPTIMIZED: Removed unused fields (phone, ug_college, pg_college, phd_college, faq fields)
  };
};

// Lightweight card shape for public psychologist lists (reduced JSON payload)
const formatPublicPsychologistCard = (psych) => {
  const full = formatPublicPsychologist(psych);
  if (!full) return null;

  const fullDesc = full.description || '';
  const short =
    fullDesc.length > 160 ? `${fullDesc.slice(0, 157)}...` : fullDesc;

  return {
    id: full.id,
    name: full.name,
    first_name: full.first_name,
    last_name: full.last_name,
    designation: full.designation,
    experience_years: full.experience_years,
    cover_image_url: full.cover_image_url,
    price: full.price,
    short_description: short,
    description: full.description || fullDesc,
    personality_traits: full.personality_traits || [],
    area_of_expertise: full.area_of_expertise || [],
  };
};

// ... existing /api/public/psychologists route (use helper)
app.get('/api/public/psychologists', async (req, res) => {
  try {
    const { supabaseAdmin } = require('./config/supabase');

    // Filter out assessment psychologist
    const assessmentEmail = (process.env.FREE_ASSESSMENT_PSYCHOLOGIST_EMAIL || 'assessment.koott@gmail.com').toLowerCase();
    
    // Use supabaseAdmin to bypass RLS (public endpoint, backend handles auth logic)
    // Only show active psychologists on client-facing pages
    // OPTIMIZED: Removed unused fields (ug_college, pg_college, phd_college, phone, languages_json, faq fields)
    // Description kept for modal view, but could be lazy-loaded in future optimization
    const { data: psychologists, error: psychologistsError } = await supabaseAdmin
      .from('psychologists')
      .select(`
        id,
        email,
        first_name,
        last_name,
        area_of_expertise,
        personality_traits,
        description,
        experience_years,
        cover_image_url,
        individual_session_price,
        display_order,
        created_at,
        designation
      `)
      .neq('email', assessmentEmail)
      .eq('active', true) // Only show active psychologists on client-facing pages
      .order('created_at', { ascending: false });

    if (psychologistsError) {
      console.error('Error fetching psychologists:', psychologistsError);
      throw new Error('Failed to fetch psychologists');
    }

    if (psychologists && psychologists.length > 0) {
      console.log('📊 Display orders before sorting:', psychologists.map(p => ({
        name: `${p.first_name} ${p.last_name}`,
        display_order: p.display_order,
        created_at: p.created_at
      })));
      
      psychologists.sort((a, b) => {
        const aOrder = a.display_order !== null && a.display_order !== undefined ? a.display_order : null;
        const bOrder = b.display_order !== null && b.display_order !== undefined ? b.display_order : null;
        
        if (aOrder !== null && bOrder === null) return -1;
        if (aOrder === null && bOrder !== null) return 1;
        
        if (aOrder !== null && bOrder !== null) {
          if (aOrder !== bOrder) {
            return aOrder - bOrder;
          }
          const dateA = new Date(a.created_at);
          const dateB = new Date(b.created_at);
          return dateB - dateA;
        }
        const dateA = new Date(a.created_at);
        const dateB = new Date(b.created_at);
        return dateB - dateA;
      });
      
      console.log('📊 Display orders after sorting:', psychologists.map(p => ({
        name: `${p.first_name} ${p.last_name}`,
        display_order: p.display_order,
        created_at: p.created_at
      })));
    }

    console.log('Successfully fetched psychologists:', psychologists?.length || 0);

    const formattedPsychologists = psychologists
      .map(formatPublicPsychologistCard)
      .filter(Boolean);

    // Set cache headers for egress reduction (5 minutes browser cache, 1 hour CDN)
    res.set({
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'ETag': `"psychologists-${Date.now()}"`
    });

    res.json({
      success: true,
      data: {
        psychologists: formattedPsychologists,
        cache_version: Date.now() // Include cache version for frontend cache invalidation
      }
    });
  } catch (error) {
    console.error('Error fetching psychologists:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch psychologists',
      message: error.message
    });
  }
});

// Public endpoint to get cache version (for cache invalidation)
app.get('/api/public/psychologists/cache-version', async (req, res) => {
  try {
    // Get the most recent update timestamp from psychologists table
    // Use supabaseAdmin to bypass RLS (public endpoint, backend handles auth logic)
    const { supabaseAdmin } = require('./config/supabase');
    const { data: latestPsychologist, error } = await supabaseAdmin
      .from('psychologists')
      .select('updated_at')
      .order('updated_at', { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
      console.error('Error fetching cache version:', error);
    }

    const cacheVersion = latestPsychologist?.updated_at 
      ? new Date(latestPsychologist.updated_at).getTime()
      : Date.now();

    // Set cache headers (1 minute browser cache, 5 minutes CDN)
    res.set({
      'Cache-Control': 'public, max-age=60, s-maxage=300',
      'ETag': `"cache-version-${cacheVersion}"`
    });

    res.json({
      success: true,
      data: {
        cache_version: cacheVersion,
        timestamp: Date.now()
      }
    });
  } catch (error) {
    console.error('Error getting cache version:', error);
    res.json({
      success: true,
      data: {
        cache_version: Date.now(),
        timestamp: Date.now()
      }
    });
  }
});

app.get('/api/public/psychologists/:psychologistId/details', async (req, res) => {
  try {
    const { supabaseAdmin } = require('./config/supabase');
    const { psychologistId } = req.params;

    // Use supabaseAdmin to bypass RLS (public endpoint, backend handles auth logic)
    const { data: psychologist, error } = await supabaseAdmin
      .from('psychologists')
      .select(`
        *,
        individual_session_price
      `)
      .eq('id', psychologistId)
      .single();

    if (error || !psychologist) {
      console.error('Error fetching psychologist details:', error);
      return res.status(404).json({
        success: false,
        error: 'Psychologist not found'
      });
    }

    const formattedPsychologist = formatPublicPsychologist(psychologist);
    // Include FAQ + education (studies) + area_of_expertise for profile page (list omits these for payload size)
    Object.assign(formattedPsychologist, {
      faq_question_1: psychologist.faq_question_1 ?? null,
      faq_answer_1: psychologist.faq_answer_1 ?? null,
      faq_question_2: psychologist.faq_question_2 ?? null,
      faq_answer_2: psychologist.faq_answer_2 ?? null,
      faq_question_3: psychologist.faq_question_3 ?? null,
      faq_answer_3: psychologist.faq_answer_3 ?? null,
      ug_college: psychologist.ug_college ?? null,
      pg_college: psychologist.pg_college ?? null,
      mphil_college: psychologist.mphil_college ?? null,
      phd_college: psychologist.phd_college ?? null,
      area_of_expertise: psychologist.area_of_expertise ?? formattedPsychologist.area_of_expertise ?? []
    });

    res.json({
      success: true,
      data: {
        psychologist: formattedPsychologist
      }
    });
  } catch (error) {
    console.error('Error fetching psychologist details:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch psychologist details',
      message: error.message
    });
  }
});

// Public psychologist packages endpoint
app.get('/api/public/psychologists/:psychologistId/packages', async (req, res) => {
  try {
    const { supabaseAdmin } = require('./config/supabase');
    const { psychologistId } = req.params;
    console.log(`📦 Getting packages for psychologist ${psychologistId}`);

    // Get packages for this psychologist
    // Use supabaseAdmin to bypass RLS (public endpoint, backend handles auth logic)
    const { data: packages, error: packagesError } = await supabaseAdmin
      .from('packages')
      .select('*')
      .eq('psychologist_id', psychologistId)
      .order('session_count', { ascending: true });

    if (packagesError) {
      console.error('Error fetching packages:', packagesError);
      return res.status(500).json({
        success: false,
        error: 'Failed to fetch packages',
        message: packagesError.message
      });
    }

    console.log(`✅ Found ${packages?.length || 0} packages for psychologist ${psychologistId}`);
    res.json({
      success: true,
      data: { packages: packages || [] }
    });

  } catch (error) {
    console.error('Error getting psychologist packages:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while fetching packages',
      message: error.message
    });
  }
});

// Debug endpoints - ONLY available in development mode
// SECURITY: These endpoints are disabled in production to prevent unauthorized access
if (process.env.NODE_ENV === 'development' && process.env.ENABLE_DEBUG_ROUTES === 'true') {
  // TEMPORARY: Check database contents (for debugging)
  app.get('/api/debug/users', async (req, res) => {
    try {
      const { supabaseAdmin } = require('./config/supabase');
      
      // Check users table
      const { data: users, error: usersError } = await supabaseAdmin
        .from('users')
        .select('*');
      
      // Check clients table
      const { data: clients, error: clientsError } = await supabaseAdmin
        .from('clients')
        .select('*');
      
      // Check psychologists table
      const { data: psychologists, error: psychologistsError } = await supabaseAdmin
        .from('psychologists')
        .select('*');

      res.json({
        success: true,
        data: {
          users: users || [],
          clients: clients || [],
          psychologists: psychologists || [],
          errors: {
            users: usersError?.message,
            clients: clientsError?.message,
            psychologists: psychologistsError?.message
          }
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  });


  // TEMPORARY: Clear test data (for debugging)
  app.delete('/api/debug/clear-test-data', async (req, res) => {
  try {
    const { supabaseAdmin } = require('./config/supabase');
    
    // Clear test data from all tables
    const { error: usersError } = await supabaseAdmin
      .from('users')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Keep system IDs
    
    const { error: clientsError } = await supabaseAdmin
      .from('clients')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    
    const { error: psychologistsError } = await supabaseAdmin
      .from('psychologists')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');

    res.json({
      success: true,
      message: 'Test data cleared successfully',
      errors: {
        users: usersError?.message,
        clients: clientsError?.message,
        psychologists: psychologistsError?.message
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
  });

  // TEMPORARY: Seed availability for testing
  app.post('/api/debug/seed-availability', async (req, res) => {
  try {
    const { supabaseAdmin } = require('./config/supabase');
    const { psychologist_id, date, time_slots } = req.body;

    if (!psychologist_id || !date || !Array.isArray(time_slots)) {
      return res.status(400).json({
        success: false,
        error: 'psychologist_id, date (YYYY-MM-DD), and time_slots (array like ["10:00 AM"]) are required'
      });
    }

    // Upsert availability
    const { data: existing } = await supabaseAdmin
      .from('availability')
      .select('*')
      .eq('psychologist_id', psychologist_id)
      .eq('date', date)
      .single();

    if (existing) {
      const { data, error } = await supabaseAdmin
        .from('availability')
        .update({ time_slots, is_available: true })
        .eq('id', existing.id)
        .select()
        .single();
      
      if (error) throw error;
      res.json({ success: true, data, message: 'Availability updated' });
    } else {
      const { data, error } = await supabaseAdmin
        .from('availability')
        .insert({ psychologist_id, date, time_slots, is_available: true })
        .select()
        .single();
      
      if (error) throw error;
      res.json({ success: true, data, message: 'Availability created' });
    }
  } catch (error) {
    console.error('Error seeding availability:', error);
    res.status(500).json({ success: false, error: error.message });
  }
  });

  // TEMPORARY: Check sessions for a specific date and psychologist
  app.get('/api/debug/sessions/:psychologist_id/:date', async (req, res) => {
  try {
    const { supabaseAdmin } = require('./config/supabase');
    const { psychologist_id, date } = req.params;

    const { data: sessions, error } = await supabaseAdmin
      .from('sessions')
      .select('*')
      .eq('psychologist_id', psychologist_id)
      .eq('scheduled_date', date);

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    res.json({
      success: true,
      data: {
        date,
        psychologist_id,
        sessions: sessions || []
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
  });

  // TEMPORARY: Debug client sessions
  app.get('/api/debug/client-sessions/:clientId', async (req, res) => {
  try {
    const { supabaseAdmin } = require('./config/supabase');
    const { clientId } = req.params;

    console.log('🔍 Debug - Checking sessions for client:', clientId);

    // Get all sessions for this client
    const { data: sessions, error } = await supabaseAdmin
      .from('sessions')
      .select(`
        id,
        scheduled_date,
        scheduled_time,
        status,
        payment_id,
        payment:payments!sessions_payment_id_fkey(
          id,
          transaction_id,
          amount,
          status,
          completed_at
        )
      `)
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({
        success: false,
        error: error.message
      });
    }

    console.log('🔍 Debug - Found sessions:', sessions);

    res.json({
      success: true,
      data: {
        clientId,
        sessionsCount: sessions?.length || 0,
        sessions: sessions
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
  });
} else {
  // In production, return 404 for debug endpoints
  app.use('/api/debug/*', (req, res) => {
    res.status(404).json({
      error: 'Not found',
      message: 'Debug endpoints are not available in production'
    });
  });
}

// Public endpoint to get psychologist availability (no authentication required)
// This is now handled by the availability routes with better Google Calendar integration

// API routes
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/psychologists', psychologistRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/user-sessions', sessionRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/superadmin', superadminRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/availability-controller', availabilityControllerRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/client-notifications', clientNotificationRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/free-assessments', freeAssessmentRoutes);
app.use('/api/free-assessment-timeslots', freeAssessmentTimeslotRoutes);
app.use('/api/email-verification', emailVerificationLimiter, emailVerificationRoutes);
app.use('/api', oauthRoutes);
app.use('/api/psychologists/google-calendar', googleCalendarRoutes);
app.use('/api/blogs', blogRoutes);
app.use('/api/counselling', counsellingRoutes);
app.use('/api/assessments', assessmentsRoutes);
app.use('/api/better-parenting', betterParentingRoutes);
app.use('/api/careers', careerRoutes);
app.use('/api/finance', financeRoutes);

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Route not found',
    message: `Cannot ${req.method} ${req.originalUrl}`
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  
  if (err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Validation Error',
      message: err.message
    });
  }
  
  if (err.name === 'UnauthorizedError') {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or expired token'
    });
  }
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Start server
app.listen(PORT, () => {
console.log(`🚀 Little Care Backend running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Environment: ${process.env.NODE_ENV}`);

  // Auth env check (development): ensure backend uses same Supabase project as frontend
  if (process.env.NODE_ENV === 'development') {
    const supabaseUrl = process.env.SUPABASE_URL || '';
    const supabaseAnon = process.env.SUPABASE_ANON_KEY || '';
    if (supabaseUrl && supabaseAnon) {
      console.log('🔑 Auth Supabase URL (must match frontend NEXT_PUBLIC_SUPABASE_URL):', supabaseUrl);
    } else {
      console.warn('⚠️  Auth: Set SUPABASE_URL and SUPABASE_ANON_KEY in backend/.env to match frontend NEXT_PUBLIC_* (same Supabase project).');
    }
    // One-time Supabase connectivity check (surfaces real network error if fetch fails)
    (async () => {
      try {
        const { supabaseAdmin } = require('./config/supabase');
        const { error } = await supabaseAdmin.from('psychologists').select('id').limit(1).maybeSingle();
        if (error) {
          console.warn('⚠️  Supabase reachable but query error:', error.message, error.code || '');
        } else {
          console.log('✅ Supabase connectivity OK');
        }
      } catch (err) {
        const cause = err.cause || err;
        const code = cause.code || cause.errno || '';
        const message = cause.message || err.message;
        console.error('❌ Supabase connectivity failed:', message);
        if (code) console.error('   Error code:', code, '(ECONNREFUSED=connection refused, ETIMEDOUT=timeout, ENOTFOUND=DNS/URL not found)');
        if (cause.message && cause.message !== err.message) console.error('   Cause:', cause.message);
      }
    })();
  }

  // Start Google Calendar sync service
  calendarSyncService.start();
  
  // Start Session Reminder service (2-hour WhatsApp reminders)
  sessionReminderService.start();
  
  // Start Daily Availability service (adds next day at 12 AM)
  dailyAvailabilityService.start();
  
  // Start Daily Free Assessment Availability service (adds next day at 12 AM)
  dailyFreeAssessmentService.start();
  
  // Start Daily Calendar Conflict Monitor service (checks for conflicts at 1 AM)
  dailyCalendarConflictAlert.start();
  
  // Start Recovery Job (recovers failed session creations, runs every 5 minutes)
  const { startRecoveryScheduler } = require('./jobs/recoveryJob');
  startRecoveryScheduler(5); // Run every 5 minutes
  
  // Start Security Logs Cleanup Job (deletes logs older than 1 week, runs weekly)
  const { startSecurityLogsCleanupScheduler } = require('./jobs/securityLogsCleanupJob');
  startSecurityLogsCleanupScheduler(7); // Run every 7 days (weekly)
  
  // Start Audit Logs Cleanup Job (deletes logs older than 1 week, runs weekly)
  const { startAuditLogsCleanupScheduler } = require('./jobs/auditLogsCleanupJob');
  startAuditLogsCleanupScheduler(7); // Run every 7 days (weekly)
  
  // Start Slot Lock Cleanup Job (releases expired slots and cleans up abandoned payments, runs every 10 minutes)
  const { releaseExpiredSlots, cleanupAbandonedPendingPayments } = require('./services/slotLockService');
  setInterval(async () => {
    try {
      await releaseExpiredSlots();
      await cleanupAbandonedPendingPayments();
    } catch (error) {
      console.error('❌ Error in slot lock cleanup:', error);
    }
  }, 10 * 60 * 1000); // Every 10 minutes
  // Run immediately on startup
  releaseExpiredSlots().catch(err => {
    console.error('❌ Error in initial slot lock cleanup:', err);
  });
  cleanupAbandonedPendingPayments().catch(err => {
    console.error('❌ Error in initial abandoned payments cleanup:', err);
  });
});

module.exports = app;
