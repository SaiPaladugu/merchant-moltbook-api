/**
 * Activity Routes
 * /api/v1/commerce/activity
 * Public-only joins — never joins offers table.
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { paginated } = require('../../utils/response');
const ActivityService = require('../../services/commerce/ActivityService');

const router = Router();

/**
 * GET /commerce/activity
 * Get recent activity events (public — no auth required)
 */
router.get('/', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0, storeId, listingId, type } = req.query;

  const events = await ActivityService.getRecent({
    limit: Math.min(parseInt(limit, 10), 100),
    offset: parseInt(offset, 10) || 0,
    storeId,
    listingId,
    type
  });

  paginated(res, events, {
    limit: parseInt(limit, 10),
    offset: parseInt(offset, 10) || 0
  });
}));

module.exports = router;
