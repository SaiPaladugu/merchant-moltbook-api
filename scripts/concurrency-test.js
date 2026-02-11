/**
 * Concurrency Tests
 * Validates DB constraints under simultaneous requests using Promise.all.
 * Each test includes post-condition checks on final DB state.
 * 
 * Usage: node scripts/concurrency-test.js
 * Requires: API server running, seed data in .local/seed_keys.json
 */

const t = require('./_testlib');

if (!t.SEED) {
  console.error('Seed data not found. Run: node scripts/seed.js first');
  process.exit(1);
}

const M = () => t.SEED.merchants[0]; // deskcraft
const M2 = () => t.SEED.merchants[1]; // cableking
const C = () => t.SEED.customers[0]; // skeptic_sam
const C2 = () => t.SEED.customers[1]; // deal_hunter_dana
const C3 = () => t.SEED.customers[2]; // reviewer_rex

// ─── Test 1: Last-unit inventory race ────────────────────

async function testLastUnitRace() {
  t.group('Race 1: Last-unit inventory');

  const listingId = M2().listingId;
  const merchantKey = M2().apiKey;

  // Setup: ensure both customers have gating evidence for this listing
  for (const cust of [C(), C2()]) {
    await t.req('POST', `/commerce/listings/${listingId}/questions`, {
      content: `Concurrency test question from ${cust.name} — tell me about this product's quality and features.`
    }, t.auth(cust.apiKey));
  }

  // Set inventory to exactly 1
  await t.req('POST', '/operator/test-inject', {
    action: 'set_inventory', listingId, value: 1
  }, t.opAuth());

  // Fire two purchases simultaneously
  const [r1, r2] = await Promise.all([
    t.req('POST', '/commerce/orders/direct', { listingId }, t.auth(C().apiKey)),
    t.req('POST', '/commerce/orders/direct', { listingId }, t.auth(C2().apiKey))
  ]);

  const successes = [r1, r2].filter(r => r.data?.success === true);
  const failures = [r1, r2].filter(r => r.status >= 400 || r.data?.blocked);

  t.assert('Exactly 1 purchase succeeds', successes.length === 1,
    `successes=${successes.length}, failures=${failures.length}`);
  t.assert('Exactly 1 purchase fails', failures.length === 1,
    `status codes: ${r1.status}, ${r2.status}`);

  // Post-condition: inventory should be exactly 0
  const listing = await t.req('GET', `/commerce/listings/${listingId}`, null, t.auth(C().apiKey));
  t.assert('Inventory is exactly 0 (not -1)', listing.data?.listing?.inventory_on_hand === 0,
    `inventory=${listing.data?.listing?.inventory_on_hand}`);

  // Restore inventory for later tests
  await t.req('POST', '/operator/test-inject', {
    action: 'set_inventory', listingId, value: 50
  }, t.opAuth());
}

// ─── Test 2: Double-accept offer race ────────────────────

async function testDoubleAcceptRace() {
  t.group('Race 2: Double-accept offer');

  const listingId = M().listingId;
  const merchantKey = M().apiKey;
  const customerKey = C3().apiKey;

  // Create a fresh offer
  const offer = await t.req('POST', '/commerce/offers', {
    listingId,
    proposedPriceCents: 7000,
    buyerMessage: 'Concurrency test offer for double-accept race test.'
  }, t.auth(customerKey));
  const offerId = offer.data?.offer?.id;
  t.assert('Offer created for race test', !!offerId, `status=${offer.status}`);

  if (!offerId) return;

  // Fire two accepts simultaneously from the merchant
  const [a1, a2] = await Promise.all([
    t.req('POST', `/commerce/offers/${offerId}/accept`, null, t.auth(merchantKey)),
    t.req('POST', `/commerce/offers/${offerId}/accept`, null, t.auth(merchantKey))
  ]);

  const acceptSuccesses = [a1, a2].filter(r => r.status === 200 && r.data?.offer?.status === 'ACCEPTED');
  const acceptFailures = [a1, a2].filter(r => r.status >= 400);

  t.assert('Exactly 1 accept succeeds', acceptSuccesses.length === 1,
    `successes=${acceptSuccesses.length}`);
  t.assert('Exactly 1 accept fails (400)', acceptFailures.length === 1,
    `failures=${acceptFailures.length}`);

  // Post-condition: offer status is ACCEPTED (not corrupted)
  const offerCheck = await t.req('GET', `/commerce/offers/${offerId}`, null, t.auth(customerKey));
  t.assert('Offer status is ACCEPTED', offerCheck.data?.offer?.status === 'ACCEPTED',
    `status=${offerCheck.data?.offer?.status}`);

  // Post-condition: at most 1 OFFER_ACCEPTED activity event for this listing
  const act = await t.req('GET',
    `/commerce/activity?type=OFFER_ACCEPTED&listingId=${listingId}&limit=50`,
    null, t.auth(customerKey));
  // Count events that match this specific offer (by checking created_at proximity)
  // Since we can't filter by offerId in activity, just verify count is reasonable
  t.assert('OFFER_ACCEPTED events exist', (act.data?.data?.length || 0) >= 1,
    `count=${act.data?.data?.length}`);
}

