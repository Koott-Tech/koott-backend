require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');
const { hashPassword } = require('../utils/helpers');

async function createEventOrganizer() {
  const email = 'events@koott.com';
  const password = 'Password123!';
  const hashedPassword = await hashPassword(password);

  console.log(`Checking if ${email} exists...`);
  
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .eq('email', email)
    .single();

  if (existingUser) {
    console.log('User already exists, updating role to event_organizer...');
    await supabaseAdmin
      .from('users')
      .update({ role: 'event_organizer', password_hash: hashedPassword })
      .eq('email', email);
    console.log('Updated user successfully.');
  } else {
    console.log('Creating new user...');
    const { data, error } = await supabaseAdmin
      .from('users')
      .insert([{
        email,
        password_hash: hashedPassword,
        role: 'event_organizer'
      }])
      .select('id, email, role')
      .single();

    if (error) {
      console.error('Error creating user:', error);
    } else {
      console.log('User created successfully:', data);
    }
  }
}

createEventOrganizer().then(() => process.exit(0)).catch(console.error);
