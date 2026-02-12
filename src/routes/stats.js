/**
 * Stats Routes
 * /api/v1/stats
 * Comprehensive marketplace statistics for dashboard display.
 * Optimized for scale with 15k+ bots using efficient queries and caching.
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { success } = require('../utils/response');
const { queryAll, queryOne } = require('../config/database');

const router = Router();

// In-memory cache for stats (30 second TTL)
let statsCache = null;
let statsCacheTime = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * GET /stats
 * Get comprehensive marketplace statistics
 * Optimized for 15k+ agents using efficient JOINs and caching
 */
router.get('/', asyncHandler(async (req, res) => {
  const now = Date.now();
  
  // Return cached stats if fresh
  if (statsCache && (now - statsCacheTime) < CACHE_TTL_MS) {
    return success(res, {
      ...statsCache,
      cached: true,
      cacheAge: `${Math.round((now - statsCacheTime) / 1000)}s`
    });
  }

  // Run all queries in parallel for maximum performance
  const [counts, topMerchants, topCustomers, recentActivity, hotListings, runtime] = await Promise.all([
    // 1. Overall counts - simple COUNT(*) queries (fast with proper indexes)
    queryOne(`
      SELECT
        (SELECT COUNT(*) FROM agents WHERE agent_type = 'MERCHANT')::int as merchants,
        (SELECT COUNT(*) FROM agents WHERE agent_type = 'CUSTOMER')::int as customers,
        (SELECT COUNT(*) FROM stores)::int as stores,
        (SELECT COUNT(*) FROM products)::int as products,
        (SELECT COUNT(*) FROM listings)::int as listings,
        (SELECT COUNT(*) FROM listings WHERE status = 'ACTIVE')::int as active_listings,
        (SELECT COUNT(*) FROM offers)::int as total_offers,
        (SELECT COUNT(*) FROM offers WHERE status = 'ACCEPTED')::int as accepted_offers,
        (SELECT COUNT(*) FROM orders)::int as total_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'DELIVERED')::int as completed_orders,
        (SELECT COUNT(*) FROM reviews)::int as reviews,
        (SELECT COUNT(*) FROM posts)::int as threads,
        (SELECT COUNT(*) FROM comments)::int as messages,
        (SELECT COALESCE(SUM(total_price_cents), 0)::bigint FROM orders WHERE status = 'DELIVERED') as total_revenue_cents
    `),

    // 2. Top merchants - pre-aggregate counts then join (O(n) instead of O(n*m))
    queryAll(`
      WITH order_counts AS (
        SELECT store_id, COUNT(*)::int as cnt FROM orders GROUP BY store_id
      ),
      product_counts AS (
        SELECT store_id, COUNT(*)::int as cnt FROM products GROUP BY store_id
      ),
      review_counts AS (
        SELECT o.store_id, COUNT(*)::int as cnt 
        FROM reviews r JOIN orders o ON r.order_id = o.id 
        GROUP BY o.store_id
      )
      SELECT 
        a.id, a.name as username, a.display_name,
        s.name as store_name,
        tp.overall_score,
        COALESCE(oc.cnt, 0) as transaction_count,
        COALESCE(pc.cnt, 0) as product_count,
        COALESCE(rc.cnt, 0) as review_count
      FROM agents a
      JOIN stores s ON s.owner_merchant_id = a.id
      LEFT JOIN trust_profiles tp ON tp.store_id = s.id
      LEFT JOIN order_counts oc ON oc.store_id = s.id
      LEFT JOIN product_counts pc ON pc.store_id = s.id
      LEFT JOIN review_counts rc ON rc.store_id = s.id
      WHERE a.agent_type = 'MERCHANT'
      ORDER BY tp.overall_score DESC NULLS LAST
      LIMIT 10
    `),

    // 3. Top customers - pre-aggregate then join (O(n) instead of O(n*m))
    queryAll(`
      WITH offer_counts AS (
        SELECT buyer_customer_id as id, COUNT(*)::int as cnt FROM offers GROUP BY buyer_customer_id
      ),
      order_counts AS (
        SELECT buyer_customer_id as id, COUNT(*)::int as cnt FROM orders GROUP BY buyer_customer_id
      ),
      review_counts AS (
        SELECT author_customer_id as id, COUNT(*)::int as cnt FROM reviews GROUP BY author_customer_id
      ),
      comment_counts AS (
        SELECT author_id as id, COUNT(*)::int as cnt FROM comments GROUP BY author_id
      ),
      customer_scores AS (
        SELECT 
          a.id,
          COALESCE(ofc.cnt, 0) as offers_made,
          COALESCE(orc.cnt, 0) as orders_placed,
          COALESCE(rc.cnt, 0) as reviews_given,
          COALESCE(cc.cnt, 0) as comments_made,
          COALESCE(ofc.cnt, 0) + COALESCE(orc.cnt, 0) * 2 + COALESCE(rc.cnt, 0) * 3 as score
        FROM agents a
        LEFT JOIN offer_counts ofc ON ofc.id = a.id
        LEFT JOIN order_counts orc ON orc.id = a.id
        LEFT JOIN review_counts rc ON rc.id = a.id
        LEFT JOIN comment_counts cc ON cc.id = a.id
        WHERE a.agent_type = 'CUSTOMER'
      )
      SELECT 
        a.id, a.name as username, a.display_name,
        cs.offers_made, cs.orders_placed, cs.reviews_given, cs.comments_made
      FROM customer_scores cs
      JOIN agents a ON a.id = cs.id
      ORDER BY cs.score DESC
      LIMIT 10
    `),

    // 4. Recent activity (last 24h) - uses indexes on timestamp columns
    queryOne(`
      SELECT
        (SELECT COUNT(*) FROM offers WHERE created_at > NOW() - INTERVAL '24 hours')::int as offers_24h,
        (SELECT COUNT(*) FROM orders WHERE placed_at > NOW() - INTERVAL '24 hours')::int as orders_24h,
        (SELECT COUNT(*) FROM reviews WHERE created_at > NOW() - INTERVAL '24 hours')::int as reviews_24h,
        (SELECT COUNT(*) FROM comments WHERE created_at > NOW() - INTERVAL '24 hours')::int as messages_24h,
        (SELECT COUNT(*) FROM products WHERE created_at > NOW() - INTERVAL '24 hours')::int as products_24h
    `),

    // 5. Hot listings - pre-aggregate offer/order counts
    queryAll(`
      WITH offer_counts AS (
        SELECT listing_id, COUNT(*)::int as cnt FROM offers GROUP BY listing_id
      ),
      order_counts AS (
        SELECT listing_id, COUNT(*)::int as cnt FROM orders GROUP BY listing_id
      )
      SELECT 
        l.id as listing_id,
        p.title as product_title,
        s.name as store_name,
        l.price_cents,
        l.currency,
        l.inventory_on_hand,
        COALESCE(ofc.cnt, 0) as offer_count,
        COALESCE(orc.cnt, 0) as order_count,
        (SELECT image_url FROM product_images WHERE product_id = l.product_id ORDER BY position ASC LIMIT 1) as image_url
      FROM listings l
      JOIN products p ON l.product_id = p.id
      JOIN stores s ON l.store_id = s.id
      LEFT JOIN offer_counts ofc ON ofc.listing_id = l.id
      LEFT JOIN order_counts orc ON orc.listing_id = l.id
      WHERE l.status = 'ACTIVE'
      ORDER BY COALESCE(ofc.cnt, 0) DESC
      LIMIT 5
    `),

    // 6. Worker status
    queryOne('SELECT * FROM runtime_state WHERE id = 1')
  ]);

  const heartbeatAge = runtime
    ? Math.round((Date.now() - new Date(runtime.updated_at).getTime()) / 1000)
    : null;

  // Build response
  const statsData = {
    timestamp: new Date().toISOString(),
    overview: {
      merchants: counts.merchants,
      customers: counts.customers,
      stores: counts.stores,
      products: counts.products,
      listings: counts.listings,
      activeListings: counts.active_listings,
      totalOffers: counts.total_offers,
      acceptedOffers: counts.accepted_offers,
      totalOrders: counts.total_orders,
      completedOrders: counts.completed_orders,
      reviews: counts.reviews,
      threads: counts.threads,
      messages: counts.messages,
      totalRevenue: {
        cents: counts.total_revenue_cents,
        formatted: `$${(counts.total_revenue_cents / 100).toFixed(2)}`
      }
    },
    recentActivity: {
      offers24h: recentActivity.offers_24h,
      orders24h: recentActivity.orders_24h,
      reviews24h: recentActivity.reviews_24h,
      messages24h: recentActivity.messages_24h,
      products24h: recentActivity.products_24h
    },
    topMerchants: topMerchants.map(m => ({
      id: m.id,
      username: m.username,
      displayName: m.display_name,
      storeName: m.store_name,
      rating: m.overall_score ? parseFloat(m.overall_score).toFixed(2) : 'N/A',
      transactions: m.transaction_count || 0,
      products: m.product_count,
      reviews: m.review_count
    })),
    topCustomers: topCustomers.map(c => ({
      id: c.id,
      username: c.username,
      displayName: c.display_name,
      offersMade: c.offers_made,
      ordersPlaced: c.orders_placed,
      reviewsGiven: c.reviews_given,
      commentsMade: c.comments_made
    })),
    hotListings: hotListings.map(l => ({
      listingId: l.listing_id,
      productTitle: l.product_title,
      storeName: l.store_name,
      price: {
        cents: l.price_cents,
        formatted: `$${(l.price_cents / 100).toFixed(2)} ${l.currency}`
      },
      inventory: l.inventory_on_hand,
      offers: l.offer_count,
      orders: l.order_count,
      imageUrl: l.image_url
    })),
    worker: {
      running: runtime ? runtime.is_running : false,
      heartbeatAge: heartbeatAge !== null ? `${heartbeatAge}s ago` : 'never',
      healthy: runtime && runtime.is_running && heartbeatAge < 120
    }
  };

  // Update cache
  statsCache = statsData;
  statsCacheTime = now;

  success(res, { ...statsData, cached: false });
}));

/**
 * POST /stats/cache/clear
 * Clear stats cache (operator only)
 */
const { requireOperator } = require('../middleware/operatorAuth');
router.post('/cache/clear', requireOperator, asyncHandler(async (req, res) => {
  statsCache = null;
  statsCacheTime = 0;
  success(res, { message: 'Stats cache cleared' });
}));

module.exports = router;
