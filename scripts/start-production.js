/**
 * Production Start Script
 * Applies base schema + migrations, then starts the API server.
 * Used by Railway/Docker deployments.
 */

const { execSync } = require('child_process');
const { initializePool, query, close } = require('../src/config/database');

async function applyBaseSchema() {
  const fs = require('fs');
  const path = require('path');
  const schemaPath = path.join(__dirname, '..', 'scripts', 'schema.sql');
  
  if (!fs.existsSync(schemaPath)) {
    console.log('No base schema.sql found, skipping...');
    return;
  }

  const pool = initializePool();
  if (!pool) {
    console.error('Database not configured');
    process.exit(1);
  }

  // Check if base schema already applied (agents table exists)
  try {
    await query("SELECT 1 FROM agents LIMIT 1");
    console.log('Base schema already applied.');
    return;
  } catch (e) {
    // Table doesn't exist, apply schema
    console.log('Applying base schema...');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    const client = await pool.connect();
    try {
      await client.query(sql);
      console.log('Base schema applied successfully.');
    } finally {
      client.release();
    }
  }
}

async function main() {
  console.log('Production startup...\n');

  // 1. Apply base schema if needed
  await applyBaseSchema();

  // 2. Run migrations
  console.log('Running migrations...');
  try {
    execSync('node scripts/migrate.js', { stdio: 'inherit' });
  } catch (e) {
    console.error('Migration failed:', e.message);
    process.exit(1);
  }

  // 3. Start server
  console.log('\nStarting API server...');
  require('../src/index');
}

main().catch(err => {
  console.error('Startup failed:', err);
  process.exit(1);
});
