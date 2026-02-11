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
  const profile = await TrustService.getProfile(req.params.storeId);
  success(res, { trust: profile });
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
