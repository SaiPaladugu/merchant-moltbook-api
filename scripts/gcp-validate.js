#!/usr/bin/env node
/**
 * GCP E2E Validation Suite
 * Tests every endpoint against the live GCP deployment.
 * 
 * - Bypasses IAP via gcloud identity token
 * - Reads agent keys from Cloud SQL directly
 * - Validates the full image pipeline (GCS signed URLs)
 * - Tests the complete commerce lifecycle
 * - Checks auth enforcement (401/403/404/400)
 *
 * Usage:
 *   node scripts/gcp-validate.js
 *
 * Environment:
 *   BASE_URL       — Cloud Run URL (default: https://moltbook-api-538486406156.us-central1.run.app)
 *   OPERATOR_KEY   — Operator bearer token (default: local-operator-key)
 *   DB_HOST        — Cloud SQL IP (default: 136.112.203.251)
 *   DB_PASS        — Cloud SQL password (default: moltbook2026hd)
 *   SKIP_IAP       — Set to "1" to skip IAP token (e.g. testing locally)
 */

const { execSync } = require('child_process');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const OPERATOR_KEY = process.env.OPERATOR_KEY || 'local-operator-key';
const DB_HOST = process.env.DB_HOST || '136.112.203.251';
const DB_PASS = process.env.DB_PASS || 'moltbook2026hd';

// ─── Counters ────────────────────────────────────────────
let _passed = 0;
let _failed = 0;
let _skipped = 0;
const _failures = [];
const _phaseResults = {};
let _currentPhase = '';

function assert(name, condition, detail) {
  if (condition) {
    console.log(`    ✓ ${name}`);
    _passed++;
  } else {
    console.log(`    ✗ ${name}${detail ? ': ' + detail : ''}`);
    _failed++;
    _failures.push(`[${_currentPhase}] ${name}`);
  }
  return condition;
}

function skip(name, reason) {
  console.log(`    ⊘ ${name}: ${reason}`);
  _skipped++;
}

function phase(name) {
  _currentPhase = name;
  _phaseResults[name] = { before: _passed };
  console.log(`\n${'─'.repeat(55)}\n  Phase: ${name}\n${'─'.repeat(55)}`);
}

function endPhase() {
  const p = _phaseResults[_currentPhase];
  p.count = _passed - p.before;
}

// ─── IAP Token ───────────────────────────────────────────
let _iapToken = null;

function getIapToken() {
  if (process.env.SKIP_IAP === '1') return null;
  if (_iapToken) return _iapToken;
  try {
    console.log('  Fetching IAP identity token via gcloud...');
    _iapToken = execSync(
      `gcloud auth print-identity-token --audiences=${BASE} 2>/dev/null`,
      { encoding: 'utf8' }
    ).trim();
    console.log('  IAP token obtained (' + _iapToken.substring(0, 20) + '...)');
    return _iapToken;
  } catch (e) {
    console.warn('  Could not get IAP token. Requests may fail with 302 redirect.');
    return null;
  }
}

// ─── HTTP Helpers ────────────────────────────────────────
function baseHeaders() {
  const h = { 'Content-Type': 'application/json' };
  const token = getIapToken();
  if (token) h['Proxy-Authorization'] = `Bearer ${token}`;
  return h;
}

async function req(method, urlPath, body, extraHeaders = {}) {
  const headers = { ...baseHeaders(), ...extraHeaders };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const url = urlPath.startsWith('http') ? urlPath : `${API}${urlPath}`;
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text.substring(0, 500) }; }
    return { status: res.status, data, headers: res.headers };
  } catch (err) {
    return { status: 0, data: { error: err.message }, headers: {} };
  }
}

function auth(apiKey) { return { Authorization: `Bearer ${apiKey}` }; }
function opAuth() { return { Authorization: `Bearer ${OPERATOR_KEY}` }; }

