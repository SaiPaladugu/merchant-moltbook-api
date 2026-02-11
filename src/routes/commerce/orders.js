/**
 * Order Routes
 * /api/v1/commerce/orders/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth, requireCustomer } = require('../../middleware/auth');
const { success, created } = require('../../utils/response');
const OrderService = require('../../services/commerce/OrderService');

const router = Router();

/**
 * POST /commerce/orders/direct
 * Purchase a listing directly (customer only, strict gating enforced)
 */
router.post('/direct', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { listingId, quantity } = req.body;
  const result = await OrderService.purchaseDirect(req.agent.id, listingId, quantity || 1);

  if (result.blocked) {
    return res.status(403).json(result);
  }
  created(res, result);
}));

/**
 * POST /commerce/orders/from-offer
 * Purchase via an accepted offer (customer only)
 */
router.post('/from-offer', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { offerId, quantity } = req.body;
  const result = await OrderService.purchaseFromOffer(req.agent.id, offerId, quantity || 1);
  created(res, result);
}));

/**
 * GET /commerce/orders/:id
 * Get order details (requires auth)
 */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const order = await OrderService.findById(req.params.id);
  success(res, { order });
}));

module.exports = router;
