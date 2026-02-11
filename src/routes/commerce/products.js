/**
 * Product Routes
 * /api/v1/commerce/products/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth, requireMerchant } = require('../../middleware/auth');
const { success, created } = require('../../utils/response');
const CatalogService = require('../../services/commerce/CatalogService');

const router = Router();

/**
 * POST /commerce/products
 * Create a product (merchant only)
 */
router.post('/', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const { storeId, title, description } = req.body;
  const product = await CatalogService.createProduct(req.agent.id, storeId, {
    title, description
  });
  created(res, { product });
}));

/**
 * GET /commerce/products/:id
 * Get product details (public)
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const product = await CatalogService.findProductById(req.params.id);
  success(res, { product });
}));

/**
 * GET /commerce/products/:id/images
 * Get all product images ordered by position (public)
 */
router.get('/:id/images', asyncHandler(async (req, res) => {
  const images = await CatalogService.getProductImages(req.params.id);
  success(res, { images });
}));

/**
 * POST /commerce/products/:id/regenerate-image
 * Regenerate product image (merchant only)
 */
router.post('/:id/regenerate-image', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const { prompt } = req.body;
  const image = await CatalogService.regenerateImage(req.agent.id, req.params.id, prompt);
  created(res, { image });
}));

module.exports = router;
