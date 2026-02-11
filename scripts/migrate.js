/**
 * Migration Runner
 * 
 * Reads SQL files from scripts/migrations/ in order,
 * tracks applied migrations in a schema_migrations table,
 * and runs each inside a transaction using client.query()
 * (NOT pool-level query) to ensure atomicity.
 * 
 * Usage: npm run db:migrate
 */

const fs = require('fs');
const path = require('path');
const { initializePool, close } = require('../src/config/database');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getAppliedMigrations(client) {
  const result = await client.query('SELECT filename FROM schema_migrations ORDER BY id');
  return new Set(result.rows.map(r => r.filename));
}

async function getMigrationFiles() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
  return files;
}

async function runMigration(pool, filename) {
  const filePath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(filePath, 'utf8');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Run the migration SQL using client.query (transactional)
    await client.query(sql);

    // Record it
    await client.query(
      'INSERT INTO schema_migrations (filename) VALUES ($1)',
      [filename]
    );

    await client.query('COMMIT');
    console.log(`  ✓ ${filename}`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`  ✗ ${filename}: ${error.message}`);
    throw error;
  } finally {
    client.release();
  }
}

async function migrate() {
  console.log('Running migrations...\n');

  const pool = initializePool();
  if (!pool) {
    console.error('DATABASE_URL not set. Cannot run migrations.');
    process.exit(1);
  }

  // Ensure schema_migrations table exists (outside transaction)
  const setupClient = await pool.connect();
  try {
    await ensureMigrationsTable(setupClient);
  } finally {
    setupClient.release();
  }

  // Get already-applied migrations
  const checkClient = await pool.connect();
  let applied;
  try {
    applied = await getAppliedMigrations(checkClient);
  } finally {
    checkClient.release();
  }

  // Get migration files
  const files = await getMigrationFiles();
  const pending = files.filter(f => !applied.has(f));

  if (pending.length === 0) {
    console.log('No pending migrations.\n');
    await close();
    return;
  }

  console.log(`Found ${pending.length} pending migration(s):\n`);

  for (const file of pending) {
    await runMigration(pool, file);
  }

  console.log(`\nDone. ${pending.length} migration(s) applied.\n`);
  await close();
}

migrate().catch((err) => {
  console.error('\nMigration failed:', err.message);
  close().then(() => process.exit(1));
});
