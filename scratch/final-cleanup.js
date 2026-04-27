require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

const DRY_RUN = false; // Set to true to just see what would happen

async function cleanup() {
  console.log(`🧹 Starting database cleanup (DRY_RUN=${DRY_RUN})...`);

  // 1. CLEANUP PSYCHOLOGISTS
  console.log('\n🧠 Cleaning up psychologists...');
  const { data: psychs } = await supabaseAdmin
    .from('psychologists')
    .select('id, first_name, last_name, email')
    .order('created_at', { ascending: true });

  const psychGroups = new Map();
  psychs.forEach(p => {
    const key = (p.email || `${p.first_name}|${p.last_name}`).toLowerCase();
    if (!psychGroups.has(key)) psychGroups.set(key, []);
    psychGroups.get(key).push(p.id);
  });

  let psychDeleted = 0;
  for (const [key, ids] of psychGroups.entries()) {
    if (ids.length > 1) {
      const keepId = ids[0];
      const dupIds = ids.slice(1);
      console.log(`   - Found ${ids.length} entries for "${key}". Keeping ${keepId}, merging ${dupIds.length} duplicates.`);
      
      if (!DRY_RUN) {
        // Update sessions to point to the kept psychologist
        const { error: updateErr } = await supabaseAdmin
          .from('sessions')
          .update({ psychologist_id: keepId })
          .in('psychologist_id', dupIds);
        
        if (updateErr) console.error(`     ❌ Failed to update sessions for ${key}:`, updateErr.message);

        // Delete duplicates
        const { error: delErr } = await supabaseAdmin
          .from('psychologists')
          .delete()
          .in('id', dupIds);
          
        if (delErr) console.error(`     ❌ Failed to delete psychologist duplicates for ${key}:`, delErr.message);
        else psychDeleted += dupIds.length;
      }
    }
  }

  // 2. CLEANUP CLIENTS
  console.log('\n👤 Cleaning up clients...');
  const { data: clients } = await supabaseAdmin
    .from('clients')
    .select('id, user_id')
    .order('created_at', { ascending: true });

  const clientGroups = new Map();
  clients.forEach(c => {
    const key = c.user_id;
    if (!clientGroups.has(key)) clientGroups.set(key, []);
    clientGroups.get(key).push(c.id);
  });

  let clientDeleted = 0;
  for (const [userId, ids] of clientGroups.entries()) {
    if (ids.length > 1) {
      const keepId = ids[0];
      const dupIds = ids.slice(1);
      console.log(`   - User ${userId} has ${ids.length} client rows. Keeping ${keepId}, merging ${dupIds.length} duplicates.`);
      
      if (!DRY_RUN) {
        // Update sessions
        const { error: updateErr } = await supabaseAdmin
          .from('sessions')
          .update({ client_id: keepId })
          .in('client_id', dupIds);
        
        if (updateErr) console.error(`     ❌ Failed to update sessions for user ${userId}:`, updateErr.message);

        // Delete duplicates
        const { error: delErr } = await supabaseAdmin
          .from('clients')
          .delete()
          .in('id', dupIds);
          
        if (delErr) console.error(`     ❌ Failed to delete client duplicates for user ${userId}:`, delErr.message);
        else clientDeleted += dupIds.length;
      }
    }
  }

  console.log(`\n✅ Cleanup complete!`);
  console.log(`   Psychologists deleted: ${psychDeleted}`);
  console.log(`   Clients deleted: ${clientDeleted}`);
}

cleanup().catch(console.error);
