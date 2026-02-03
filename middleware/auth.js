const jwt = require('jsonwebtoken');
const supabase = require('../config/supabase');
const supabaseAdmin = require('../config/supabase').supabaseAdmin;
const tokenRevocationService = require('../utils/tokenRevocation');

// Verify JWT token (handles both backend JWT and Supabase JWT)
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    // Check if token is revoked
    if (token) {
      const isRevoked = await tokenRevocationService.isTokenRevoked(token);
      if (isRevoked) {
        return res.status(401).json({
          error: 'Access denied',
          message: 'Token has been revoked'
        });
      }
    }

    // Only log auth debug in development mode
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
      console.log('🔍 Auth Middleware Debug:', {
        method: req.method,
        url: req.url,
        hasAuthHeader: !!authHeader,
        tokenPreview: token ? token.substring(0, 20) + '...' : 'none',
        origin: req.headers.origin
      });
    }

    if (!token) {
      if (process.env.NODE_ENV === 'development') {
        console.log('🔍 No token provided');
      }
      return res.status(401).json({
        error: 'Access denied',
        message: 'No token provided'
      });
    }

    // Only log token details in development with debug flag
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
      console.log('JWT_SECRET exists:', !!process.env.JWT_SECRET);
      console.log('Token received:', token.substring(0, 20) + '...');
    }
    
    let decoded;
    let userId;
    
    try {
      // First try to verify as backend JWT token
      // Explicitly specify algorithm to prevent algorithm confusion attacks (e.g., 'none' algorithm)
      decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
      if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
        console.log('Decoded backend token:', decoded);
      }
      userId = decoded.userId || decoded.id;
    } catch (backendJwtError) {
      if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
        console.log('Not a backend JWT token, trying Supabase verification...');
      }
      
      try {
        // Try to verify as Supabase JWT token
        const { data: { user: supabaseUser }, error: supabaseError } = await supabase.auth.getUser(token);
        
        if (supabaseError || !supabaseUser) {
          if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
            console.error('Supabase token verification failed:', supabaseError);
          }
          // Log in production so Render logs show why (no token content)
          if (process.env.NODE_ENV === 'production') {
            console.warn('Auth: Supabase token verification failed. Ensure backend SUPABASE_URL and SUPABASE_ANON_KEY match the frontend Supabase project.', supabaseError?.message || 'No user');
          }
          return res.status(401).json({
            error: 'Invalid token',
            message: 'Token verification failed. If you signed in with Google, ensure this server\'s SUPABASE_URL and SUPABASE_ANON_KEY match your frontend Supabase project. Otherwise ensure JWT_SECRET is set correctly.'
          });
        }
        
        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('Supabase user verified:', supabaseUser);
        }
        
        // For Supabase users, we need to find them in our database
        // Check clients table first (since clients are stored directly in clients table)
        // Use supabaseAdmin to bypass RLS (authentication middleware needs database access)
        const { supabaseAdmin } = require('../config/supabase');
        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('🔍 Looking up client in database for email:', supabaseUser.email);
        }
        const { data: client, error: clientError } = await supabaseAdmin
          .from('clients')
          .select('*')
          .eq('email', supabaseUser.email)
          .single();

        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('🔍 Client lookup result:', { client, clientError });
        }

        if (client && !clientError) {
          if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
            console.log('🔍 Found existing client:', client.id);
          }
          req.user = {
            id: client.id,
            email: client.email,
            role: 'client',
            created_at: client.created_at,
            ...client
          };
          return next();
        }

        // If not found in clients table, check users table (for admins/superadmins)
        // Use supabaseAdmin to bypass RLS (authentication middleware needs database access)
        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('🔍 Looking up user in users table for email:', supabaseUser.email);
        }
        const { data: user, error: userError } = await supabaseAdmin
          .from('users')
          .select('*')
          .eq('email', supabaseUser.email)
          .single();

        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('🔍 User lookup result:', { user, userError });
        }

        if (user && !userError) {
          if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
            console.log('🔍 Found existing user:', user.id);
          }
          req.user = user;
          return next();
        }

        // If not found in users table, check psychologists table
        // Use supabaseAdmin to bypass RLS (authentication middleware needs database access)
        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('🔍 Looking up psychologist for email:', supabaseUser.email);
        }
        const { data: psychologist, error: psychologistError } = await supabaseAdmin
          .from('psychologists')
          .select('*')
          .eq('email', supabaseUser.email)
          .single();

        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('🔍 Psychologist lookup result:', { psychologist, psychologistError });
        }

        if (psychologist && !psychologistError) {
          if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
            console.log('🔍 Found existing psychologist:', psychologist.id);
          }
          req.user = {
            id: psychologist.id,
            email: psychologist.email,
            role: 'psychologist',
            created_at: psychologist.created_at,
            updated_at: psychologist.updated_at
          };
          return next();
        }

        // If user not found in either table, create them as a new client
        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.log('Creating new client from Supabase:', supabaseUser.email);
        }
        
        try {
          // Create client directly in clients table (following the same pattern as registration)
          // Use supabaseAdmin to bypass RLS (authentication middleware needs database access)
          const { data: newClient, error: clientCreateError } = await supabaseAdmin
            .from('clients')
            .insert({ 
              email: supabaseUser.email,
              google_id: supabaseUser.id,
              first_name: supabaseUser.user_metadata?.full_name?.split(' ')[0] || 'User', 
              last_name: supabaseUser.user_metadata?.full_name?.split(' ').slice(1).join(' ') || '', 
              phone_number: '+91', 
              child_name: 'Pending', 
              child_age: 1, 
              created_at: new Date().toISOString() 
            })
            .select()
            .single();
            
          if (clientCreateError) {
            console.error('Error creating client:', clientCreateError);
            return res.status(500).json({ 
              error: 'Client creation failed', 
              message: 'Failed to create client account' 
            });
          }

          // Set the user data for the request (following the same pattern as registration)
          req.user = {
            id: newClient.id,
            email: newClient.email,
            role: 'client',
            created_at: newClient.created_at,
            ...newClient
          };
          
          if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
            console.log('Successfully created new client:', req.user.email);
          }
          return next();
          
        } catch (createError) {
          console.error('Error during client creation:', createError);
          return res.status(500).json({ 
            error: 'Client creation failed', 
            message: 'Failed to create client account' 
          });
        }
        
      } catch (supabaseJwtError) {
        if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
          console.error('Supabase JWT verification failed:', supabaseJwtError);
        }
        if (process.env.NODE_ENV === 'production') {
          console.warn('Auth: Supabase JWT verification threw.', supabaseJwtError?.message || supabaseJwtError);
        }
        return res.status(401).json({
          error: 'Invalid token',
          message: 'Token verification failed. If you signed in with Google, ensure this server\'s SUPABASE_URL and SUPABASE_ANON_KEY match your frontend Supabase project.'
        });
      }
    }
    
    // Handle backend JWT token (original logic)
    if (!userId) {
      console.error('Token missing userId:', decoded);
      return res.status(401).json({ 
        error: 'Invalid token structure', 
        message: 'Token missing user ID' 
      });
    }

    // Check if user's tokens are revoked (e.g., account deactivated)
    const isUserRevoked = await tokenRevocationService.isUserRevoked(userId);
    if (isUserRevoked) {
      return res.status(401).json({
        error: 'Access denied',
        message: 'Account access has been revoked'
      });
    }
    
    // Use supabaseAdmin to bypass RLS for authentication lookups
    // Check if it's a psychologist first (since login checks psychologists table first)
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .eq('id', userId)
      .single();

    if (psychologist && !psychologistError) {
      // Psychologist exists in psychologists table (standalone)
      req.user = {
        id: psychologist.id,
        email: psychologist.email,
        role: 'psychologist',
        created_at: psychologist.created_at,
        updated_at: psychologist.updated_at
      };
      return next();
    }

    // If not a psychologist, check users table for clients/admins
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
      console.log('🔍 Looking up user in users table with userId:', userId);
    }
    const { data: user, error: userError } = await supabaseAdmin
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
      console.log('🔍 User lookup result:', { 
        found: !!user, 
        error: userError?.message || null,
        userId: userId 
      });
    }

    if (userError || !user) {
      console.error('❌ User not found in either table:', { 
        userId, 
        userError: userError?.message || 'No error but no user found',
        psychologistError: psychologistError?.message || null 
      });
      
      // Try to verify the user actually exists by checking if we can find them by email
      // This is just for debugging
      console.log('🔍 Debugging: Checking if user exists with any role...');
      
      return res.status(401).json({ 
        error: 'Access denied', 
        message: 'Invalid token - user not found' 
      });
    }
    
    if (process.env.NODE_ENV === 'development' && process.env.DEBUG_AUTH === 'true') {
      console.log('✅ User found:', {
        id: user.id,
        email: user.email,
        role: user.role
      });
    }

    // If user is a client, fetch the client profile data
    if (user.role === 'client') {
      const { data: client, error: clientError } = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('user_id', userId)
        .single();

      if (client && !clientError) {
        // Combine user and client data
        // Preserve both user.id (for token validation) and client.id (for client operations)
        req.user = {
          ...user,
          ...client,
          // Keep the users.id as the primary id for token validation
          id: user.id,
          // Store client.id separately so we can use it for client operations
          client_id: client.id
        };
      } else {
        // Client record not found - might be old system client, try lookup by id (backward compatibility)
        const { data: oldClient, error: oldClientError } = await supabaseAdmin
          .from('clients')
          .select('*')
          .eq('id', userId)
          .single();

        if (oldClient && !oldClientError) {
          // Old system client - use client data
          req.user = {
            ...oldClient,
            id: oldClient.id,
            role: 'client'
          };
        } else {
          // Client record not found - just use user data
          req.user = user;
        }
      }
    } else {
      // User exists in users table (admin, superadmin, etc.)
      req.user = user;
    }

    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        error: 'Token expired', 
        message: 'Please login again' 
      });
    }
    
    return res.status(403).json({ 
      error: 'Invalid token', 
      message: 'Access denied' 
    });
  }
};

// Check if user has specific role
const requireRole = (roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ 
        error: 'Unauthorized', 
        message: 'Authentication required' 
      });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Forbidden', 
        message: 'Insufficient permissions' 
      });
    }

    next();
  };
};

// Specific role middlewares
const requireClient = requireRole(['client']);
const requirePsychologist = requireRole(['psychologist', 'superadmin']); // Superadmin can access psychologist routes
const requireAdmin = requireRole(['admin', 'superadmin']);
const requireSuperAdmin = requireRole(['superadmin']);
const requireFinance = requireRole(['finance', 'admin', 'superadmin']); // Finance can access finance routes, admins can too

module.exports = {
  authenticateToken,
  requireRole,
  requireClient,
  requirePsychologist,
  requireAdmin,
  requireSuperAdmin,
  requireFinance
};
