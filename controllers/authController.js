// Removed unused supabase import - using supabaseAdmin inline where needed
const { 
  generateToken, 
  hashPassword, 
  comparePassword,
  successResponse,
  errorResponse
} = require('../utils/helpers');
const emailVerificationService = require('../utils/emailVerificationService');
const accountLockoutService = require('../utils/accountLockout');
const { validatePassword } = require('../utils/passwordPolicy');
const auditLogger = require('../utils/auditLogger');
const sessionManager = require('../utils/sessionManager');

// User registration
const register = async (req, res) => {
  try {
    let { email, password, role } = req.body;
    if (typeof email === 'string') {
      email = email.trim().toLowerCase();
    }

    // SECURITY FIX: Prevent public registration of admin/superadmin roles
    // Admin users must be created via /api/superadmin/create-admin (superadmin only)
    // Superadmin users must be created manually via database or secure setup script
    if (role === 'admin' || role === 'superadmin') {
      return res.status(403).json(
        errorResponse('Admin and superadmin accounts cannot be created through public registration. Please contact system administrator.')
      );
    }

    // Check if user already exists
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { supabaseAdmin } = require('../config/supabase');
    
    if (role === 'client') {
      // Check users table first (for new system)
      const { data: existingUser, error: userCheckError } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('email', email.toLowerCase().trim()) // Normalize email
        .maybeSingle(); // Use maybeSingle() instead of single() to avoid error when no record found

      if (userCheckError && userCheckError.code !== 'PGRST116') {
        // PGRST116 is "not found" error which is expected, ignore it
        console.error('Error checking existing user:', userCheckError);
        return res.status(500).json(
          errorResponse('Error checking account. Please try again.')
        );
      }

      if (existingUser) {
        console.log('User already exists with email:', email);
        return res.status(400).json(
          errorResponse('An account with this email already exists. Please login instead.')
        );
      }

      // Also check clients table for old entries (backward compatibility)
      const { data: existingClient, error: clientCheckError } = await supabaseAdmin
        .from('clients')
        .select('id')
        .eq('email', email.toLowerCase().trim()) // Normalize email
        .maybeSingle(); // Use maybeSingle() instead of single() to avoid error when no record found

      if (clientCheckError && clientCheckError.code !== 'PGRST116') {
        // PGRST116 is "not found" error which is expected, ignore it
        console.error('Error checking existing client:', clientCheckError);
        return res.status(500).json(
          errorResponse('Error checking account. Please try again.')
        );
      }

      if (existingClient) {
        console.log('Client already exists with email:', email);
        return res.status(400).json(
          errorResponse('An account with this email already exists. Please login instead.')
        );
      }
    } else if (role === 'psychologist') {
      const { data: existingPsychologist } = await supabaseAdmin
        .from('psychologists')
        .select('id')
        .eq('email', email)
        .single();

      if (existingPsychologist) {
        return res.status(400).json(
          errorResponse('Psychologist with this email already exists')
        );
      }
    } else {
      // For admin roles, check users table
      const { data: existingUser } = await supabaseAdmin
        .from('users')
        .select('id')
        .eq('email', email)
        .single();

      if (existingUser) {
        return res.status(400).json(
          errorResponse('User with this email already exists')
        );
      }
    }

    // Enforce password presence first
    if (!password || typeof password !== 'string' || password.trim() === '') {
      return res.status(400).json(
        errorResponse('Password is required')
      );
    }

    // Validate password against policy
    const passwordValidation = validatePassword(password);
    if (!passwordValidation.valid) {
      return res.status(400).json(
        errorResponse('Password does not meet requirements', passwordValidation.errors)
      );
    }

    // Hash password only after validation succeeds
    const hashedPassword = await hashPassword(password);

    let user, profileData;

    if (role === 'client') {
      // Use supabaseAdmin for registration to bypass RLS
      const { supabaseAdmin } = require('../config/supabase');
      
      // First create a user record in users table (same as Google sign-in)
      // Normalize email to lowercase and trim
      const normalizedEmail = email.toLowerCase().trim();
      
      const { data: newUser, error: userError } = await supabaseAdmin
        .from('users')
        .insert({
          email: normalizedEmail,
          password_hash: hashedPassword,
          role: 'client',
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (userError) {
        console.error('Error creating user:', userError);
        
        // Check if it's a unique constraint violation (duplicate email)
        if (userError.code === '23505' || userError.message?.includes('duplicate') || userError.message?.includes('unique')) {
          return res.status(400).json(
            errorResponse('An account with this email already exists. Please login instead.')
          );
        }
        
        return res.status(500).json(
          errorResponse(`Failed to create user account: ${userError.message}`)
        );
      }

      console.log('✅ User created successfully:', { id: newUser.id, email: newUser.email });

      const childName = req.body.child_name?.trim() || null;

      // Then create client record with user_id reference (child_name is optional; use placeholder if DB requires NOT NULL)
      const { data: client, error: clientError } = await supabaseAdmin
        .from('clients')
        .insert({
          user_id: newUser.id,
          first_name: req.body.first_name || 'Pending',
          last_name: req.body.last_name || '', // Use empty string instead of 'Update' since we only use full name as first_name
          phone_number: req.body.phone_number || '+91',
          child_name: childName || 'Pending',
          child_age: req.body.child_age || 1,
          client_message: req.body.client_message?.trim() || null,
          terms_accepted: req.body.terms_accepted || false,
          therapy_agreement_accepted: req.body.therapy_agreement_accepted || false,
          created_at: new Date().toISOString()
        })
        .select('*')
        .single();

      if (clientError) {
        console.error('Error creating client:', clientError);
        // Clean up user record if client creation fails
        await supabaseAdmin.from('users').delete().eq('id', newUser.id);
        return res.status(500).json(
          errorResponse(`Failed to create client account: ${clientError.message}`)
        );
      }

      console.log('✅ Client created successfully:', { id: client.id, user_id: client.user_id });

      // Combine user and client data
      // IMPORTANT: Preserve newUser.id (from users table) as the primary ID for token generation
      // Extract client.id separately to avoid overwriting user.id
      const { id: clientId, ...clientDataWithoutId } = client;
      user = {
        ...newUser, // Start with user data
        ...clientDataWithoutId, // Add client data (without client.id)
        id: newUser.id, // Explicitly set user.id LAST to ensure it's not overwritten
        client_id: clientId // Store client.id separately if needed
      };
      profileData = {
        ...newUser,
        ...client
      };

      console.log('✅ Registration complete, token will be generated for user.id:', user.id);
      console.log('🔍 Verification - user object id:', user.id, 'should match newUser.id:', newUser.id);
    } else if (role === 'psychologist') {
      // Create psychologist directly in psychologists table (no users table entry)
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: psychologist, error: psychologistError } = await supabaseAdmin
        .from('psychologists')
        .insert([{
          email,
          password_hash: hashedPassword,
          first_name: req.body.first_name,
          last_name: req.body.last_name,
          ug_college: req.body.ug_college,
          pg_college: req.body.pg_college,
          mphil_college: req.body.mphil_college,
          phd_college: req.body.phd_college,
          area_of_expertise: req.body.area_of_expertise,
          description: req.body.description,
          experience_years: req.body.experience_years || 0,
          phone: req.body.phone || null
        }])
        .select('*')
        .single();

      if (psychologistError) {
        console.error('Psychologist profile creation error:', psychologistError);
        return res.status(500).json(
          errorResponse('Failed to create psychologist profile')
        );
      }

      // Create a mock user object for psychologist (since they don't exist in users table)
      user = {
        id: psychologist.id,
        email: psychologist.email,
        role: 'psychologist',
        created_at: psychologist.created_at
      };
      profileData = psychologist;
    } else {
      // Create admin/super admin/finance user in users table
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: newUser, error: userError } = await supabaseAdmin
        .from('users')
        .insert([{
          email,
          password_hash: hashedPassword,
          role
        }])
        .select('id, email, role, created_at')
        .single();

      if (userError) {
        console.error('Admin user creation error:', userError);
        return res.status(500).json(
          errorResponse('Failed to create admin account')
        );
      }

      user = newUser;
      profileData = newUser; // Admin users don't have separate profile tables
    }

    // Send new user notification to admin (client and psychologist only)
    if (role === 'client' || role === 'psychologist') {
      const adminEmail = process.env.COMPANY_ADMIN_EMAIL;
      const meetKoottEmail = 'meet.koott@gmail.com';
      const adminRecipients = [adminEmail, meetKoottEmail].filter(Boolean).join(', ');
      if (adminRecipients) {
        try {
          const emailService = require('../utils/emailService');
          // Use created client/psychologist record for name so admin email always has the correct client name
          const firstName = (role === 'client' ? client?.first_name : profileData?.first_name) || req.body.first_name || '';
          const lastName = (role === 'client' ? client?.last_name : profileData?.last_name) || req.body.last_name || '';
          await emailService.sendNewUserRegistrationNotification({
            to: adminRecipients,
            email: user.email,
            role: user.role,
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: profileData.phone_number || profileData.phone || req.body.phone_number || req.body.phone,
            childName: profileData.child_name || req.body.child_name,
            childAge: profileData.child_age ?? req.body.child_age,
            userId: user.id,
            clientId: role === 'client' ? (user.client_id || client?.id) : null,
            createdAt: user.created_at || profileData.created_at
          });
          console.log('📧 New user registration email sent to admin');
        } catch (emailErr) {
          console.error('Error sending new user registration email:', emailErr);
        }
      }
    }

    // Generate JWT token
    const token = generateToken(user.id, user.role);

    // Send response immediately (don't wait for email)
    res.status(201).json(
      successResponse({
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          profile: profileData
        },
        token
      }, 'User registered successfully')
    );

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json(
      errorResponse('Internal server error during registration')
    );
  }
};

