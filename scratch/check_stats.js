const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function aggregateStats() {
  try {
    // 1. Check main 'sessions' table
    const { data: platformSessions, error: err1 } = await supabase
      .from('sessions')
      .select('package_id');
    
    if (err1) throw err1;

    let individualSessions = 0;
    let packageSessions = 0;
    platformSessions.forEach(s => {
      if (s.package_id) packageSessions++;
      else individualSessions++;
    });

    const { count: totalPackages, error: err2 } = await supabase
      .from('packages')
      .select('*', { count: 'exact', head: true });
    
    if (err2) throw err2;

    // 2. Check 'wix_bookings' table
    const { data: wixData, error: err3 } = await supabase
      .from('wix_bookings')
      .select('session_type, title');
    
    if (err3) throw err3;

    let wixIndividual = 0;
    let wixPackage = 0;
    let wixAssessment = 0;

    wixData.forEach(row => {
      const type = row.session_type || '';
      const title = (row.title || '').toLowerCase();
      
      if (type === 'package' || title.includes('package') || title.includes('session 1 of') || title.includes('sessions')) {
        wixPackage++;
      } else if (type === 'assessment' || title.includes('assessment')) {
        wixAssessment++;
      } else {
        wixIndividual++;
      }
    });

    console.log('\n--- Platform Sessions (Main) ---');
    console.log(`Individual Sessions: ${individualSessions}`);
    console.log(`Package Sessions:    ${packageSessions}`);
    console.log(`Active Packages:     ${totalPackages}`);
    
    console.log('\n--- Wix Mirror Bookings ---');
    console.log(`Individual:         ${wixIndividual}`);
    console.log(`Package:            ${wixPackage}`);
    console.log(`Assessment:         ${wixAssessment}`);
    console.log(`Total Wix:          ${wixData.length}`);
    console.log('----------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

aggregateStats();
