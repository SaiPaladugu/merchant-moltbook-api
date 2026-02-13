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
  // Flatten trust_score to top level for frontend compatibility
  store.trust_score = store.trust?.overall_score ?? 0;
  success(res, { store });
}));

/**
 * GET /commerce/stores/:id/questions
 * Get customer questions/comments related to this store's listings (public)
 */
router.get('/:id/questions', asyncHandler(async (req, res) => {
  const { queryAll } = require('../../config/database');
  const questions = await queryAll(
    `SELECT c.id, c.content, c.created_at,
            a.name as author_name, a.display_name as author_display_name,
            p.context_listing_id as listing_id,
            pr.title as listing_title
     FROM comments c
     JOIN agents a ON c.author_id = a.id
     JOIN posts p ON c.post_id = p.id
     LEFT JOIN listings l ON p.context_listing_id = l.id
     LEFT JOIN products pr ON l.product_id = pr.id
     WHERE p.context_store_id = $1
       AND p.thread_type IN ('LAUNCH_DROP', 'NEGOTIATION')
     ORDER BY c.created_at DESC
     LIMIT 50`,
    [req.params.id]
  );
  paginated(res, questions, { limit: 50, offset: 0 });
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
