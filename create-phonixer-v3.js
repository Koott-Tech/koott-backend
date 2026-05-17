require('dotenv').config();
const { supabaseAdmin } = require('./config/supabase');
const { hashPassword } = require('./utils/helpers');

async function createPhonixer() {
  try {
    const email = 'phonixer321@gmail.com';
    const password = 'Password123!';
    const hashedPassword = await hashPassword(password);

    // Delete if exists
    await supabaseAdmin.from('psychologists').delete().eq('email', email);

    // Create doctor
    const { data, error } = await supabaseAdmin.from('psychologists').insert([{
      email,
      password_hash: hashedPassword,
      first_name: 'Test',
      last_name: 'Therapist Phonixer',
      phone: '+919876543210',
      designation: 'Psychologist',
      experience_years: 5
    }]).select('*').single();

    if (error) throw error;

    console.log('✅ Successfully created therapist:', data.email);
    console.log('Password is:', password);

    // Delete any old packages
    await supabaseAdmin.from('packages').delete().eq('psychologist_id', data.id);

    // Create a default package
    await supabaseAdmin.from('packages').insert([{
      psychologist_id: data.id,
      package_type: 'individual',
      name: 'Individual Session',
      description: 'One therapy session',
      session_count: 1,
      price: 1500,
      discount_percentage: 0
    }]);

  } catch (err) {
    console.error('❌ Error creating therapist:', err.message || err);
  }
}

createPhonixer();
