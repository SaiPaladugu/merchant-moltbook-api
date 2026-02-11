/**
 * LLM + Image Proxy Connectivity Test
 * Tests the Shopify proxy directly to verify what parameters it supports.
 * 
 * Usage: node scripts/test-llm.js
 */

require('dotenv').config();
const config = require('../src/config');

async function testChatCompletion() {
  console.log('\n[Chat Completion]');

  if (!config.llm.apiKey) {
    console.log('  ⚠ LLM_API_KEY not set — skipping');
    return false;
  }

  const OpenAI = require('openai');
  const clientOpts = { apiKey: config.llm.apiKey, timeout: 30000 };
  if (config.llm.baseUrl) {
    clientOpts.baseURL = config.llm.baseUrl;
    console.log(`  → Base URL: ${config.llm.baseUrl}`);
  }
  console.log(`  → Model: ${config.llm.model}`);

  const openai = new OpenAI(clientOpts);

  // Test 1: With response_format
  console.log('\n  Test 1: Chat with response_format: json_object');
  try {
    const res = await openai.chat.completions.create({
      model: config.llm.model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Respond with JSON only.' },
        { role: 'user', content: 'Return a JSON object with key "status" set to "ok" and key "number" set to 42.' }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 100,
      temperature: 0
    });
    const content = res.choices[0]?.message?.content;
    console.log(`  ✓ Response: ${content}`);
    try {
      const parsed = JSON.parse(content);
      console.log(`  ✓ Parsed JSON: status=${parsed.status}`);
    } catch (e) {
      console.log(`  ⚠ Response is not valid JSON: ${e.message}`);
    }
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
    console.log('  → Trying without response_format...');

    // Test 2: Without response_format
    try {
      const res = await openai.chat.completions.create({
        model: config.llm.model,
        messages: [
          { role: 'system', content: 'You are a helpful assistant. Respond with JSON only, no other text.' },
          { role: 'user', content: 'Return a JSON object with key "status" set to "ok" and key "number" set to 42.' }
        ],
        max_tokens: 100,
        temperature: 0
      });
      const content = res.choices[0]?.message?.content;
      console.log(`  ✓ Response (no format): ${content}`);
      try {
        const parsed = JSON.parse(content);
        console.log(`  ✓ Parsed JSON: status=${parsed.status}`);
      } catch (e) {
        // Try extracting JSON from text
        const match = content.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          console.log(`  ✓ Extracted JSON: status=${parsed.status}`);
        } else {
          console.log(`  ✗ Could not extract JSON from response`);
        }
      }
    } catch (e2) {
      console.log(`  ✗ Also failed without format: ${e2.message}`);
      return false;
    }
  }

  // Test 3: Agent-style prompt (matches what the worker sends)
  console.log('\n  Test 3: Agent action prompt (worker-style)');
  try {
    const res = await openai.chat.completions.create({
      model: config.llm.model,
      messages: [
        { role: 'system', content: 'You are an AI customer agent. Respond with JSON only containing: actionType, args, rationale.' },
        { role: 'user', content: 'Active listings: [{"id":"abc","product_title":"Widget","price_cents":2999}]. What action should test_agent take? Respond with JSON only.' }
      ],
      max_tokens: 300,
      temperature: 0.8
    });
    const content = res.choices[0]?.message?.content;
    console.log(`  ✓ Response: ${content?.substring(0, 200)}`);

    // Try parsing
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      const match = content.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }
    if (parsed?.actionType) {
      console.log(`  ✓ actionType: ${parsed.actionType}`);
      console.log(`  ✓ rationale: ${parsed.rationale || '(none)'}`);
    } else {
      console.log(`  ⚠ No actionType in response`);
    }
  } catch (e) {
    console.log(`  ✗ Agent prompt failed: ${e.message}`);
  }

  return true;
}

async function testImageGeneration() {
  console.log('\n[Image Generation]');

  if (!config.image.apiKey) {
    console.log('  ⚠ IMAGE_API_KEY not set — skipping');
    return false;
  }

  const OpenAI = require('openai');
  const clientOpts = { apiKey: config.image.apiKey };
  if (config.image.baseUrl) {
    clientOpts.baseURL = config.image.baseUrl;
    console.log(`  → Base URL: ${config.image.baseUrl}`);
  }
  console.log(`  → Model: ${config.image.model}`);

  const openai = new OpenAI(clientOpts);

  const baseParams = {
    model: config.image.model,
    prompt: 'A simple red circle on a white background, minimalist',
    n: 1,
    size: config.image.size
  };

  // Strategy 1: No response_format (default = URL)
  console.log('\n  Test 1: Image gen with default params (no response_format)');
  try {
    const res = await openai.images.generate(baseParams);
    const url = res.data[0]?.url;
    const b64 = res.data[0]?.b64_json;
    if (url) {
      console.log(`  ✓ Got URL: ${url.substring(0, 100)}...`);
      return true;
    }
    if (b64) {
      console.log(`  ✓ Got b64_json (${b64.length} chars)`);
      return true;
    }
    console.log(`  ⚠ Response had no url or b64_json`);
    console.log(`  → Raw: ${JSON.stringify(res.data[0]).substring(0, 200)}`);
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
  }

  // Strategy 2: With response_format=url
  console.log('\n  Test 2: Image gen with response_format=url');
  try {
    const res = await openai.images.generate({ ...baseParams, response_format: 'url' });
    const url = res.data[0]?.url;
    if (url) {
      console.log(`  ✓ Got URL: ${url.substring(0, 100)}...`);
      return true;
    }
    console.log('  ⚠ No URL in response');
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
  }

  // Strategy 3: With response_format=b64_json
  console.log('\n  Test 3: Image gen with response_format=b64_json');
  try {
    const res = await openai.images.generate({ ...baseParams, response_format: 'b64_json' });
    const b64 = res.data[0]?.b64_json;
    if (b64) {
      console.log(`  ✓ Got b64_json (${b64.length} chars)`);
      return true;
    }
    console.log('  ⚠ No b64_json in response');
  } catch (e) {
    console.log(`  ✗ Failed: ${e.message}`);
  }

  console.log('\n  ✗ All image strategies failed');
  return false;
}

async function main() {
  console.log('\nMerchant Moltbook — LLM + Image Proxy Test\n');
  console.log('='.repeat(50));

  const chatOk = await testChatCompletion();
  const imageOk = await testImageGeneration();

  console.log('\n' + '='.repeat(50));
  console.log('\nResults:');
  console.log(`  Chat completion: ${chatOk ? '✓ WORKING' : '✗ FAILED or SKIPPED'}`);
  console.log(`  Image generation: ${imageOk ? '✓ WORKING' : '✗ FAILED or SKIPPED'}`);

  if (!chatOk) {
    console.log('\n  Note: Worker will use deterministic fallback without LLM.');
  }
  if (!imageOk) {
    console.log('  Note: Product images will be skipped on creation.');
  }
  console.log('');
}

main().catch(err => {
  console.error('Test crashed:', err);
  process.exit(1);
});
