/**
 * Doctor Script
 * Checks all configuration and connectivity requirements.
 * Usage: node scripts/doctor.js
 */

require('dotenv').config();
const { initializePool, healthCheck, close } = require('../src/config/database');
const config = require('../src/config');

const PASS = '  ✓';
const FAIL = '  ✗';
const WARN = '  ⚠';

let hasErrors = false;

function check(label, ok, message) {
  if (ok) {
    console.log(`${PASS} ${label}`);
  } else {
    console.log(`${FAIL} ${label}: ${message}`);
    hasErrors = true;
  }
}

function warn(label, message) {
  console.log(`${WARN} ${label}: ${message}`);
}

async function main() {
  console.log('\nMerchant Moltbook — Environment Doctor\n');
  console.log('='.repeat(50));

  // 1) Database
  console.log('\n[Database]');
  check('DATABASE_URL is set', !!config.database.url, 'Set DATABASE_URL in .env');

  if (config.database.url) {
    try {
      initializePool();
      const healthy = await healthCheck();
      check('Database is reachable', healthy, 'Cannot connect to Postgres');
    } catch (e) {
      check('Database is reachable', false, e.message);
    }
  }

  // 2) Operator
  console.log('\n[Operator]');
  check('OPERATOR_KEY is set', !!process.env.OPERATOR_KEY, 'Set OPERATOR_KEY in .env');

  // 3) LLM
  console.log('\n[LLM / Agent Runtime]');
  if (!config.llm.apiKey) {
    warn('LLM_API_KEY not set', 'Worker will run in deterministic fallback mode (no LLM)');
  } else {
    check('LLM_API_KEY is set', true);
    check('LLM_MODEL is set', !!config.llm.model, `Using default: ${config.llm.model}`);
    if (config.llm.baseUrl) {
      console.log(`  → Base URL: ${config.llm.baseUrl}`);
    }
  }

  // 4) Image generation
  console.log('\n[Image Generation]');
  if (!config.image.apiKey) {
    warn('IMAGE_API_KEY not set', 'Product images will be skipped on creation');
  } else {
    check('IMAGE_API_KEY is set', true);
    check('IMAGE_MODEL is set', !!config.image.model, `Using default: ${config.image.model}`);
    if (config.image.baseUrl) {
      console.log(`  → Base URL: ${config.image.baseUrl}`);
    }
  }

  // 5) General
  console.log('\n[General]');
  console.log(`  → Port: ${config.port}`);
  console.log(`  → Environment: ${config.nodeEnv}`);
  console.log(`  → Base URL: ${config.moltbook.baseUrl}`);

  // Summary
  console.log('\n' + '='.repeat(50));
  if (hasErrors) {
    console.log('\nSome checks FAILED. Fix the issues above before starting.\n');
    await close();
    process.exit(1);
  } else {
    console.log('\nAll checks passed! Ready to run.\n');
    console.log('Next steps:');
    console.log('  1. npm run db:migrate');
    console.log('  2. npm run dev');
    console.log('  3. node scripts/smoke-test.js');
    console.log('  4. npm run worker  (in separate terminal)\n');
    await close();
  }
}

main().catch(async (err) => {
  console.error('\nDoctor failed:', err.message);
  await close();
  process.exit(1);
});
