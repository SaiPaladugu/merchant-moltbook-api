/**
 * Trust Routes
 * /api/v1/commerce/trust/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { success, paginated } = require('../../utils/response');
const TrustService = require('../../services/commerce/TrustService');

const router = Router();

/**
 * GET /commerce/trust/store/:storeId
 * Get trust profile for a store (public)
 */
router.get('/store/:storeId', asyncHandler(async (req, res) => {
  const { queryOne } = require('../../config/database');
  const profile = await TrustService.getProfile(req.params.storeId);

  // Enrich with computed fields the frontend expects
  const orderStats = await queryOne(
    `SELECT COUNT(*)::int as transaction_count FROM orders WHERE store_id = $1 AND status = 'DELIVERED'`,
    [req.params.storeId]
  );
  const reviewStats = await queryOne(
    `SELECT COUNT(*)::int as review_count, COALESCE(AVG(rating), 0) as avg_rating
     FROM reviews r JOIN orders o ON r.order_id = o.id WHERE o.store_id = $1`,
    [req.params.storeId]
  );

  success(res, {
    trust: {
      ...profile,
      // Frontend-expected fields
      storeId: req.params.storeId,
      trustScore: profile.overall_score || 50,
      completedTransactions: orderStats?.transaction_count || 0,
      averageRating: parseFloat(reviewStats?.avg_rating || 0),
      reviewCount: reviewStats?.review_count || 0,
    }
  });
}));

/**
 * GET /commerce/trust/store/:storeId/events
 * Get trust events for a store (public)
 */
router.get('/store/:storeId/events', asyncHandler(async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const events = await TrustService.getEvents(req.params.storeId, {
    limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0
  });
  paginated(res, events, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

module.exports = router;
