/**
 * Spotlight Routes
 * /api/v1/commerce/spotlight
 * Most discussed listing, fastest rising store, most negotiated listing.
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { success } = require('../../utils/response');
const { queryAll, queryOne } = require('../../config/database');

const router = Router();

/**
 * GET /commerce/spotlight
 * Get spotlight metrics (public)
 */
router.get('/', asyncHandler(async (req, res) => {
  // Most discussed listing (highest comment count on LAUNCH_DROP threads)
  const mostDiscussed = await queryOne(
    `SELECT p.context_listing_id as listing_id,
            p.title as thread_title,
            p.comment_count,
            pr.title as product_title,
            s.name as store_name
     FROM posts p
     JOIN listings l ON p.context_listing_id = l.id
     JOIN products pr ON l.product_id = pr.id
     JOIN stores s ON l.store_id = s.id
     WHERE p.thread_type = 'LAUNCH_DROP'
       AND p.context_listing_id IS NOT NULL
     ORDER BY p.comment_count DESC
     LIMIT 1`
  );

  // Fastest rising store (most trust events in last 24h)
  const fastestRising = await queryOne(
    `SELECT te.store_id,
            s.name as store_name,
            COUNT(*)::int as trust_event_count,
            SUM(te.delta_overall) as total_delta
     FROM trust_events te
     JOIN stores s ON te.store_id = s.id
     WHERE te.created_at > NOW() - INTERVAL '24 hours'
     GROUP BY te.store_id, s.name
     ORDER BY SUM(te.delta_overall) DESC
     LIMIT 1`
  );

  // Most negotiated listing (most offers)
  const mostNegotiated = await queryOne(
    `SELECT o.listing_id,
            COUNT(*)::int as offer_count,
            pr.title as product_title,
            s.name as store_name
     FROM offers o
     JOIN listings l ON o.listing_id = l.id
     JOIN products pr ON l.product_id = pr.id
     JOIN stores s ON l.store_id = s.id
     GROUP BY o.listing_id, pr.title, s.name
     ORDER BY COUNT(*) DESC
     LIMIT 1`
  );

  success(res, {
    spotlight: {
      mostDiscussed: mostDiscussed || null,
      fastestRising: fastestRising || null,
      mostNegotiated: mostNegotiated || null
    }
  });
}));

module.exports = router;
