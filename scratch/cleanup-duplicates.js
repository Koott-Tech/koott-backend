require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

/**
 * Duplicate Client Cleanup Script
 * 
 * 1. Groups clients by user_id/email.
 * 2. Picks the latest one as the 'winner'.
 * 3. Migrates all references (sessions, slot_locks, free_assessments, conversations)
 *    from 'losers' to 'winner'.
 * 4. Deletes 'losers'.
 * 
 * DRY RUN by default. Set DRY_RUN = false to apply changes.
 */

const DRY_RUN = true;

async function cleanup() {
  console.log(`🧹 Starting duplicate cleanup (${DRY_RUN ? 'DRY RUN' : 'LIVE MODE'})...\n`);

  // 1. Fetch all clients
  const { data: clients, error } = await supabaseAdmin
    .from('clients')
    .select('id, user_id, first_name, last_name, created_at, user:users(email)');

  if (error) throw error;

  const groups = {};
  clients.forEach(c => {
    const key = c.user_id || c.user?.email || 'no-key';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  });

  const duplicateGroups = Object.values(groups).filter(list => list.length > 1);
  console.log(`Found ${duplicateGroups.length} groups of duplicates.\n`);

  let totalMigrated = 0;
  let totalDeleted = 0;

  for (const group of duplicateGroups) {
    // Sort by created_at desc (latest first)
    group.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    
    const [winner, ...losers] = group;
    const loserIds = losers.map(l => l.id);
    const winnerEmail = winner.user?.email || winner.user_id;

    console.log(`Winner: ${winner.id} (${winnerEmail})`);
    console.log(`Losers (${losers.length}): ${loserIds.join(', ')}`);

    const tablesToUpdate = ['sessions', 'slot_locks', 'free_assessments', 'conversations'];
    
    for (const table of tablesToUpdate) {
      if (DRY_RUN) {
        // Just count how many rows would be updated
        const { count, error: countErr } = await supabaseAdmin
          .from(table)
          .select('id', { count: 'exact', head: true })
          .in('client_id', loserIds);
        
        if (!countErr && count > 0) {
          console.log(`   - [DRY] Would update ${count} rows in ${table}`);
          totalMigrated += count;
        }
      } else {
        const { data: upd, error: updErr } = await supabaseAdmin
          .from(table)
          .update({ client_id: winner.id })
          .in('client_id', loserIds)
          .select('id');
        
        if (updErr) {
          if (updErr.message.includes('column "client_id" does not exist')) continue;
          console.error(`   - ❌ Failed to update ${table}:`, updErr.message);
        } else if (upd && upd.length > 0) {
          console.log(`   - ✅ Updated ${upd.length} rows in ${table}`);
          totalMigrated += upd.length;
        }
      }
    }

    if (DRY_RUN) {
      console.log(`   - [DRY] Would delete ${losers.length} rows from clients`);
    } else {
      const { error: delErr } = await supabaseAdmin
        .from('clients')
        .delete()
        .in('id', loserIds);
      
      if (delErr) {
        console.error(`   - ❌ Failed to delete losers from clients:`, delErr.message);
      } else {
        console.log(`   - ✅ Deleted ${losers.length} duplicate client rows`);
      }
    }
    totalDeleted += losers.length;
    console.log('');
  }

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Final Summary (${DRY_RUN ? 'DRY RUN' : 'LIVE'}):`);
  console.log(`   - References migrated: ${totalMigrated}`);
  console.log(`   - Duplicates removed:  ${totalDeleted}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  
  if (DRY_RUN) {
    console.log(`\n👉 Set DRY_RUN = false in the script to apply these changes.`);
  }
}

cleanup().catch(err => console.error('Fatal cleanup error:', err));
