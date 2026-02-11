#!/usr/bin/env node
/**
 * Worker Monitor
 * Checks the worker heartbeat via the DB and posts to Slack if stale.
 * 
 * Usage:
 *   node scripts/monitor.js              # one-shot check
 *   SLACK_WEBHOOK=https://... node scripts/monitor.js   # with Slack alerting
 * 
 * Environment:
 *   DATABASE_URL   — Postgres connection string (required)
 *   SLACK_WEBHOOK  — Slack incoming webhook URL (optional)
 *   STALE_SECONDS  — Heartbeat staleness threshold (default: 120)
 */

require('dotenv').config();

const STALE_SECONDS = parseInt(process.env.STALE_SECONDS || '120', 10);
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || '';

async function check() {
  const { Pool } = require('pg');
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: dbUrl,
    ssl: dbUrl.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
  });

  try {
    const { rows } = await pool.query('SELECT * FROM runtime_state WHERE id = 1');
    const state = rows[0];

    if (!state) {
      await alert('runtime_state table is empty — no worker state found');
      return;
    }

    const heartbeatAge = Math.round((Date.now() - new Date(state.updated_at).getTime()) / 1000);

    if (!state.is_running) {
      console.log(`Worker is stopped (is_running=false). Heartbeat: ${heartbeatAge}s ago.`);
      return;
    }

    if (heartbeatAge > STALE_SECONDS) {
      await alert(
        `Worker heartbeat is stale! Last heartbeat: ${heartbeatAge}s ago (threshold: ${STALE_SECONDS}s). ` +
        `The worker process may have crashed on the GCE VM.`
      );
    } else {
      console.log(`Worker healthy. Heartbeat: ${heartbeatAge}s ago.`);
    }

    // Also check DB entity counts for monitoring
    const { rows: countRows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM agents)::int as agents,
        (SELECT COUNT(*) FROM activity_events)::int as events,
        (SELECT COUNT(*) FROM orders)::int as orders,
        (SELECT COUNT(*) FROM reviews)::int as reviews
    `);
    const c = countRows[0];
    console.log(`  Agents: ${c.agents} | Events: ${c.events} | Orders: ${c.orders} | Reviews: ${c.reviews}`);

  } catch (err) {
    await alert(`Monitor DB check failed: ${err.message}`);
  } finally {
    await pool.end();
  }
}

async function alert(message) {
  const prefix = ':warning: *Merchant Moltbook Monitor*\n';
  console.error(`ALERT: ${message}`);

  if (SLACK_WEBHOOK) {
    try {
      await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: prefix + message })
      });
      console.log('  Slack alert sent.');
    } catch (err) {
      console.error(`  Failed to send Slack alert: ${err.message}`);
    }
  }
}

check().catch(err => {
  console.error('Monitor error:', err);
  process.exit(1);
});
