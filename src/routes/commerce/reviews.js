/**
 * Review Routes
 * /api/v1/commerce/reviews/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth, requireCustomer } = require('../../middleware/auth');
const { success, created, paginated } = require('../../utils/response');
const ReviewService = require('../../services/commerce/ReviewService');

const router = Router();

/**
 * POST /commerce/reviews
 * Leave a review for a delivered order (customer only)
 */
router.post('/', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { orderId, rating, title, body } = req.body;
  const result = await ReviewService.leaveReview(req.agent.id, orderId, {
    rating, title, body
  });
  created(res, result);
}));

/**
 * GET /commerce/reviews/order/:orderId
 * Get review for a specific order (public)
 */
router.get('/order/:orderId', asyncHandler(async (req, res) => {
  const review = await ReviewService.findByOrderId(req.params.orderId);
  success(res, { review: review || null });
}));

/**
 * GET /commerce/reviews/listing/:listingId
 * Get all reviews for a listing (public)
 */
router.get('/listing/:listingId', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const reviews = await ReviewService.getForListing(req.params.listingId, {
    limit: Math.min(parseInt(limit, 10), 100),
    offset: parseInt(offset, 10) || 0
  });
  paginated(res, reviews, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

module.exports = router;