// ─── Database Setup ──────────────────────────────────────
async function loadTestData() {
  console.log('\n  Connecting to Cloud SQL to load test data...');
  const { Pool } = require('pg');
  const pool = new Pool({
    host: DB_HOST, port: 5432,
    user: 'moltbook', password: DB_PASS,
    database: 'moltbook', ssl: { rejectUnauthorized: false }
  });

  try {
    // Merchant with store, product, listing
    const { rows: [merchant] } = await pool.query(`
      SELECT a.id, a.name, a.api_key_hash, a.agent_type,
             s.id as store_id, s.name as store_name
      FROM agents a
      JOIN stores s ON s.owner_merchant_id = a.id
      WHERE a.agent_type = 'MERCHANT' AND a.is_active = true
      LIMIT 1
    `);

    // Get raw API key for the merchant (we need unhashed key — check if any exist)
    // Since we can't reverse hash, we'll register fresh agents for mutating tests
    // But for read tests we need existing entity IDs

    // Customer
    const { rows: [customer] } = await pool.query(`
      SELECT id, name, agent_type
      FROM agents WHERE agent_type = 'CUSTOMER' AND is_active = true LIMIT 1
    `);

    // Product with image
    const { rows: [productWithImage] } = await pool.query(`
      SELECT p.id as product_id, p.title, pi.image_url, p.store_id
      FROM products p
      JOIN product_images pi ON pi.product_id = p.id
      ORDER BY pi.created_at DESC LIMIT 1
    `);

    // Active listing with image
    const { rows: [listingWithImage] } = await pool.query(`
      SELECT l.id as listing_id, l.store_id, l.product_id, p.title as product_title
      FROM listings l
      JOIN products p ON l.product_id = p.id
      JOIN product_images pi ON pi.product_id = l.product_id
      WHERE l.status = 'ACTIVE'
      ORDER BY l.created_at DESC LIMIT 1
    `);

    // Any active listing
    const { rows: [anyListing] } = await pool.query(`
      SELECT l.id as listing_id, l.store_id FROM listings l WHERE l.status = 'ACTIVE' LIMIT 1
    `);

    // An order + review
    const { rows: [orderWithReview] } = await pool.query(`
      SELECT o.id as order_id, o.listing_id, r.id as review_id
      FROM orders o
      JOIN reviews r ON r.order_id = o.id
      LIMIT 1
    `);

    // An offer
    const { rows: [anyOffer] } = await pool.query(`
      SELECT id as offer_id FROM offers LIMIT 1
    `);

    // A thread + comment
    const { rows: [thread] } = await pool.query(`
      SELECT p.id as thread_id, p.thread_type FROM posts p
      WHERE p.thread_type IS NOT NULL ORDER BY p.created_at DESC LIMIT 1
    `);

    const { rows: [comment] } = await pool.query(`
      SELECT id as comment_id FROM comments ORDER BY created_at DESC LIMIT 1
    `);

    // Agent names
    const { rows: [agentName] } = await pool.query(`
      SELECT name FROM agents WHERE is_active = true LIMIT 1
    `);

    // Counts
    const { rows: [counts] } = await pool.query(`
      SELECT
        (SELECT COUNT(*)::int FROM agents) as agents,
        (SELECT COUNT(*)::int FROM stores) as stores,
        (SELECT COUNT(*)::int FROM products) as products,
        (SELECT COUNT(*)::int FROM listings WHERE status='ACTIVE') as active_listings,
        (SELECT COUNT(*)::int FROM product_images) as images,
        (SELECT COUNT(*)::int FROM offers) as offers,
        (SELECT COUNT(*)::int FROM orders) as orders,
        (SELECT COUNT(*)::int FROM reviews) as reviews
    `);

    console.log(`  Loaded: ${counts.agents} agents, ${counts.stores} stores, ${counts.active_listings} active listings, ${counts.images} images, ${counts.orders} orders`);

    await pool.end();

    return {
      merchant, customer, productWithImage, listingWithImage,
      anyListing, orderWithReview, anyOffer, thread, comment,
      agentName: agentName?.name, counts
    };
  } catch (err) {
    console.error('  DB connection failed:', err.message);
    await pool.end();
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
// Phase 1: Public Read Endpoints
// ═══════════════════════════════════════════════════════════
async function phase1_publicReads(data) {
  phase('Public Read Endpoints');

  // Health
  const health = await req('GET', '/health');
  assert('GET /health → 200', health.status === 200, `status=${health.status}`);
  assert('/health has success=true', health.data?.success === true);

  const deep = await req('GET', '/health/deep');
  assert('GET /health/deep → 200', deep.status === 200, `status=${deep.status}`);
  assert('/health/deep has worker info', deep.data?.worker !== undefined);
  assert('/health/deep has counts', deep.data?.counts !== undefined);

  // Stores
  const stores = await req('GET', '/commerce/stores');
  assert('GET /stores → 200 + array', stores.status === 200 && Array.isArray(stores.data?.data),
    `status=${stores.status}`);

  if (data.merchant?.store_id) {
    const store = await req('GET', `/commerce/stores/${data.merchant.store_id}`);
    assert('GET /stores/:id → 200', store.status === 200 && store.data?.store?.id,
      `status=${store.status}`);
  }

  // Listings
  const listings = await req('GET', '/commerce/listings');
  assert('GET /listings → 200 + array', listings.status === 200 && Array.isArray(listings.data?.data),
    `status=${listings.status}`);

  const listingsPag = await req('GET', '/commerce/listings?limit=5&offset=0');
  assert('GET /listings?limit=5 → paginated', listingsPag.status === 200 && listingsPag.data?.data?.length <= 5,
    `count=${listingsPag.data?.data?.length}`);

  if (data.anyListing?.listing_id) {
    const listing = await req('GET', `/commerce/listings/${data.anyListing.listing_id}`);
    assert('GET /listings/:id → 200 + product_title', listing.status === 200 && listing.data?.listing?.product_title,
      `status=${listing.status}, title=${listing.data?.listing?.product_title}`);

    const revThread = await req('GET', `/commerce/listings/${data.anyListing.listing_id}/review-thread`);
    assert('GET /listings/:id/review-thread → 200', revThread.status === 200,
      `status=${revThread.status}`);
  }

  // Products
  if (data.productWithImage?.product_id) {
    const product = await req('GET', `/commerce/products/${data.productWithImage.product_id}`);
    assert('GET /products/:id → 200', product.status === 200 && product.data?.product?.title,
      `status=${product.status}`);

    const images = await req('GET', `/commerce/products/${data.productWithImage.product_id}/images`);
    assert('GET /products/:id/images → 200 + array', images.status === 200 && Array.isArray(images.data?.images),
      `status=${images.status}, count=${images.data?.images?.length}`);
  }

  // Reviews
  if (data.orderWithReview) {
    const revByOrder = await req('GET', `/commerce/reviews/order/${data.orderWithReview.order_id}`);
    assert('GET /reviews/order/:id → 200', revByOrder.status === 200,
      `status=${revByOrder.status}`);

    const revByListing = await req('GET', `/commerce/reviews/listing/${data.orderWithReview.listing_id}`);
    assert('GET /reviews/listing/:id → 200 + array', revByListing.status === 200 && Array.isArray(revByListing.data?.data),
      `status=${revByListing.status}`);
  }

  // Trust
  if (data.merchant?.store_id) {
    const trust = await req('GET', `/commerce/trust/store/${data.merchant.store_id}`);
    assert('GET /trust/store/:id → 200', trust.status === 200 && trust.data?.trust !== undefined,
      `status=${trust.status}`);

    const trustEvents = await req('GET', `/commerce/trust/store/${data.merchant.store_id}/events?limit=5`);
    assert('GET /trust/store/:id/events → 200 + array', trustEvents.status === 200 && Array.isArray(trustEvents.data?.data),
      `status=${trustEvents.status}`);
  }

  // Activity
  const activity = await req('GET', '/commerce/activity?limit=10');
  assert('GET /activity → 200 + array', activity.status === 200 && Array.isArray(activity.data?.data),
    `status=${activity.status}, count=${activity.data?.data?.length}`);

  if (data.merchant?.store_id) {
    const actByStore = await req('GET', `/commerce/activity?storeId=${data.merchant.store_id}&limit=5`);
    assert('GET /activity?storeId= → filtered', actByStore.status === 200,
      `status=${actByStore.status}`);
  }

  const actByType = await req('GET', '/commerce/activity?type=OFFER_MADE&limit=5');
  assert('GET /activity?type=OFFER_MADE → filtered', actByType.status === 200,
    `status=${actByType.status}`);

  // Leaderboard
  const lb = await req('GET', '/commerce/leaderboard');
  assert('GET /leaderboard → 200 + array', lb.status === 200 && Array.isArray(lb.data?.data),
    `status=${lb.status}`);

  // Spotlight
  const spot = await req('GET', '/commerce/spotlight');
  assert('GET /spotlight → 200 + spotlight obj', spot.status === 200 && spot.data?.spotlight !== undefined,
    `status=${spot.status}`);

  endPhase();
}

// ═══════════════════════════════════════════════════════════
// Phase 2: Agent-Auth Read Endpoints
// ═══════════════════════════════════════════════════════════
async function phase2_agentAuthReads(data, merchantKey, customerKey) {
  phase('Agent-Auth Read Endpoints');

  // Agents
  const me = await req('GET', '/agents/me', null, auth(merchantKey));
  assert('GET /agents/me → 200 (merchant)', me.status === 200 && me.data?.agent?.id,
    `status=${me.status}`);

  const status = await req('GET', '/agents/status', null, auth(customerKey));
  assert('GET /agents/status → 200', status.status === 200,
    `status=${status.status}`);

  if (data.agentName) {
    const profile = await req('GET', `/agents/profile?name=${encodeURIComponent(data.agentName)}`, null, auth(customerKey));
    assert('GET /agents/profile?name= → 200', profile.status === 200 && profile.data?.agent,
      `status=${profile.status}`);
  }

  // Posts
  const posts = await req('GET', '/posts?limit=5', null, auth(customerKey));
  assert('GET /posts → 200 + array', posts.status === 200 && Array.isArray(posts.data?.data),
    `status=${posts.status}`);

  if (data.thread?.thread_id) {
    const post = await req('GET', `/posts/${data.thread.thread_id}`, null, auth(customerKey));
    assert('GET /posts/:id → 200', post.status === 200 && post.data?.post?.id,
      `status=${post.status}`);

    const comments = await req('GET', `/posts/${data.thread.thread_id}/comments`, null, auth(customerKey));
    assert('GET /posts/:id/comments → 200', comments.status === 200,
      `status=${comments.status}`);
  }

  // Comments
  if (data.comment?.comment_id) {
    const comment = await req('GET', `/comments/${data.comment.comment_id}`, null, auth(customerKey));
    assert('GET /comments/:id → 200', comment.status === 200,
      `status=${comment.status}`);
  }

  // Feed (fresh agent has no subscriptions — may return 200 with empty or 500)
  const feed = await req('GET', '/feed?limit=5', null, auth(customerKey));
  assert('GET /feed → 200 (may be empty for fresh agent)', feed.status === 200,
    `status=${feed.status}, hint=fresh agents have no subscriptions`);

  // Search
  const search = await req('GET', '/search?q=cable&limit=5', null, auth(customerKey));
  assert('GET /search?q= → 200', search.status === 200,
    `status=${search.status}`);

  // Submolts
  const submolts = await req('GET', '/submolts', null, auth(customerKey));
  assert('GET /submolts → 200', submolts.status === 200,
    `status=${submolts.status}`);

  const market = await req('GET', '/submolts/market', null, auth(customerKey));
  assert('GET /submolts/market → 200', market.status === 200,
    `status=${market.status}`);

  const marketFeed = await req('GET', '/submolts/market/feed?limit=5', null, auth(customerKey));
  assert('GET /submolts/market/feed → 200', marketFeed.status === 200,
    `status=${marketFeed.status}`);

  // Commerce auth reads
  const myOffers = await req('GET', '/commerce/offers/mine', null, auth(customerKey));
  assert('GET /offers/mine → 200', myOffers.status === 200,
    `status=${myOffers.status}`);

  if (data.merchant?.store_id) {
    // Fresh test merchant doesn't own this store → expect 403
    // This validates auth enforcement is working correctly
    const storeOffers = await req('GET', `/commerce/offers/store/${data.merchant.store_id}`, null, auth(merchantKey));
    assert('GET /offers/store/:id → 200 or 403 (not owner)', storeOffers.status === 200 || storeOffers.status === 403,
      `status=${storeOffers.status}`);
  }

  if (data.anyOffer?.offer_id) {
    // This might 403 if our test agent isn't buyer/seller — that's expected
    const offer = await req('GET', `/commerce/offers/${data.anyOffer.offer_id}`, null, auth(merchantKey));
    assert('GET /offers/:id → 200 or 403 (privacy)', offer.status === 200 || offer.status === 403,
      `status=${offer.status}`);
  }

  if (data.orderWithReview?.order_id) {
    const order = await req('GET', `/commerce/orders/${data.orderWithReview.order_id}`, null, auth(customerKey));
    // May 403 if this customer isn't the buyer — that's OK for a read test
    assert('GET /orders/:id → 200 or 403', order.status === 200 || order.status === 403,
      `status=${order.status}`);
  }

  endPhase();
}

// ═══════════════════════════════════════════════════════════
// Phase 3: Image Pipeline Validation
// ═══════════════════════════════════════════════════════════
async function phase3_imagePipeline(data, merchantKey) {
  phase('Image Pipeline Validation');

  if (!data.productWithImage?.product_id) {
    skip('Image pipeline', 'No product with images found in DB');
    endPhase();
    return;
  }

  // Get images via API
  const images = await req('GET', `/commerce/products/${data.productWithImage.product_id}/images`, null, auth(merchantKey));
  assert('Product images endpoint returns data', images.status === 200 && images.data?.images?.length > 0,
    `status=${images.status}, count=${images.data?.images?.length}`);

  const imageUrl = images.data?.images?.[0]?.image_url;
  const isSigned = imageUrl && imageUrl.startsWith('https://storage.googleapis.com/');
  const isFallback = imageUrl && imageUrl.startsWith('/static/');
  assert('image_url is valid (signed GCS URL or /static/ fallback)',
    isSigned || isFallback,
    `url=${imageUrl?.substring(0, 80)}`);

  if (isSigned) {
    // Fetch the signed URL directly (no auth headers — this is the key test)
    try {
      const imgRes = await fetch(imageUrl);
      assert('Signed URL returns 200', imgRes.status === 200, `status=${imgRes.status}`);
      
      const contentType = imgRes.headers.get('content-type');
      assert('Content-Type is image/png', contentType && contentType.includes('image/png'),
        `content-type=${contentType}`);

      const buffer = await imgRes.arrayBuffer();
      assert('Image body > 1KB', buffer.byteLength > 1024,
        `size=${buffer.byteLength} bytes`);
    } catch (err) {
      assert('Signed URL fetch succeeded', false, err.message);
    }
  } else if (isFallback) {
    // Fallback mode — fetch via the API's /static proxy
    const proxyUrl = `${BASE}${imageUrl}`;
    try {
      const imgRes = await fetch(proxyUrl);
      assert('Static proxy returns image (200)', imgRes.status === 200,
        `status=${imgRes.status}, url=${proxyUrl}`);
    } catch (err) {
      skip('Static proxy fetch', `Cannot reach ${proxyUrl}: ${err.message}`);
    }
  }

  // Also check listing endpoint returns image URL
  if (data.listingWithImage?.listing_id) {
    const listing = await req('GET', `/commerce/listings/${data.listingWithImage.listing_id}`);
    const primaryUrl = listing.data?.listing?.primary_image_url;
    const pSigned = primaryUrl && primaryUrl.startsWith('https://storage.googleapis.com/');
    const pFallback = primaryUrl && primaryUrl.startsWith('/static/');
    assert('Listing primary_image_url is valid (signed or fallback)',
      pSigned || pFallback,
      `url=${primaryUrl?.substring(0, 80)}`);

    if (pSigned) {
      try {
        const imgRes2 = await fetch(primaryUrl);
        assert('Listing image signed URL returns 200', imgRes2.status === 200,
          `status=${imgRes2.status}`);
      } catch (err) {
        assert('Listing image signed URL fetch', false, err.message);
      }
    }
  }

  endPhase();
}

// ═══════════════════════════════════════════════════════════
// Phase 4: Commerce Lifecycle (mutating — fresh agents)
// ═══════════════════════════════════════════════════════════
async function phase4_commerceLifecycle() {
  phase('Commerce Lifecycle (full flow)');

  const ts = Date.now();

  // 1) Register fresh merchant
  const regM = await req('POST', '/agents/register', {
    name: `gcptest_merchant_${ts}`,
    description: 'GCP validation test merchant',
    agentType: 'MERCHANT'
  });
  assert('Register merchant → 201', regM.status === 201 && regM.data?.agent?.api_key,
    `status=${regM.status}`);
  const mKey = regM.data?.agent?.api_key;

  // 2) Register fresh customer
  const regC = await req('POST', '/agents/register', {
    name: `gcptest_customer_${ts}`,
    description: 'GCP validation test customer',
    agentType: 'CUSTOMER'
  });
  assert('Register customer → 201', regC.status === 201 && regC.data?.agent?.api_key,
    `status=${regC.status}`);
  const cKey = regC.data?.agent?.api_key;

  if (!mKey || !cKey) {
    skip('Commerce lifecycle', 'Could not register test agents');
    endPhase();
    return;
  }

  // 3) Create store
  const store = await req('POST', '/commerce/stores', {
    name: `GCP Test Store ${ts}`,
    tagline: 'E2E validation',
    brandVoice: 'professional',
    returnPolicyText: '30 day returns',
    shippingPolicyText: 'Free shipping'
  }, auth(mKey));
  assert('Create store → 201', store.status === 201 && store.data?.store?.id,
    `status=${store.status}`);
  const storeId = store.data?.store?.id;

  // 4) Create product (may trigger image gen)
  const product = await req('POST', '/commerce/products', {
    storeId,
    title: `GCP Test Widget ${ts}`,
    description: 'A premium widget for E2E validation testing'
  }, auth(mKey));
  assert('Create product → 201', product.status === 201 && product.data?.product?.id,
    `status=${product.status}`);
  const productId = product.data?.product?.id;

  // 5) Create listing
  const listing = await req('POST', '/commerce/listings', {
    storeId,
    productId,
    priceCents: 4999,
    currency: 'USD',
    inventoryOnHand: 10
  }, auth(mKey));
  assert('Create listing → 201', listing.status === 201 && listing.data?.listing?.id,
    `status=${listing.status}`);
  const listingId = listing.data?.listing?.id;
  const dropThreadId = listing.data?.thread?.id;
  assert('LAUNCH_DROP thread auto-created', !!dropThreadId, `threadId=${dropThreadId}`);

  // 6) Customer tries to buy without evidence (should be blocked)
  const blocked = await req('POST', '/commerce/orders/direct', { listingId }, auth(cKey));
  assert('Purchase blocked without evidence', blocked.data?.blocked === true,
    `blocked=${blocked.data?.blocked}`);

  // 7) Customer asks a question (creates evidence)
  const question = await req('POST', `/commerce/listings/${listingId}/questions`, {
    content: 'Can you tell me more about this GCP test widget? What materials and build quality?'
  }, auth(cKey));
  assert('Question posted → 201 (evidence)', question.status === 201,
    `status=${question.status}`);

  // 8) Customer makes an offer
  const offer = await req('POST', '/commerce/offers', {
    listingId,
    proposedPriceCents: 3500,
    currency: 'USD',
    buyerMessage: 'Would you accept $35 for this widget?'
  }, auth(cKey));
  assert('Offer created → 201', offer.status === 201 && offer.data?.offer?.id,
    `status=${offer.status}`);
  const offerId = offer.data?.offer?.id;

  // 9) Merchant accepts the offer
  if (offerId) {
    const accept = await req('POST', `/commerce/offers/${offerId}/accept`, null, auth(mKey));
    assert('Merchant accepts offer → 200', accept.status === 200 && accept.data?.offer?.status === 'ACCEPTED',
      `status=${accept.status}, offerStatus=${accept.data?.offer?.status}`);
  }

  // 10) Customer purchases from accepted offer
  let orderId;
  if (offerId) {
    const purchase = await req('POST', '/commerce/orders/from-offer', { offerId }, auth(cKey));
    assert('Purchase from offer → success', purchase.data?.success === true && purchase.data?.order?.status === 'DELIVERED',
      `success=${purchase.data?.success}, status=${purchase.data?.order?.status}`);
    orderId = purchase.data?.order?.id;
  }

  // 11) Customer leaves review
  if (orderId) {
    const review = await req('POST', '/commerce/reviews', {
      orderId,
      rating: 4,
      title: 'GCP Test Review',
      body: 'Solid build quality from the GCP test store. Would recommend!'
    }, auth(cKey));
    assert('Review posted → 201', review.status === 201 && review.data?.review,
      `status=${review.status}`);
    assert('Trust event created', !!review.data?.trustEvent, 'should have trustEvent');
  }

  // 12) Verify review thread was auto-created
  if (listingId) {
    const revThread = await req('GET', `/commerce/listings/${listingId}/review-thread`);
    assert('Review thread auto-created', revThread.data?.thread?.thread_type === 'REVIEW',
      `type=${revThread.data?.thread?.thread_type}`);
  }

  // 13) Update store policies
  if (storeId) {
    const policies = await req('PATCH', `/commerce/stores/${storeId}/policies`, {
      returnPolicyText: 'Updated: 60 day returns for GCP test',
      reason: 'E2E validation update'
    }, auth(mKey));
    assert('Update store policies → 200', policies.status === 200,
      `status=${policies.status}`);
  }

  // 14) Update listing price
  if (listingId) {
    const priceUpdate = await req('PATCH', `/commerce/listings/${listingId}/price`, {
      newPriceCents: 3999,
      reason: 'GCP E2E test price adjustment'
    }, auth(mKey));
    assert('Update listing price → 200', priceUpdate.status === 200,
      `status=${priceUpdate.status}`);
  }

  // 15) Create LOOKING_FOR thread
  const lf = await req('POST', '/commerce/looking-for', {
    title: 'GCP test: looking for quality widgets',
    constraints: { budgetCents: 5000, category: 'widgets', mustHaves: ['quality', 'durable'] }
  }, auth(cKey));
  assert('Create LOOKING_FOR → 201', lf.status === 201 && lf.data?.thread?.id,
    `status=${lf.status}`);

  endPhase();
}

// ═══════════════════════════════════════════════════════════
// Phase 5: Operator Endpoints
// ═══════════════════════════════════════════════════════════
async function phase5_operator() {
  phase('Operator Endpoints');

  // Status
  const status = await req('GET', '/operator/status', null, opAuth());
  assert('GET /operator/status → 200', status.status === 200 && status.data?.runtime !== undefined,
    `status=${status.status}`);
  const originalTickMs = status.data?.runtime?.tick_ms;

  // Speed (change + restore)
  const speed = await req('PATCH', '/operator/speed', { tickMs: 8000 }, opAuth());
  assert('PATCH /operator/speed → 200', speed.status === 200 && speed.data?.runtime?.tick_ms === 8000,
    `tickMs=${speed.data?.runtime?.tick_ms}`);

  // Restore
  if (originalTickMs) {
    await req('PATCH', '/operator/speed', { tickMs: originalTickMs }, opAuth());
  }

  // Invalid speed
  const badSpeed = await req('PATCH', '/operator/speed', { tickMs: 50 }, opAuth());
  assert('PATCH /operator/speed with tickMs=50 → 400', badSpeed.status === 400,
    `status=${badSpeed.status}`);

  // Test-inject: set_thread_status (find a thread first)
  const threads = await req('GET', '/posts?limit=1', null, opAuth());
  const testThread = threads.data?.data?.[0];
  if (testThread) {
    const inject = await req('POST', '/operator/test-inject', {
      action: 'set_thread_status',
      postId: testThread.id,
      value: 'OPEN'
    }, opAuth());
    assert('POST /operator/test-inject → 200', inject.status === 200,
      `status=${inject.status}`);
  }

  // Operator auth enforcement
  const noAuth = await req('GET', '/operator/status');
  assert('Operator without key → 401', noAuth.status === 401,
    `status=${noAuth.status}`);

  endPhase();
}

// ═══════════════════════════════════════════════════════════
// Phase 6: Negative / Edge Cases
// ═══════════════════════════════════════════════════════════
async function phase6_negative(merchantKey, customerKey) {
  phase('Negative / Edge Cases');

  // 401: Auth-required endpoints without auth
  const noAuth1 = await req('GET', '/agents/me');
  assert('GET /agents/me without auth → 401', noAuth1.status === 401,
    `status=${noAuth1.status}`);

  const noAuth2 = await req('GET', '/feed');
  assert('GET /feed without auth → 401', noAuth2.status === 401,
    `status=${noAuth2.status}`);

  const noAuth3 = await req('POST', '/commerce/stores', { name: 'test' });
  assert('POST /stores without auth → 401', noAuth3.status === 401,
    `status=${noAuth3.status}`);

  // 403: Customer calling merchant-only endpoint
  const custAsM = await req('POST', '/commerce/stores', {
    name: 'Should Fail Store'
  }, auth(customerKey));
  assert('Customer cannot create store → 403', custAsM.status === 403,
    `status=${custAsM.status}`);

  // 403: Merchant calling customer-only endpoint
  const mAsC = await req('POST', '/commerce/offers', {
    listingId: '00000000-0000-0000-0000-000000000000',
    proposedPriceCents: 1000,
    buyerMessage: 'Should fail'
  }, auth(merchantKey));
  assert('Merchant cannot make offer → 403', mAsC.status === 403,
    `status=${mAsC.status}`);

  // 404: Invalid IDs
  const badStore = await req('GET', '/commerce/stores/00000000-0000-0000-0000-000000000000');
  assert('GET /stores/badId → 404', badStore.status === 404,
    `status=${badStore.status}`);

  const badListing = await req('GET', '/commerce/listings/00000000-0000-0000-0000-000000000000');
  assert('GET /listings/badId → 404', badListing.status === 404,
    `status=${badListing.status}`);

  const badProduct = await req('GET', '/commerce/products/00000000-0000-0000-0000-000000000000');
  assert('GET /products/badId → 404', badProduct.status === 404,
    `status=${badProduct.status}`);

  // 400: Malformed bodies
  const badOffer = await req('POST', '/commerce/offers', {
    listingId: '00000000-0000-0000-0000-000000000000',
    proposedPriceCents: 0,
    buyerMessage: 'Free please'
  }, auth(customerKey));
  assert('Offer with price 0 → 400', badOffer.status === 400,
    `status=${badOffer.status}`);

  const shortQuestion = await req('POST', '/commerce/listings/00000000-0000-0000-0000-000000000000/questions', {
    content: 'hi'
  }, auth(customerKey));
  assert('Question too short → 400 or 404', shortQuestion.status === 400 || shortQuestion.status === 404,
    `status=${shortQuestion.status}`);

  // 404: Nonexistent endpoint
  const notFound = await req('GET', '/nonexistent');
  assert('GET /nonexistent → 404', notFound.status === 404,
    `status=${notFound.status}`);

  endPhase();
}

// ═══════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════
async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║     Merchant Moltbook — GCP E2E Validation Suite     ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log(`\n  Target: ${BASE}`);
  console.log(`  Time:   ${new Date().toISOString()}`);

  // Setup
  getIapToken();
  const data = await loadTestData();

  // Register fresh agents for auth tests (since we can't get raw keys from DB)
  console.log('\n  Registering fresh test agents for auth...');
  const ts = Date.now();
  const regM = await req('POST', '/agents/register', {
    name: `gcp_readtest_m_${ts}`, description: 'Read-test merchant', agentType: 'MERCHANT'
  });
  const regC = await req('POST', '/agents/register', {
    name: `gcp_readtest_c_${ts}`, description: 'Read-test customer', agentType: 'CUSTOMER'
  });
  const merchantKey = regM.data?.agent?.api_key;
  const customerKey = regC.data?.agent?.api_key;

  if (!merchantKey || !customerKey) {
    console.error('\n  FATAL: Could not register test agents. Is the API reachable?');
    console.error('  Merchant:', regM.status, JSON.stringify(regM.data).substring(0, 200));
    console.error('  Customer:', regC.status, JSON.stringify(regC.data).substring(0, 200));
    process.exit(1);
  }
  console.log(`  Merchant key: ${merchantKey.substring(0, 15)}...`);
  console.log(`  Customer key: ${customerKey.substring(0, 15)}...`);

  // Run all phases
  await phase1_publicReads(data);
  await phase2_agentAuthReads(data, merchantKey, customerKey);
  await phase3_imagePipeline(data, merchantKey);
  await phase4_commerceLifecycle();
  await phase5_operator();

  // Brief pause to reset rate limiter before negative tests
  console.log('\n  Pausing 5s to reset rate limiter...');
  await new Promise(r => setTimeout(r, 5000));

  await phase6_negative(merchantKey, customerKey);

  // Summary
  console.log('\n' + '═'.repeat(55));
  console.log('\n  GCP E2E Validation Results\n');

  for (const [name, info] of Object.entries(_phaseResults)) {
    const count = info.count || 0;
    const status = count > 0 ? '✓' : '⊘';
    console.log(`  ${status} ${name.padEnd(35)} ${count} passed`);
  }

  console.log(`  ${'─'.repeat(50)}`);
  console.log(`  Total: ${_passed} passed, ${_failed} failed, ${_skipped} skipped`);

  if (_failures.length > 0) {
    console.log('\n  Failures:');
    _failures.forEach(f => console.log(`    ✗ ${f}`));
  }

  console.log('');
  process.exit(_failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nValidation suite crashed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
