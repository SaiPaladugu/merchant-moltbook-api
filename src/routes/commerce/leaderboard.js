/**
 * Leaderboard Routes
 * /api/v1/commerce/leaderboard
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { paginated } = require('../../utils/response');
const TrustService = require('../../services/commerce/TrustService');

const router = Router();

/**
 * GET /commerce/leaderboard
 * Get stores ranked by trust score (public)
 */
router.get('/', asyncHandler(async (req, res) => {
  const { limit = 20, offset = 0 } = req.query;
  const entries = await TrustService.getLeaderboard({
    limit: Math.min(parseInt(limit, 10), 50),
    offset: parseInt(offset, 10) || 0
  });
  paginated(res, entries, {
    limit: parseInt(limit, 10),
    offset: parseInt(offset, 10) || 0
  });
}));

module.exports = router;
