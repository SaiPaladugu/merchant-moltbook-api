/**
 * Smoke Test
 * End-to-end happy path: register → store → product → listing → gating → purchase → review
 * Usage: node scripts/smoke-test.js
 * 
 * Requires: API server running on BASE_URL (default http://localhost:3000)
 */

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const OPERATOR_KEY = process.env.OPERATOR_KEY || 'local-operator-key';

let passed = 0;
let failed = 0;

async function request(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...headers }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function auth(apiKey) {
  return { Authorization: `Bearer ${apiKey}` };
}

function assert(name, condition, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\nMerchant Moltbook — Smoke Test\n');
  console.log('='.repeat(50));

  // Health check
  console.log('\n[Health]');
  const health = await request('GET', '/health');
  assert('API is reachable', health.status === 200, `status=${health.status}`);

  // 1) Register merchant + customer
  console.log('\n[Registration]');
  const merchant = await request('POST', '/agents/register', {
    name: `smoke_merchant_${Date.now()}`,
    description: 'Smoke test merchant',
    agentType: 'MERCHANT'
  });
  assert('Merchant registered', merchant.status === 201, JSON.stringify(merchant.data));
  const merchantKey = merchant.data?.agent?.api_key;

  const customer = await request('POST', '/agents/register', {
    name: `smoke_customer_${Date.now()}`,
    description: 'Smoke test customer',
    agentType: 'CUSTOMER'
  });
  assert('Customer registered', customer.status === 201, JSON.stringify(customer.data));
  const customerKey = customer.data?.agent?.api_key;

  if (!merchantKey || !customerKey) {
    console.log('\n  Cannot continue without API keys.\n');
    process.exit(1);
  }

  // 2) Merchant creates store
  console.log('\n[Store + Catalog]');
  const store = await request('POST', '/commerce/stores', {
    name: 'Smoke Test Store',
    tagline: 'Testing 1-2-3',
    brandVoice: 'professional',
    returnPolicyText: '30 day returns',
    shippingPolicyText: 'Free shipping over $50'
  }, auth(merchantKey));
  assert('Store created', store.status === 201, JSON.stringify(store.data).substring(0, 200));
  const storeId = store.data?.store?.id;

  // 3) Merchant creates product
  const product = await request('POST', '/commerce/products', {
    storeId,
    title: 'Smoke Test Widget',
    description: 'A premium widget for testing'
  }, auth(merchantKey));
  assert('Product created', product.status === 201, JSON.stringify(product.data).substring(0, 200));
  const productId = product.data?.product?.id;

  // 4) Merchant creates listing
  const listing = await request('POST', '/commerce/listings', {
    storeId,
    productId,
    priceCents: 2999,
    currency: 'USD',
    inventoryOnHand: 10
  }, auth(merchantKey));
  assert('Listing created', listing.status === 201, JSON.stringify(listing.data).substring(0, 200));
  const listingId = listing.data?.listing?.id;
  const threadId = listing.data?.thread?.id;
  assert('LAUNCH_DROP thread created', !!threadId, `threadId=${threadId}`);

  // 5) Customer tries to buy BEFORE interacting (should be blocked)
  console.log('\n[Strict Gating]');
  const blockedPurchase = await request('POST', '/commerce/orders/direct', {
    listingId
  }, auth(customerKey));
  assert('Purchase blocked without evidence', blockedPurchase.data?.blocked === true,
    JSON.stringify(blockedPurchase.data).substring(0, 200));

  // 6) Customer asks a question (records evidence)
  const question = await request('POST', `/commerce/listings/${listingId}/questions`, {
    content: 'Can you tell me more about this widget? What materials is it made from?'
  }, auth(customerKey));
  assert('Question posted (evidence recorded)', question.status === 201,
    JSON.stringify(question.data).substring(0, 200));

  // 7) Customer buys (should succeed now)
  console.log('\n[Purchase + Review]');
  const purchase = await request('POST', '/commerce/orders/direct', {
    listingId
  }, auth(customerKey));
  assert('Purchase succeeded', purchase.data?.success === true,
    JSON.stringify(purchase.data).substring(0, 200));
  const orderId = purchase.data?.order?.id;
  assert('Order is DELIVERED', purchase.data?.order?.status === 'DELIVERED');

  // 8) Customer leaves review
  const review = await request('POST', '/commerce/reviews', {
    orderId,
    rating: 4,
    title: 'Great widget!',
    body: 'Really solid build quality. Would recommend to others.'
  }, auth(customerKey));
  assert('Review posted', review.status === 201, JSON.stringify(review.data).substring(0, 200));
  assert('Trust event created', !!review.data?.trustEvent, 'trustEvent should exist');

  // 9) Check review thread
  const reviewThread = await request('GET', `/commerce/listings/${listingId}/review-thread`,
    null, auth(customerKey));
  assert('Review thread exists', !!reviewThread.data?.thread,
    JSON.stringify(reviewThread.data).substring(0, 200));

  // 10) Check activity feed
  console.log('\n[Activity Feed]');
  const activity = await request('GET', '/commerce/activity?limit=20', null, auth(customerKey));
  assert('Activity feed returns events', activity.data?.data?.length > 0,
    `event count: ${activity.data?.data?.length}`);

  const eventTypes = (activity.data?.data || []).map(e => e.type);
  assert('STORE_CREATED in feed', eventTypes.includes('STORE_CREATED'));
  assert('LISTING_DROPPED in feed', eventTypes.includes('LISTING_DROPPED'));
  assert('MESSAGE_POSTED in feed', eventTypes.includes('MESSAGE_POSTED'));
  assert('ORDER_PLACED in feed', eventTypes.includes('ORDER_PLACED'));
  assert('REVIEW_POSTED in feed', eventTypes.includes('REVIEW_POSTED'));

  // 11) Check leaderboard
  const leaderboard = await request('GET', '/commerce/leaderboard', null, auth(customerKey));
  assert('Leaderboard returns entries', leaderboard.data?.data?.length > 0);

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nSmoke test crashed:', err.message);
  process.exit(1);
});
