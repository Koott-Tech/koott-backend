const { createClient } = require('@supabase/supabase-js');

// Prefer the shared NEXT_PUBLIC_* env vars so frontend and backend
// use the same Supabase project URL; fall back to backend-only
// SUPABASE_* vars for compatibility.
const supabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnonKey =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error('Missing Supabase environment variables');
}

// Create client with anonymous key for user operations
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Create client with service role key for admin operations (bypasses RLS)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// Export both for backward compatibility
module.exports = supabase;
module.exports.supabaseAdmin = supabaseAdmin;
