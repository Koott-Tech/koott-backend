#!/usr/bin/env node

/**
 * Test script: Wix Booking → Meet + Interakt Flow
 *
 * Creates a mock psychologist + client in Supabase, inserts a fake
 * Wix-sourced session, then triggers the full automation pipeline
 * (Meet link creation + Interakt WhatsApp notifications).
 *
 * Usage:
 *   node test-wix-flow.js
 *
 * Requires:
 *   - .env configured with Supabase, Google, and Interakt credentials
 *   - google-service-account.json (or GOOGLE_CLIENT_ID/SECRET for OAuth)
 */

require('dotenv').config();

const { supabaseAdmin } = require('./config/supabase');
const { hashPassword } = require('./utils/helpers');
const { processNewWixSessions } = require('./services/wixMeetNotifyService');

const PSYCHOLOGIST_EMAIL = 'abhishekravi063@gmail.com';
const CLIENT_EMAIL = 'phonixer321@gmail.com';

// Session scheduled for tomorrow at 3:00 PM IST
const tomorrow = new Date();
tomorrow.setDate(tomorrow.getDate() + 1);
const SCHEDULED_DATE = tomorrow.toISOString().split('T')[0]; // YYYY-MM-DD
const SCHEDULED_TIME = '15:00';

const WIX_BOOKING_ID = `test-wix-${Date.now()}`;

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  🧪  Wix Booking Flow — End-to-End Test');
  console.log('═══════════════════════════════════════════════════\n');

  // ── 1. Pre-flight checks ────────────────────────────────────────────
  console.log('1️⃣  Pre-flight: checking env vars...\n');

  const checks = {
    'NEXT_PUBLIC_SUPABASE_URL': !!process.env.NEXT_PUBLIC_SUPABASE_URL,
    'SUPABASE_SERVICE_ROLE_KEY': !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    'INTERAKT_API_KEY': !!process.env.INTERAKT_API_KEY,
    'GOOGLE_CLIENT_ID': !!process.env.GOOGLE_CLIENT_ID,
    'GOOGLE_CLIENT_SECRET': !!process.env.GOOGLE_CLIENT_SECRET,
  };

  let hasServiceAccount = false;
  try {
    require('./google-service-account.json');
    hasServiceAccount = true;
  } catch { /* noop */ }
  checks['google-service-account.json'] = hasServiceAccount;

  const hasMeetPath = checks['GOOGLE_CLIENT_ID'] || hasServiceAccount;

  for (const [key, ok] of Object.entries(checks)) {
    console.log(`   ${ok ? '✅' : '❌'} ${key}`);
  }

  if (!checks['NEXT_PUBLIC_SUPABASE_URL'] || !checks['SUPABASE_SERVICE_ROLE_KEY']) {
    console.error('\n❌ Supabase config missing — cannot proceed.');
    process.exit(1);
  }

  if (!checks['INTERAKT_API_KEY']) {
    console.warn('\n⚠️  INTERAKT_API_KEY missing — WhatsApp messages will be skipped.');
  }

  if (!hasMeetPath) {
    console.warn('\n⚠️  No Google auth (OAuth or Service Account) — Meet link creation will fail.');
  }

  // ── 2. Create/find psychologist ─────────────────────────────────────
  console.log('\n2️⃣  Resolving psychologist:', PSYCHOLOGIST_EMAIL);

  let psychologistId;
  const { data: existingPsych } = await supabaseAdmin
    .from('psychologists')
    .select('id')
    .ilike('email', PSYCHOLOGIST_EMAIL)
    .maybeSingle();

  if (existingPsych) {
    psychologistId = existingPsych.id;
    console.log(`   Found existing psychologist: ${psychologistId}`);
  } else {
    const localPart = PSYCHOLOGIST_EMAIL.split('@')[0];
    const suffix = localPart.slice(0, 4).toLowerCase();
    const tempPassword = `Welcome@${suffix}`;
    const passwordHash = await hashPassword(tempPassword);

    const { data: newPsych, error } = await supabaseAdmin
      .from('psychologists')
      .insert({
        email: PSYCHOLOGIST_EMAIL,
        first_name: 'Abhishek',
        last_name: 'Ravi',
        phone: '+918281540004', // Test phone number for WhatsApp
        designation: 'Psychologist',
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.error('   ❌ Failed to create psychologist:', error.message);
      process.exit(1);
    }
    psychologistId = newPsych.id;
    console.log(`   ✅ Created psychologist: ${psychologistId}`);
    console.log(`   🔐 Temp password: ${tempPassword}`);
  }

  // ── 3. Create/find client ───────────────────────────────────────────
  console.log('\n3️⃣  Resolving client:', CLIENT_EMAIL);

  let clientId;
  const { data: existingUser } = await supabaseAdmin
    .from('users')
    .select('id')
    .ilike('email', CLIENT_EMAIL)
    .maybeSingle();

  let userId;
  if (existingUser) {
    userId = existingUser.id;
    console.log(`   Found existing user: ${userId}`);
  } else {
    const localPart = CLIENT_EMAIL.split('@')[0];
    const suffix = localPart.slice(0, 4).toLowerCase();
    const tempPassword = `Welcome@${suffix}`;
    const passwordHash = await hashPassword(tempPassword);

    const { data: newUser, error } = await supabaseAdmin
      .from('users')
      .insert({
        email: CLIENT_EMAIL,
        role: 'client',
        password_hash: passwordHash,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.error('   ❌ Failed to create user:', error.message);
      process.exit(1);
    }
    userId = newUser.id;
    console.log(`   ✅ Created user: ${userId}`);
    console.log(`   🔐 Temp password: ${tempPassword}`);
  }

  // Find or create client row
  const { data: existingClient } = await supabaseAdmin
    .from('clients')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle();

  if (existingClient) {
    clientId = existingClient.id;
    console.log(`   Found existing client: ${clientId}`);
  } else {
    const { data: newClient, error } = await supabaseAdmin
      .from('clients')
      .insert({
        user_id: userId,
        first_name: 'Test',
        last_name: 'Client',
        phone_number: '+918281540004', // Test phone number for WhatsApp
        child_name: 'Test Child',
        child_age: 5,
        created_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error) {
      console.error('   ❌ Failed to create client:', error.message);
      process.exit(1);
    }
    clientId = newClient.id;
    console.log(`   ✅ Created client: ${clientId}`);
  }

  // ── 4. Create test session ──────────────────────────────────────────
  console.log('\n4️⃣  Creating test session...');
  console.log(`   Wix Booking ID: ${WIX_BOOKING_ID}`);
  console.log(`   Date: ${SCHEDULED_DATE}`);
  console.log(`   Time: ${SCHEDULED_TIME}`);

  const { data: session, error: sessionError } = await supabaseAdmin
    .from('sessions')
    .insert({
      wix_booking_id: WIX_BOOKING_ID,
      source: 'wix',
      client_id: clientId,
      psychologist_id: psychologistId,
      scheduled_date: SCHEDULED_DATE,
      scheduled_time: SCHEDULED_TIME,
      status: 'scheduled',
      session_type: 'individual',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (sessionError) {
    console.error('   ❌ Failed to create session:', sessionError.message);
    process.exit(1);
  }
  console.log(`   ✅ Session created: ${session.id}`);

  // ── 5. Trigger the automation ───────────────────────────────────────
  console.log('\n5️⃣  Triggering processNewWixSessions...\n');
  console.log('─── Pipeline output ────────────────────────────────\n');

  const result = await processNewWixSessions([WIX_BOOKING_ID]);

  console.log('\n─── Pipeline complete ──────────────────────────────\n');
  console.log('   Result:', JSON.stringify(result, null, 2));

  // ── 6. Verify results ──────────────────────────────────────────────
  console.log('\n6️⃣  Verification...');

  const { data: updatedSession } = await supabaseAdmin
    .from('sessions')
    .select('google_meet_link, google_calendar_event_id')
    .eq('id', session.id)
    .single();

  if (updatedSession?.google_meet_link) {
    console.log(`   ✅ Meet link saved: ${updatedSession.google_meet_link}`);
  } else {
    console.log('   ❌ No Meet link saved (check Google credentials)');
  }

  if (updatedSession?.google_calendar_event_id) {
    console.log(`   ✅ Calendar event ID: ${updatedSession.google_calendar_event_id}`);
  }

  // ── 7. Summary ─────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════════════');
  console.log('  📋  Summary');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Psychologist: ${PSYCHOLOGIST_EMAIL} (${psychologistId})`);
  console.log(`  Client:       ${CLIENT_EMAIL} (${clientId})`);
  console.log(`  Session:      ${session.id}`);
  console.log(`  Meet link:    ${updatedSession?.google_meet_link || 'FAILED'}`);
  console.log(`  Processed:    ${result.processed}, Skipped: ${result.skipped}, Errors: ${result.errors}`);
  console.log('═══════════════════════════════════════════════════\n');

  console.log('Next steps:');
  console.log('  1. Check if you received WhatsApp messages on both phones');
  console.log('  2. Try logging in as client:');
  console.log(`     Email: ${CLIENT_EMAIL}`);
  console.log(`     Password: Welcome@${CLIENT_EMAIL.split('@')[0].slice(0, 4).toLowerCase()}`);
  console.log('  3. Try logging in as psychologist:');
  console.log(`     Email: ${PSYCHOLOGIST_EMAIL}`);
  console.log(`     Password: Welcome@${PSYCHOLOGIST_EMAIL.split('@')[0].slice(0, 4).toLowerCase()}`);

  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