// Google OAuth login
const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json(
        errorResponse('Google ID token is required')
      );
    }

    // Verify Google ID token
    const { OAuth2Client } = require('google-auth-library');
    // Use frontend Client ID to verify the token (since frontend issued it)
    // This should be the same Client ID used by the frontend
    const frontendClientId = process.env.FRONTEND_GOOGLE_CLIENT_ID || '975865953640-79vjma6g08dski07q39a041efpqj9k2o.apps.googleusercontent.com';
    const client = new OAuth2Client(frontendClientId);
    
    console.log('Verifying Google token with frontend client ID:', frontendClientId);
    
    const ticket = await client.verifyIdToken({
      idToken: idToken,
      audience: frontendClientId,
    });
    
    const payload = ticket.getPayload();
    const { email, name, picture, sub: googleId } = payload;
    
    console.log('Google token verified successfully:', {
      email,
      name,
      googleId,
      hasPicture: !!picture
    });

    if (!email) {
      return res.status(400).json(
        errorResponse('Email not provided by Google')
      );
    }

    // Normalize email to ensure consistency with login validation
    if (typeof email === 'string') {
      email = email.trim().toLowerCase();
    }

    // Check if user already exists
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { supabaseAdmin } = require('../config/supabase');
    
    let user = null;
    let userRole = 'client'; // Default role for Google sign-ins

    // First check psychologists table
    const { data: psychologist, error: psychologistError } = await supabaseAdmin
      .from('psychologists')
      .select('*')
      .eq('email', email)
      .single();

    if (psychologist && !psychologistError) {
      user = psychologist;
      userRole = 'psychologist';
    } else {
      // Check clients table
      const { data: existingClient, error: clientError } = await supabaseAdmin
        .from('clients')
        .select(`
          *,
          users!inner(*)
        `)
        .eq('users.email', email)
        .single();

      if (existingClient && !clientError) {
        user = existingClient;
        userRole = 'client';
      } else {
        // Check users table for admin roles
        const { data: existingUser, error: userError } = await supabaseAdmin
          .from('users')
          .select('*')
          .eq('email', email)
          .single();

        if (existingUser && !userError) {
          user = existingUser;
          userRole = existingUser.role;
        }
      }
    }

    // If user doesn't exist, create new client
    if (!user) {
      console.log('Creating new client with Google data:', {
        email,
        googleId,
        picture,
        firstName: name?.split(' ')[0] || '',
        lastName: name?.split(' ').slice(1).join(' ') || ''
      });

      // First create a user record in users table
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: newUser, error: userError } = await supabaseAdmin
        .from('users')
        .insert({
          email: email,
          role: 'client',
          google_id: googleId,
          profile_picture_url: picture,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (userError) {
        console.error('Error creating user:', userError);
        return res.status(500).json(
          errorResponse(`Failed to create user account: ${userError.message}`)
        );
      }

      // Then create client record with user_id reference
      // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
      const { data: newClient, error: createError } = await supabaseAdmin
        .from('clients')
        .insert({
          user_id: newUser.id,
          first_name: name?.split(' ')[0] || '',
          last_name: name?.split(' ').slice(1).join(' ') || '',
          phone_number: '+91',
          child_name: 'Pending',
          child_age: 1,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (createError) {
        console.error('Error creating client:', createError);
        // Clean up user record if client creation fails (use supabaseAdmin to bypass RLS)
        const { supabaseAdmin } = require('../config/supabase');
        await supabaseAdmin.from('users').delete().eq('id', newUser.id);
        return res.status(500).json(
          errorResponse(`Failed to create client account: ${createError.message}`)
        );
      }

      // Combine user and client data
      user = { ...newUser, ...newClient };
      userRole = 'client';
    } else {
      // Update existing user with Google info if needed
      if (userRole === 'client') {
        // Update the user record with Google info
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        const { error: updateUserError } = await supabaseAdmin
          .from('users')
          .update({
            google_id: googleId,
            profile_picture_url: picture
          })
          .eq('id', user.user_id || user.id);

        if (updateUserError) {
          console.error('Error updating user with Google info:', updateUserError);
        }
      } else if (userRole === 'psychologist') {
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        const { error: updateError } = await supabaseAdmin
          .from('psychologists')
          .update({
            google_id: googleId,
            profile_picture_url: picture
          })
          .eq('id', user.id);

        if (updateError) {
          console.error('Error updating psychologist with Google info:', updateError);
        }
      } else {
        // Update admin users in users table
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        const { error: updateError } = await supabaseAdmin
          .from('users')
          .update({
            google_id: googleId,
            profile_picture_url: picture
          })
          .eq('id', user.id);

        if (updateError) {
          console.error('Error updating admin user with Google info:', updateError);
        }
      }
    }

    // Generate JWT token
    const token = generateToken(user.id, userRole);

    // Get role-specific profile
    let profile = null;
    if (userRole === 'client') {
      // Client profile is already the user object since clients are stored directly in clients table
      profile = user;
    } else if (userRole === 'psychologist') {
      profile = user;
    } else {
      // Admin users don't have separate profile tables
      profile = user;
    }

    res.json(
      successResponse({
        user: {
          id: user.id,
          email: user.email,
          role: userRole,
          profile_picture_url: picture,
          profile: profile
        },
        token
      }, 'Google login successful')
    );

  } catch (error) {
    console.error('Google login error:', error);
    
    // Handle specific Google Auth errors
    if (error.message && error.message.includes('Invalid token')) {
      return res.status(400).json(
        errorResponse('Invalid Google token. Please try signing in again.')
      );
    }
    
    if (error.message && error.message.includes('Token expired')) {
      return res.status(400).json(
        errorResponse('Google token expired. Please try signing in again.')
      );
    }
    
    // Handle database errors
    if (error.code && error.code.includes('23505')) { // Unique constraint violation
      return res.status(400).json(
        errorResponse('Account with this email already exists. Please try logging in instead.')
      );
    }
    
    res.status(500).json(
      errorResponse('Google authentication failed. Please try again.')
    );
  }
};

// Helper function to find user with flexible Gmail dot handling
const findUserWithFlexibleEmail = async (table, email) => {
  // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
  const { supabaseAdmin } = require('../config/supabase');
  
  // First try exact match (case-insensitive)
  let { data, error } = await supabaseAdmin
    .from(table)
    .select('*')
    .ilike('email', email)
    .single();
  
  if (data && !error) {
    return { data, error };
  }
  
  // If Gmail and no exact match, try without dots
  if (email.includes('@gmail.com')) {
    const [localPart, domain] = email.split('@');
    const emailWithoutDots = localPart.replace(/\./g, '') + '@' + domain;
    
    const { data: dataWithoutDots, error: errorWithoutDots } = await supabaseAdmin
      .from(table)
      .select('*')
      .ilike('email', emailWithoutDots)
      .single();
    
    if (dataWithoutDots && !errorWithoutDots) {
      return { data: dataWithoutDots, error: errorWithoutDots };
    }
  }
  
  // If Gmail and no match without dots, try with dots added
  if (email.includes('@gmail.com')) {
    const [localPart, domain] = email.split('@');
    // Try common dot patterns
    const dotPatterns = [
      localPart.charAt(0) + '.' + localPart.slice(1), // first char + dot + rest
      localPart.slice(0, -1) + '.' + localPart.slice(-1), // rest + dot + last char
    ];
    
    for (const dotPattern of dotPatterns) {
      const emailWithDots = dotPattern + '@' + domain;
      const { data: dataWithDots, error: errorWithDots } = await supabaseAdmin
        .from(table)
        .select('*')
        .ilike('email', emailWithDots)
        .single();
      
      if (dataWithDots && !errorWithDots) {
        return { data: dataWithDots, error: errorWithDots };
      }
    }
  }
  
  return { data: null, error: { message: 'User not found' } };
};

// User login
const login = async (req, res) => {
  try {
    let { email, password } = req.body;
    if (typeof email === 'string') {
      email = email.trim().toLowerCase();
    }

    // Check if account is locked (before attempting login)
    const lockoutStatus = await accountLockoutService.isAccountLocked(email);
    if (lockoutStatus.locked) {
      const minutesRemaining = Math.ceil((lockoutStatus.lockoutUntil.getTime() - Date.now()) / 60000);
      return res.status(429).json(
        errorResponse(
          `Account temporarily locked due to too many failed login attempts. Please try again in ${minutesRemaining} minute(s).`,
          null,
          429
        )
      );
    }

    // First check if it's a psychologist with flexible email matching
    const { data: psychologist, error: psychologistError } = await findUserWithFlexibleEmail('psychologists', email);

    if (psychologist && !psychologistError) {
      // Verify password for psychologist
      const isValidPassword = await comparePassword(password, psychologist.password_hash);
      if (!isValidPassword) {
        // Record failed attempt
        const ip = req.ip || req.connection.remoteAddress;
        await accountLockoutService.recordFailedAttempt(email, ip);
        
        // Log failed login attempt
        await auditLogger.logAction({
          userId: null,
          userEmail: email,
          userRole: 'psychologist',
          action: 'LOGIN_FAILED',
          resource: 'authentication',
          resourceId: psychologist.id,
          endpoint: '/api/auth/login',
          method: 'POST',
          details: { reason: 'Invalid password', role: 'psychologist' },
          ip: ip,
          userAgent: req.headers['user-agent'] || 'Unknown'
        }).catch(err => console.error('Error logging failed login:', err));
        
        return res.status(401).json(
          errorResponse('Invalid email or password')
        );
      }

      // Log successful login
      const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
      await auditLogger.logAction({
        userId: psychologist.id,
        userEmail: email,
        userRole: 'psychologist',
        action: 'LOGIN_SUCCESS',
        resource: 'authentication',
        resourceId: psychologist.id,
        endpoint: '/api/auth/login',
        method: 'POST',
        details: { role: 'psychologist' },
        ip: ip,
        userAgent: req.headers['user-agent'] || 'Unknown'
      }).catch(err => console.error('Error logging successful login:', err));

      // Clear failed attempts on successful login
      await accountLockoutService.clearFailedAttempts(email);

      // Generate JWT token for psychologist
      const token = generateToken(psychologist.id, 'psychologist');

      // Create session (reuse ip variable from above)
      try {
        await sessionManager.createSession(psychologist.id, token, ip, req.headers['user-agent'] || 'Unknown');
      } catch (sessionError) {
        await auditLogger.logAction({
          userId: psychologist.id,
          userEmail: email,
          userRole: 'psychologist',
          action: 'SESSION_CREATION_FAILED',
          resource: 'authentication',
          resourceId: psychologist.id,
          endpoint: '/api/auth/login',
          method: 'POST',
          details: { 
            error: sessionError.message,
            psychologistId: psychologist.id,
            tokenPrefix: token.substring(0, 8) + '...'
          },
          ip: ip,
          userAgent: req.headers['user-agent'] || 'Unknown'
        }).catch(err => console.error('Error logging session creation failure:', err));
        // Continue with login flow even if session creation fails
      }

      res.json(
        successResponse({
          user: {
            id: psychologist.id,
            email: psychologist.email,
            role: 'psychologist',
            profile_picture_url: null,
            profile: psychologist
          },
          token
        }, 'Login successful')
      );
      return;
    }

    // If not a psychologist, check for clients or admin users
    let user = null;
    let userRole = null;
    
    // First check users table for new system clients (with user_id reference)
    // This handles clients created via email/password or Google sign-in
    let clientData = null;
    const { data: userFromUsers, error: userFromUsersError } = await findUserWithFlexibleEmail('users', email);

    if (userFromUsers && !userFromUsersError && userFromUsers.role === 'client') {
      // Found a client in users table (new system)
      // Verify password
      const isValidPassword = await comparePassword(password, userFromUsers.password_hash);
      
      if (isValidPassword) {
        // Clear failed attempts on successful login
        await accountLockoutService.clearFailedAttempts(email);
        
        // Now fetch the client profile
        // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
        const { supabaseAdmin } = require('../config/supabase');
        const { data: clientProfile, error: clientProfileError } = await supabaseAdmin
          .from('clients')
          .select('*')
          .eq('user_id', userFromUsers.id)
          .single();

        if (clientProfile && !clientProfileError) {
          user = userFromUsers;
          userRole = 'client';
          clientData = clientProfile;
        } else {
          // User exists but client profile not found - might be a data inconsistency
          user = userFromUsers;
          userRole = 'client';
        }
      } else {
        // Record failed attempt
        const ip = req.ip || req.connection.remoteAddress;
        await accountLockoutService.recordFailedAttempt(email, ip);
        
        // Log failed login attempt
        await auditLogger.logAction({
          userId: null,
          userEmail: email,
          userRole: 'client',
          action: 'LOGIN_FAILED',
          resource: 'authentication',
          resourceId: userFromUsers?.id || null,
          endpoint: '/api/auth/login',
          method: 'POST',
          details: { reason: 'Invalid password', role: 'client' },
          ip: ip,
          userAgent: req.headers['user-agent'] || 'Unknown'
        }).catch(err => console.error('Error logging failed login:', err));
        
        return res.status(401).json(
          errorResponse('Invalid email or password')
        );
      }
    } else {
      // Check old system: clients table with direct email (backward compatibility)
      const { data: oldClient, error: oldClientError } = await findUserWithFlexibleEmail('clients', email);

      if (oldClient && !oldClientError && oldClient.password_hash) {
        // Old system client - password is in clients table
        const isValidPassword = await comparePassword(password, oldClient.password_hash);
        
        if (isValidPassword) {
          // Clear failed attempts on successful login
          await accountLockoutService.clearFailedAttempts(email);
          
          user = oldClient;
          userRole = 'client';
          clientData = oldClient;
        } else {
          // Record failed attempt
          const ip = req.ip || req.connection.remoteAddress;
          await accountLockoutService.recordFailedAttempt(email, ip);
          
          // Log failed login attempt
          await auditLogger.logAction({
            userId: null,
            userEmail: email,
            userRole: 'client',
            action: 'LOGIN_FAILED',
            resource: 'authentication',
            resourceId: oldClient?.id || null,
            endpoint: '/api/auth/login',
            method: 'POST',
            details: { reason: 'Invalid password', role: 'client' },
            ip: ip,
            userAgent: req.headers['user-agent'] || 'Unknown'
          }).catch(err => console.error('Error logging failed login:', err));
          
          return res.status(401).json(
            errorResponse('Invalid email or password')
          );
        }
      } else {
        // Check users table for admin roles with flexible email matching
        const { data: adminUser, error: userError } = await findUserWithFlexibleEmail('users', email);

        if (adminUser && !userError) {
          const isValidPassword = await comparePassword(password, adminUser.password_hash);
          
          if (isValidPassword) {
            // Clear failed attempts on successful login
            await accountLockoutService.clearFailedAttempts(email);
            
            user = adminUser;
            userRole = adminUser.role;
          } else {
            // Record failed attempt
            const ip = req.ip || req.connection.remoteAddress;
            await accountLockoutService.recordFailedAttempt(email, ip);
            
            // Log failed login attempt
            await auditLogger.logAction({
              userId: null,
              userEmail: email,
              userRole: adminUser?.role || 'unknown',
              action: 'LOGIN_FAILED',
              resource: 'authentication',
              resourceId: adminUser?.id || null,
              endpoint: '/api/auth/login',
              method: 'POST',
              details: { reason: 'Invalid password', role: adminUser?.role || 'unknown' },
              ip: ip,
              userAgent: req.headers['user-agent'] || 'Unknown'
            }).catch(err => console.error('Error logging failed login:', err));
            
            return res.status(401).json(
              errorResponse('Invalid email or password')
            );
          }
        } else {
          // User not found - record failed attempt (don't reveal user doesn't exist)
          const ip = req.ip || req.connection.remoteAddress;
          await accountLockoutService.recordFailedAttempt(email, ip);
          
          // Log failed login attempt (user not found)
          await auditLogger.logAction({
            userId: null,
            userEmail: email,
            userRole: 'unknown',
            action: 'LOGIN_FAILED',
            resource: 'authentication',
            resourceId: null,
            endpoint: '/api/auth/login',
            method: 'POST',
            details: { reason: 'User not found' },
            ip: ip,
            userAgent: req.headers['user-agent'] || 'Unknown'
          }).catch(err => console.error('Error logging failed login:', err));
          
          return res.status(401).json(
            errorResponse('Invalid email or password')
          );
        }
      }
    }

    // Log successful login
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    await auditLogger.logAction({
      userId: user.id,
      userEmail: email,
      userRole: userRole,
      action: 'LOGIN_SUCCESS',
      resource: 'authentication',
      resourceId: user.id,
      endpoint: '/api/auth/login',
      method: 'POST',
      details: { role: userRole },
      ip: ip,
      userAgent: req.headers['user-agent'] || 'Unknown'
    }).catch(err => console.error('Error logging successful login:', err));

    // Get role-specific profile
    let profile = null;
    if (userRole === 'client') {
      // Combine user and client data if available
      if (clientData) {
        // Remove the nested users object if it exists and merge client data
        const { users, ...clientFields } = clientData;
        profile = { ...user, ...clientFields };
      } else {
        profile = user;
      }
    } else {
      // Admin users don't have separate profile tables
      profile = user;
    }

    // Generate JWT token - use user.id (from users table for new clients, or client.id for old clients)
    const token = generateToken(user.id, userRole);

    // Create session (reuse ip variable from above)
    try {
      await sessionManager.createSession(user.id, token, ip, req.headers['user-agent'] || 'Unknown');
    } catch (sessionError) {
      await auditLogger.logAction({
        userId: user.id,
        userEmail: email,
        userRole: userRole,
        action: 'SESSION_CREATION_FAILED',
        resource: 'authentication',
        resourceId: user.id,
        endpoint: '/api/auth/login',
        method: 'POST',
        details: { 
          error: sessionError.message,
          userId: user.id,
          tokenPrefix: token.substring(0, 8) + '...'
        },
        ip: ip,
        userAgent: req.headers['user-agent'] || 'Unknown'
      }).catch(err => console.error('Error logging session creation failure:', err));
      // Continue with login flow even if session creation fails
    }

    res.json(
      successResponse({
        user: {
          id: user.id,
          email: user.email,
          role: userRole,
          profile_picture_url: user.profile_picture_url,
          profile
        },
        token
      }, 'Login successful')
    );

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json(
      errorResponse('Internal server error during login')
    );
  }
};

// Get current user profile
const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;

    // Get user with profile based on role
    let profile = null;
    
    if (userRole === 'client') {
      // New system: client has user_id reference to users table
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { supabaseAdmin } = require('../config/supabase');
      // Try lookup by user_id first (new system)
      let { data: client, error: clientError } = await supabaseAdmin
        .from('clients')
        .select('*')
        .eq('user_id', userId)
        .single();

      // If not found, try old system: lookup by id (backward compatibility)
      if (clientError || !client) {
        ({ data: client, error: clientError } = await supabaseAdmin
          .from('clients')
          .select('*')
          .eq('id', userId)
          .single());
      }

      // If client data is already in req.user (from middleware), use it
      if (!client && req.user.first_name) {
        profile = req.user;
      } else {
        profile = client;
      }
    } else if (userRole === 'psychologist') {
      // For psychologists, the profile is the user data itself
      // Use supabaseAdmin to bypass RLS (backend has proper auth/authorization)
      const { supabaseAdmin } = require('../config/supabase');
      const { data: psychologist } = await supabaseAdmin
        .from('psychologists')
        .select('*')
        .eq('id', userId)
        .single();
      profile = psychologist;
    }

    res.json(
      successResponse({
        user: {
          id: req.user.id,
          email: req.user.email,
          role: req.user.role,
          profile_picture_url: req.user.profile_picture_url || null,
          profile: profile || req.user
        }
      })
    );

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json(
      errorResponse('Internal server error while fetching profile')
    );
  }
};

