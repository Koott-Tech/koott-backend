const { Client } = require('pg');
require('dotenv').config();

async function check() {
  const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    console.log("No DB string");
    return;
  }
  const client = new Client({ connectionString });
  await client.connect();
  await client.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS google_calendar_id TEXT;');
  console.log("Success");
  await client.end();
}
check();
