require('dotenv').config();
const { supabaseAdmin } = require('../config/supabase');

async function massiveCleanup() {
  console.log('🚀 Starting TOTAL Database Cleanup...');

  // 1. PSYCHOLOGISTS
  console.log('📦 Fetching ALL psychologists...');
  let allPsychs = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('psychologists')
      .select('id, first_name, last_name, email')
      .range(page * 1000, (page + 1) * 1000 - 1);
    
    if (error) {
      console.error('Error fetching psychs:', error.message);
      break;
    }
    if (!data || data.length === 0) break;
    
    allPsychs.push(...data);
    if (page % 5 === 0) console.log(`   Fetched ${allPsychs.length} rows...`);
    page++;
  }

  console.log(`✅ Total psychologists fetched: ${allPsychs.length}`);
  
  const psychGroups = new Map();
  allPsychs.forEach(p => {
    const key = (p.email || `${p.first_name || ''}|${p.last_name || ''}`).toLowerCase().trim();
    if (!psychGroups.has(key)) psychGroups.set(key, []);
    psychGroups.get(key).push(p.id);
  });

  let psychDeleted = 0;
  for (const [key, ids] of psychGroups.entries()) {
    if (ids.length > 1) {
      const keepId = ids[0];
      const dupIds = ids.slice(1);
      
      // Process in batches of 100 to avoid long URLs/payloads
      for (let i = 0; i < dupIds.length; i += 100) {
        const batch = dupIds.slice(i, i + 100);
        await supabaseAdmin.from('sessions').update({ psychologist_id: keepId }).in('psychologist_id', batch);
        const { error } = await supabaseAdmin.from('psychologists').delete().in('id', batch);
        if (!error) psychDeleted += batch.length;
      }
    }
  }

  // 2. CLIENTS
  console.log('📦 Fetching ALL clients...');
  let allClients = [];
  page = 0;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from('clients')
      .select('id, user_id')
      .range(page * 1000, (page + 1) * 1000 - 1);
    
    if (error) break;
    if (!data || data.length === 0) break;
    allClients.push(...data);
    page++;
  }

  console.log(`✅ Total clients fetched: ${allClients.length}`);
  
  const clientGroups = new Map();
  allClients.forEach(c => {
    const key = c.user_id;
    if (!clientGroups.has(key)) clientGroups.set(key, []);
    clientGroups.get(key).push(c.id);
  });

  let clientDeleted = 0;
  for (const [userId, ids] of clientGroups.entries()) {
    if (ids.length > 1) {
      const keepId = ids[0];
      const dupIds = ids.slice(1);
      for (let i = 0; i < dupIds.length; i += 100) {
        const batch = dupIds.slice(i, i + 100);
        await supabaseAdmin.from('sessions').update({ client_id: keepId }).in('client_id', batch);
        const { error } = await supabaseAdmin.from('clients').delete().in('id', batch);
        if (!error) clientDeleted += batch.length;
      }
    }
  }

  console.log(`\n🏁 FINAL TOTALS:`);
  console.log(`   Psychologists deleted: ${psychDeleted}`);
  console.log(`   Clients deleted: ${clientDeleted}`);
}

massiveCleanup().catch(console.error);
