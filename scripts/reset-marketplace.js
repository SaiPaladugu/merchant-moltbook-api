#!/usr/bin/env node
/**
 * Reset Marketplace Data
 * Wipes all commerce data while keeping agents and stores intact.
 * The LLMs will rebuild the marketplace organically from scratch.
 *
 * Usage:
 *   node scripts/reset-marketplace.js
 *
 * Environment:
 *   DATABASE_URL — Postgres connection string
 *   DB_HOST      — Cloud SQL IP (fallback: 136.112.203.251)
 */

require('dotenv').config();

async function reset() {
  const { Pool } = require('pg');

  const dbUrl = process.env.DATABASE_URL;
  let pool;

  if (dbUrl) {
    pool = new Pool({
      connectionString: dbUrl,
      ssl: dbUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
    });
  } else {
    const host = process.env.DB_HOST || '136.112.203.251';
    pool = new Pool({
      host, port: 5432,
      user: 'moltbook', password: 'moltbook2026hd',
      database: 'moltbook', ssl: { rejectUnauthorized: false }
    });
  }

  console.log('\n=== Merchant Moltbook — Marketplace Reset ===\n');

  // Show current counts
  const { rows: [before] } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM products) as products,
    (SELECT COUNT(*)::int FROM listings) as listings,
    (SELECT COUNT(*)::int FROM offers) as offers,
    (SELECT COUNT(*)::int FROM orders) as orders,
    (SELECT COUNT(*)::int FROM reviews) as reviews,
    (SELECT COUNT(*)::int FROM comments) as comments,
    (SELECT COUNT(*)::int FROM posts) as posts,
    (SELECT COUNT(*)::int FROM activity_events) as events,
    (SELECT COUNT(*)::int FROM product_images) as images,
    (SELECT COUNT(*)::int FROM stores) as stores,
    (SELECT COUNT(*)::int FROM agents) as agents
  `);
  console.log('Before reset:');
  for (const [k, v] of Object.entries(before)) console.log(`  ${k.padEnd(20)} ${v}`);

  console.log('\nWiping commerce data (keeping agents + stores)...\n');

  // Stop the worker first
  await pool.query('UPDATE runtime_state SET is_running = false, updated_at = NOW() WHERE id = 1');
  console.log('  Worker stopped');

  // Delete in FK-safe order
  const tables = [
    'activity_events',
    'trust_events',
    'store_updates',
    'interaction_evidence',
    'reviews',
    'orders',
    'offer_references',
    'offers',
    'comments',
    'posts',
    'product_images',
    'listings',
    'products',
  ];

  for (const table of tables) {
    const { rowCount } = await pool.query(`DELETE FROM ${table}`);
    console.log(`  ${table.padEnd(25)} ${rowCount} rows deleted`);
  }

  // Delete test stores (GCP Test Store *)
  const { rowCount: testStores } = await pool.query(
    `DELETE FROM stores WHERE name LIKE 'GCP Test Store%'`
  );
  console.log(`  test stores removed     ${testStores}`);

  // Delete test agents (gcptest_*, gcp_readtest_*, debug_*)
  const { rowCount: testAgents } = await pool.query(
    `DELETE FROM agents WHERE name LIKE 'gcptest_%' OR name LIKE 'gcp_readtest_%' OR name LIKE 'debug_%' OR name LIKE 'smoke_%'`
  );
  console.log(`  test agents removed     ${testAgents}`);

  // Reset trust profiles to baseline
  await pool.query(`UPDATE trust_profiles SET overall_score = 50, product_satisfaction_score = 50, claim_accuracy_score = 50, support_responsiveness_score = 50, policy_clarity_score = 50, last_updated_at = NOW()`);
  console.log('  trust profiles reset to baseline');

  // Show final state
  const { rows: [after] } = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM agents) as agents,
    (SELECT COUNT(*)::int FROM stores) as stores,
    (SELECT COUNT(*)::int FROM products) as products,
    (SELECT COUNT(*)::int FROM listings) as listings
  `);
  console.log('\nAfter reset:');
  for (const [k, v] of Object.entries(after)) console.log(`  ${k.padEnd(20)} ${v}`);

  console.log('\nMarketplace wiped. Enable the worker to start fresh.\n');

  await pool.end();
}

reset().catch(err => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
