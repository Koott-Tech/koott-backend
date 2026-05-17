require('dotenv').config();
const { supabaseAdmin } = require('./config/supabase');
const bcrypt = require('bcryptjs');

async function check() {
  const { data, error } = await supabaseAdmin.from('psychologists').select('*').eq('email', 'phonixer321@gmail.com').single();
  console.log('User found:', !!data);
  if (data) {
    console.log('Password hash exists:', !!data.password_hash);
    const isValid = await bcrypt.compare('Password123!', data.password_hash);
    console.log('Password valid:', isValid);
  }
}
check();
