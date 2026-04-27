const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '/Users/abhishekr/Documents/koott/koott-backend/.env' });

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkPackageSizes() {
  try {
    const { data: wixData, error } = await supabase
      .from('wix_bookings')
      .select('title, session_count');
    
    if (error) throw error;

    const sizes = {};

    wixData.forEach(row => {
      const title = (row.title || '').toLowerCase();
      let count = row.session_count;

      // If count is null, try to extract from title (e.g. "Package of 3")
      if (count === null || count === undefined) {
        const match = title.match(/(\d+)\s*sessions?/i) || title.match(/package\s*of\s*(\d+)/i);
        if (match) {
          count = parseInt(match[1]);
        }
      }

      if (count && count > 1) {
        const key = `Package of ${count}`;
        sizes[key] = (sizes[key] || 0) + 1;
      }
    });

    console.log('\n--- Wix Package Breakdown ---');
    if (Object.keys(sizes).length === 0) {
      console.log('No multi-session packages detected in Wix mirror.');
    } else {
      Object.entries(sizes).forEach(([label, total]) => {
        console.log(`${label.padEnd(20)}: ${total} bookings`);
      });
    }
    console.log('----------------------------\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkPackageSizes();