// Update profile picture
const updateProfilePicture = async (req, res) => {
  try {
    const userId = req.user.id;
    const { profile_picture_url } = req.body;

    if (!profile_picture_url) {
      return res.status(400).json(
        errorResponse('Profile picture URL is required')
      );
    }

    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { supabaseAdmin } = require('../config/supabase');
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .update({ 
        profile_picture_url,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .select('profile_picture_url')
      .single();

    if (error) {
      console.error('Profile picture update error:', error);
      return res.status(500).json(
        errorResponse('Failed to update profile picture')
      );
    }

    res.json(
      successResponse({
        profile_picture_url: user.profile_picture_url
      }, 'Profile picture updated successfully')
    );

  } catch (error) {
    console.error('Profile picture update error:', error);
    res.status(500).json(
      errorResponse('Internal server error while updating profile picture')
    );
  }
};

// Change password
const changePassword = async (req, res) => {
  try {
    const userId = req.user.id;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json(
        errorResponse('Current password and new password are required')
      );
    }

    // Validate password against policy
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json(
        errorResponse('Password does not meet requirements', passwordValidation.errors)
      );
    }

    // Get current user to verify current password
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { supabaseAdmin } = require('../config/supabase');
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('password_hash')
      .eq('id', userId)
      .single();

    // Verify current password
    const isValidPassword = await comparePassword(currentPassword, user.password_hash);
    if (!isValidPassword) {
      return res.status(400).json(
        errorResponse('Current password is incorrect')
      );
    }

    // Hash new password
    const hashedNewPassword = await hashPassword(newPassword);

    // Update password
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { error } = await supabaseAdmin
      .from('users')
      .update({ 
        password_hash: hashedNewPassword,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    if (error) {
      console.error('Password change error:', error);
      return res.status(500).json(
        errorResponse('Failed to change password')
      );
    }

    res.json(
      successResponse(null, 'Password changed successfully')
    );

  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json(
      errorResponse('Internal server error while changing password')
    );
  }
};

// Send password reset OTP
const sendPasswordResetOTP = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json(
        errorResponse('Email is required')
      );
    }

    // Check if user exists (only for clients in users table)
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { supabaseAdmin } = require('../config/supabase');
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, email, role')
      .eq('email', email)
      .single();

    if (!user) {
      return res.status(404).json(
        errorResponse('No account found with this email address')
      );
    }

    // Only allow password reset for clients
    if (user.role !== 'client') {
      return res.status(403).json(
        errorResponse('Password reset is only available for client accounts')
      );
    }

    // Send OTP for password reset
    const result = await emailVerificationService.sendOTP(email, 'password_reset', 'client');
    
    if (!result.success) {
      return res.status(400).json(
        errorResponse(result.message, result.error)
      );
    }

    res.json(
      successResponse(null, 'Password reset OTP sent to your email')
    );

  } catch (error) {
    console.error('Send password reset OTP error:', error);
    res.status(500).json(
      errorResponse('Internal server error while sending password reset OTP')
    );
  }
};

