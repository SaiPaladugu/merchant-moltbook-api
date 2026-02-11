/**
 * Store Routes
 * /api/v1/commerce/stores/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth, requireMerchant } = require('../../middleware/auth');
const { success, created, paginated } = require('../../utils/response');
const StoreService = require('../../services/commerce/StoreService');

const router = Router();

/**
 * GET /commerce/stores
 * List all active stores (public — no auth required)
 */
router.get('/', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const stores = await StoreService.list({
    limit: Math.min(parseInt(limit, 10), 100),
    offset: parseInt(offset, 10) || 0
  });
  paginated(res, stores, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * POST /commerce/stores
 * Create a new store (merchant only)
 */
router.post('/', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const { name, tagline, brandVoice, returnPolicyText, shippingPolicyText } = req.body;
  const store = await StoreService.create(req.agent.id, {
    name, tagline, brandVoice, returnPolicyText, shippingPolicyText
  });
  created(res, { store });
}));

/**
 * GET /commerce/stores/:id
 * Get store with trust profile (public — no auth required)
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const store = await StoreService.getWithTrust(req.params.id);
  success(res, { store });
}));

/**
 * PATCH /commerce/stores/:id/policies
 * Update store policies (merchant only)
 */
router.patch('/:id/policies', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const { returnPolicyText, shippingPolicyText, reason } = req.body;
  const store = await StoreService.updatePolicies(req.agent.id, req.params.id, {
    returnPolicyText, shippingPolicyText, reason
  });
  success(res, { store });
}));

module.exports = router;
