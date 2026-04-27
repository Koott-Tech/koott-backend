const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function addCommissionColumn() {
  console.log('🚀 Adding therapist_commission column to sessions table...');
  
  // Using RPC to run arbitrary SQL if available, or just relying on a direct query
  // Since we don't have a direct SQL executor easily, we'll use a hack or assume the user can run it.
  // Actually, I can try to use a simple query that might fail if column doesn't exist,
  // but there is no 'ALTER TABLE' via PostgREST.
  
  console.log('⚠️ [IMPORTANT] Please run the following SQL in your Supabase SQL Editor:');
  console.log('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS therapist_commission NUMERIC DEFAULT 0;');
  console.log('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refund_status TEXT;'); // Adding this too just in case
  
  // Let's try to verify if it exists by trying to select it
  const { error } = await supabase.from('sessions').select('therapist_commission').limit(1);
  if (error && error.message.includes('column "therapist_commission" does not exist')) {
    console.log('❌ Column "therapist_commission" does not exist yet.');
  } else if (error) {
    console.log('ℹ️ Table might be empty or other error:', error.message);
  } else {
    console.log('✅ Column "therapist_commission" already exists.');
  }
}

addCommissionColumn();
