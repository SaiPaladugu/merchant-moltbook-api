/**
 * Shared Test Library
 * Consistent helpers for all test scripts.
 * 
 * Usage: const t = require('./_testlib');
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const OPERATOR_KEY = process.env.OPERATOR_KEY || 'local-operator-key';

// Load seed data if available
let SEED = null;
const seedPath = path.join(process.cwd(), '.local', 'seed_keys.json');
if (fs.existsSync(seedPath)) {
  SEED = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
}

// Counters
let _passed = 0;
let _failed = 0;
let _skipped = 0;
const _failures = [];

// ─── HTTP Helpers ────────────────────────────────────────

async function req(method, urlPath, body, headers = {}) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${urlPath}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function auth(apiKey) { return { Authorization: `Bearer ${apiKey}` }; }
function opAuth() { return { Authorization: `Bearer ${OPERATOR_KEY}` }; }

// ─── Assertion Helpers ───────────────────────────────────

function assert(name, condition, detail) {
  if (condition) {
    console.log(`    ✓ ${name}`);
    _passed++;
  } else {
    console.log(`    ✗ ${name}${detail ? ': ' + detail : ''}`);
    _failed++;
    _failures.push(name);
  }
  return condition;
}

function skip(name, reason) {
  console.log(`    ⊘ ${name}: ${reason}`);
  _skipped++;
}

function group(name) {
  console.log(`\n  [${name}]`);
}

// ─── Deep Scan ───────────────────────────────────────────

/**
 * Recursively scan an object for forbidden keys.
 * Returns array of found key paths.
 */
function deepScanKeys(obj, forbiddenKeys, prefix = '') {
  const found = [];
  if (!obj || typeof obj !== 'object') return found;
  for (const [key, val] of Object.entries(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (forbiddenKeys.includes(key)) {
      found.push(fullPath);
    }
    if (val && typeof val === 'object') {
      found.push(...deepScanKeys(val, forbiddenKeys, fullPath));
    }
  }
  return found;
}

// ─── Summary ─────────────────────────────────────────────

function summary(title) {
  console.log('\n' + '='.repeat(55));
  console.log(`\n  ${title || 'Results'}: ${_passed} passed, ${_failed} failed, ${_skipped} skipped`);
  if (_failures.length > 0) {
    console.log(`\n  Failures:`);
    _failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log('');
  return { passed: _passed, failed: _failed, skipped: _skipped, failures: _failures };
}

function exitWithResults() {
  process.exit(_failed > 0 ? 1 : 0);
}

// ─── Wait for API ────────────────────────────────────────

async function waitForHealth(maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const res = await fetch(`${API}/health`);
      if (res.ok) return true;
    } catch (e) { /* not ready */ }
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

module.exports = {
  API, BASE, OPERATOR_KEY, SEED,
  req, auth, opAuth,
  assert, skip, group,
  deepScanKeys,
  summary, exitWithResults,
  waitForHealth
};
