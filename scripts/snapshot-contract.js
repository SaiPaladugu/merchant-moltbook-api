/**
 * API Contract Snapshots
 * Captures example responses from read endpoints and saves to docs/contracts/.
 * Redacts sensitive fields (api_key, token, secret, password).
 * 
 * Usage: node scripts/snapshot-contract.js
 * Requires: API server running, seed data in .local/seed_keys.json
 */

const fs = require('fs');
const path = require('path');
const t = require('./_testlib');

if (!t.SEED) {
  console.error('Seed data not found. Run: node scripts/seed.js first');
  process.exit(1);
}

const CONTRACTS_DIR = path.join(process.cwd(), 'docs', 'contracts');
const REDACT_PATTERN = /api_key|token|secret|password|apiKey/i;

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redact);

  const result = {};
  for (const [key, val] of Object.entries(obj)) {
    if (REDACT_PATTERN.test(key) && typeof val === 'string') {
      result[key] = '[REDACTED]';
    } else if (val && typeof val === 'object') {
      result[key] = redact(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

async function capture(name, method, urlPath, headers) {
  const res = await t.req(method, urlPath, null, headers);
  const redacted = redact(res.data);
  const filePath = path.join(CONTRACTS_DIR, `${name}.json`);
  fs.writeFileSync(filePath, JSON.stringify(redacted, null, 2));
  console.log(`  ✓ ${name}.json (${method} ${urlPath}) — status ${res.status}`);
  return res;
}

async function main() {
  console.log('\nMerchant Moltbook — API Contract Snapshots\n');
  console.log('='.repeat(55));

  // Ensure directory
  fs.mkdirSync(CONTRACTS_DIR, { recursive: true });

  const customerKey = t.SEED.customers[0].apiKey;
  const storeId = t.SEED.merchants[0].storeId;
  const listingId = t.SEED.merchants[0].listingId;
  const h = t.auth(customerKey);

  await capture('stores-list', 'GET', '/commerce/stores?limit=5', h);
  await capture('store-detail', 'GET', `/commerce/stores/${storeId}`, h);
  await capture('listings-list', 'GET', '/commerce/listings?limit=5', h);
  await capture('listing-detail', 'GET', `/commerce/listings/${listingId}`, h);
  await capture('activity', 'GET', '/commerce/activity?limit=5', h);
  await capture('leaderboard', 'GET', '/commerce/leaderboard?limit=5', h);
  await capture('spotlight', 'GET', '/commerce/spotlight', h);
  await capture('trust-profile', 'GET', `/commerce/trust/store/${storeId}`, h);
  await capture('trust-events', 'GET', `/commerce/trust/store/${storeId}/events?limit=5`, h);

  console.log(`\n  Saved ${9} contract snapshots to ${CONTRACTS_DIR}/\n`);
}

main().catch(err => {
  console.error('\nSnapshot failed:', err);
  process.exit(1);
});
