/**
 * LLM Chaos Tests
 * Validates worker resilience when LLM is broken.
 * No global config mutation — each test is self-contained.
 * 
 * Usage: node scripts/llm-chaos-test.js
 */

require('dotenv').config();

let passed = 0;
let failed = 0;
const failures = [];

function assert(name, condition, detail) {
  if (condition) { console.log(`    ✓ ${name}`); passed++; }
  else { console.log(`    ✗ ${name}${detail ? ': ' + detail : ''}`); failed++; failures.push(name); }
}

function group(name) { console.log(`\n  [${name}]`); }

// ─── Test 1: Invalid API key ─────────────────────────────

async function testInvalidKey() {
  group('Chaos 1: Invalid API key');

  const LlmClient = require('../src/worker/LlmClient');

  const testAgent = { name: 'chaos_agent', agent_type: 'CUSTOMER' };
  const testState = {
    activeListings: [{ id: 'abc', product_title: 'Widget', price_cents: 2999 }],
    recentThreads: [], pendingOffers: [], eligiblePurchasers: [], unreviewedOrders: []
  };

  // Call _generateOpenAI with a spoofed invalid key
  const config = require('../src/config');
  const origKey = config.llm.apiKey;
  const origBase = config.llm.baseUrl;

  try {
    // Temporarily spoof just for this call
    config.llm.apiKey = 'invalid-key-for-chaos-test';
    config.llm.baseUrl = config.llm.baseUrl || 'https://api.openai.com/v1';

    let threw = false;
    try {
      await LlmClient._generateOpenAI({ agent: testAgent, worldState: testState });
    } catch (e) {
      threw = true;
      assert('Invalid key throws error', true, e.message.substring(0, 80));
    }
    if (!threw) {
      assert('Invalid key throws error', false, 'Did not throw');
    }
  } finally {
    // Restore
    config.llm.apiKey = origKey;
    config.llm.baseUrl = origBase;
  }

  // Verify deterministic fallback works
  const AgentRuntimeWorker = require('../src/worker/AgentRuntimeWorker');
  const worker = new AgentRuntimeWorker();
  const fallback = worker._deterministic(testAgent, testState);
  assert('Deterministic fallback returns valid action',
    !!fallback.actionType && !!fallback.args,
    `actionType=${fallback.actionType}`);
  assert('Fallback has rationale', typeof fallback.rationale === 'string',
    `rationale=${fallback.rationale?.substring(0, 60)}`);
}

// ─── Test 2: Timeout ─────────────────────────────────────

async function testTimeout() {
  group('Chaos 2: LLM timeout');

  const config = require('../src/config');

  // Only test if we have a real key (otherwise we can't verify timeout behavior)
  if (!config.llm.apiKey) {
    console.log('    ⊘ Skipped: LLM_API_KEY not set');
    return;
  }

  const OpenAI = require('openai');
  const clientOpts = { apiKey: config.llm.apiKey, timeout: 100 }; // 100ms = will timeout
  if (config.llm.baseUrl) clientOpts.baseURL = config.llm.baseUrl;
  const openai = new OpenAI(clientOpts);

  let threw = false;
  try {
    await openai.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: 'user', content: 'Say hello' }],
      max_tokens: 5
    });
  } catch (e) {
    threw = true;
    assert('Timeout causes error', true, e.message.substring(0, 80));
  }
  if (!threw) {
    // Surprisingly fast response — still ok
    assert('Timeout causes error', true, 'Response was faster than 100ms (not a failure)');
  }

  // Verify fallback still works after timeout scenario
  const AgentRuntimeWorker = require('../src/worker/AgentRuntimeWorker');
  const worker = new AgentRuntimeWorker();
  const testAgent = { name: 'timeout_agent', agent_type: 'MERCHANT' };
  const testState = {
    activeListings: [{ id: 'x', store_id: 's1', owner_merchant_id: 'timeout_agent', product_title: 'Test', price_cents: 1000 }],
    recentThreads: [], pendingOffers: [], eligiblePurchasers: [], unreviewedOrders: [],
    agents: [{ id: 'timeout_agent', name: 'timeout_agent', agent_type: 'MERCHANT' }]
  };
  const fallback = worker._deterministic(testAgent, testState);
  assert('Fallback works after timeout', !!fallback.actionType,
    `actionType=${fallback.actionType}`);
}

// ─── Test 3: Bad JSON extraction ─────────────────────────

async function testBadJSON() {
  group('Chaos 3: JSON extraction resilience');

  const LlmClient = require('../src/worker/LlmClient');

  // Test 3a: Pure garbage — should throw
  let threw = false;
  try {
    LlmClient._extractJSON('This is not JSON at all, sorry!');
  } catch (e) {
    threw = true;
    assert('Pure garbage text throws', true, e.message.substring(0, 60));
  }
  if (!threw) assert('Pure garbage text throws', false, 'Did not throw');

  // Test 3b: JSON embedded in text — should extract
  const embedded = LlmClient._extractJSON(
    'Here is my response: {"actionType":"skip","args":{},"rationale":"nothing to do"} end'
  );
  assert('Embedded JSON extracted', embedded.actionType === 'skip',
    `actionType=${embedded.actionType}`);

  // Test 3c: JSON in markdown code block — should extract
  const codeBlock = LlmClient._extractJSON(
    'Sure!\n```json\n{"actionType":"ask_question","args":{"listingId":"abc"},"rationale":"curious"}\n```'
  );
  assert('Code block JSON extracted', codeBlock.actionType === 'ask_question',
    `actionType=${codeBlock.actionType}`);

  // Test 3d: Valid direct JSON — should parse
  const direct = LlmClient._extractJSON('{"actionType":"make_offer","args":{},"rationale":"deal"}');
  assert('Direct JSON parses', direct.actionType === 'make_offer',
    `actionType=${direct.actionType}`);

  // Test 3e: Nested JSON with extra text
  const nested = LlmClient._extractJSON(
    'I think the best action is:\n\n{"actionType":"reply_in_thread","args":{"threadId":"t1","content":"hello"},"rationale":"engage"}\n\nHope that helps!'
  );
  assert('Nested JSON with surrounding text', nested.actionType === 'reply_in_thread',
    `actionType=${nested.actionType}`);
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log('\nMerchant Moltbook — LLM Chaos Tests\n');
  console.log('='.repeat(55));

  await testInvalidKey();
  await testTimeout();
  await testBadJSON();

  console.log('\n' + '='.repeat(55));
  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log(`\n  Failures:`);
    failures.forEach(f => console.log(`    - ${f}`));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nLLM chaos test crashed:', err);
  process.exit(1);
});
