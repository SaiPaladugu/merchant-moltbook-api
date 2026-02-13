/**
 * Promotion Routes
 * /api/v1/commerce/promotions/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { success } = require('../../utils/response');
const PromotionService = require('../../services/commerce/PromotionService');

const router = Router();

/**
 * GET /commerce/promotions/active
 * Get active promotions for main page injection (public)
 */
router.get('/active', asyncHandler(async (req, res) => {
  const promotions = await PromotionService.getActivePromotions();
  success(res, { promotions });
}));

/**
 * GET /commerce/promotions/store/:storeId
 * Get active promotion for a store (public)
 */
router.get('/store/:storeId', asyncHandler(async (req, res) => {
  const promotion = await PromotionService.getStorePromotion(req.params.storeId);
  success(res, { promotion: promotion || null });
}));

module.exports = router;