// Reset password with OTP
const resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(400).json(
        errorResponse('Email, OTP, and new password are required')
      );
    }

    // Validate password against policy
    const passwordValidation = validatePassword(newPassword);
    if (!passwordValidation.valid) {
      return res.status(400).json(
        errorResponse('Password does not meet requirements', passwordValidation.errors)
      );
    }

    // Verify OTP
    const verificationResult = await emailVerificationService.verifyOTP(email, otp, 'password_reset');
    if (!verificationResult.success) {
      return res.status(400).json(
        errorResponse(verificationResult.message, verificationResult.error)
      );
    }

    // Check if user exists
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { supabaseAdmin } = require('../config/supabase');
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('id, email, role')
      .eq('email', email)
      .single();

    if (!user) {
      return res.status(404).json(
        errorResponse('User not found')
      );
    }

    // Only allow password reset for clients
    if (user.role !== 'client') {
      return res.status(403).json(
        errorResponse('Password reset is only available for client accounts')
      );
    }

    // Hash new password
    const hashedPassword = await hashPassword(newPassword);

    // Update password
    // Use supabaseAdmin to bypass RLS (backend service, proper auth already handled)
    const { error: updateError } = await supabaseAdmin
      .from('users')
      .update({ 
        password_hash: hashedPassword,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id);

    if (updateError) {
      console.error('Password reset update error:', updateError);
      return res.status(500).json(
        errorResponse('Failed to reset password')
      );
    }

    res.json(
      successResponse(null, 'Password reset successfully')
    );

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json(
      errorResponse('Internal server error while resetting password')
    );
  }
};

// Logout (revoke token)
const logout = async (req, res) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    // Revoke the token
    if (token) {
      const tokenRevocationService = require('../utils/tokenRevocation');
      await tokenRevocationService.revokeToken(token);
    }

    // Also revoke all user tokens if requested (for security)
    if (req.body?.revokeAll === true && req.user?.id) {
      const tokenRevocationService = require('../utils/tokenRevocation');
      await tokenRevocationService.revokeUserTokens(req.user.id);
    }

    res.json(
      successResponse(null, 'Logged out successfully')
    );
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json(
      errorResponse('Internal server error during logout')
    );
  }
};

// Send OTP for email verification during registration
module.exports = {
  register,
  login,
  googleLogin,
  getProfile,
  updateProfilePicture,
  changePassword,
  logout,
  sendPasswordResetOTP,
  resetPassword
};