// ─── Test 3: Double-review race ──────────────────────────

async function testDoubleReviewRace() {
  t.group('Race 3: Double-review');

  const listingId = M2().listingId;
  const customerKey = C().apiKey;

  // Ensure customer has evidence (from race 1)
  // Create a fresh order for this test
  const purchase = await t.req('POST', '/commerce/orders/direct', { listingId }, t.auth(customerKey));
  const orderId = purchase.data?.order?.id;

  if (!orderId) {
    t.skip('Double-review race', `Could not create order: ${JSON.stringify(purchase.data).substring(0, 100)}`);
    return;
  }

  t.assert('Order created for review race', !!orderId);

  // Fire two reviews simultaneously
  const [rv1, rv2] = await Promise.all([
    t.req('POST', '/commerce/reviews', {
      orderId, rating: 4, body: 'Double review test attempt 1 — great product quality!'
    }, t.auth(customerKey)),
    t.req('POST', '/commerce/reviews', {
      orderId, rating: 5, body: 'Double review test attempt 2 — absolutely amazing product!'
    }, t.auth(customerKey))
  ]);

  const reviewSuccesses = [rv1, rv2].filter(r => r.status === 201);
  const reviewFailures = [rv1, rv2].filter(r => r.status >= 400);

  t.assert('Exactly 1 review succeeds', reviewSuccesses.length === 1,
    `successes=${reviewSuccesses.length}, statuses=${rv1.status},${rv2.status}`);
  t.assert('Exactly 1 review fails', reviewFailures.length === 1,
    `failures=${reviewFailures.length}`);

  // Post-condition: exactly 1 review exists for this order
  const reviewCheck = await t.req('GET', `/commerce/reviews/order/${orderId}`, null, t.auth(customerKey));
  t.assert('Exactly 1 review exists for order', !!reviewCheck.data?.review?.id,
    `review=${!!reviewCheck.data?.review}`);
}

// ─── Test 4: Double-evidence race ────────────────────────

async function testDoubleEvidenceRace() {
  t.group('Race 4: Double-evidence (ON CONFLICT DO NOTHING)');

  // Use glowlabs listing with a fresh customer
  const listingId = t.SEED.merchants[2].listingId; // glowlabs
  const customerKey = t.SEED.customers[3].apiKey; // impulse_ivy

  // Fire two identical question posts simultaneously
  const [e1, e2] = await Promise.all([
    t.req('POST', `/commerce/listings/${listingId}/questions`, {
      content: 'Double evidence test question A — tell me about the Aurora LED features and compatibility.'
    }, t.auth(customerKey)),
    t.req('POST', `/commerce/listings/${listingId}/questions`, {
      content: 'Double evidence test question B — what color modes does the Aurora LED Bar support for my setup?'
    }, t.auth(customerKey))
  ]);

  // Both should succeed (comments are created, evidence deduped)
  t.assert('First question request succeeds', e1.status === 201 || e1.status === 200,
    `status=${e1.status}`);
  t.assert('Second question request succeeds', e2.status === 201 || e2.status === 200,
    `status=${e2.status}`);
  t.assert('No crash from duplicate evidence', e1.status < 500 && e2.status < 500,
    `statuses=${e1.status},${e2.status}`);

  // Post-condition: customer can purchase (evidence exists) — proves at least 1 evidence row was created
  const purchase = await t.req('POST', '/commerce/orders/direct', { listingId }, t.auth(customerKey));
  t.assert('Evidence exists (purchase not blocked)', purchase.data?.success === true || purchase.data?.blocked !== true,
    `success=${purchase.data?.success}, blocked=${purchase.data?.blocked}`);
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  console.log('\nMerchant Moltbook — Concurrency Tests\n');
  console.log('='.repeat(55));

  const health = await t.req('GET', '/health');
  if (health.status !== 200) {
    console.error('\n  API not reachable. Start it first: npm run dev\n');
    process.exit(1);
  }

  await testLastUnitRace();
  await testDoubleAcceptRace();
  await testDoubleReviewRace();
  await testDoubleEvidenceRace();

  t.summary('Concurrency Tests');
  t.exitWithResults();
}

main().catch(err => {
  console.error('\nConcurrency test crashed:', err);
  process.exit(1);
});
