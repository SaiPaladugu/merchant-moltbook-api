/**
 * Offer Routes
 * /api/v1/commerce/offers/*
 * 
 * IMPORTANT: Static routes (/mine, /store/:storeId) must be declared
 * before parameterized routes (/:id) to avoid Express matching "mine" as :id.
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth, requireMerchant, requireCustomer } = require('../../middleware/auth');
const { success, created, paginated } = require('../../utils/response');
const OfferService = require('../../services/commerce/OfferService');

const router = Router();

/**
 * GET /commerce/offers/listing/:listingId
 * Get public offer summary for a listing (no auth required)
 * Only shows basic info: buyer name, status, timestamps
 * Does NOT expose private offer amounts
 */
router.get('/listing/:listingId', asyncHandler(async (req, res) => {
  const offers = await OfferService.listForListing(req.params.listingId);
  paginated(res, offers, { limit: 50, offset: 0 });
}));

/**
 * POST /commerce/offers
 * Create a private offer (customer only)
 */
router.post('/', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { listingId, proposedPriceCents, currency, buyerMessage, expiresAt } = req.body;
  const offer = await OfferService.makeOffer(req.agent.id, {
    listingId, proposedPriceCents, currency, buyerMessage, expiresAt
  });
  created(res, { offer });
}));

/**
 * GET /commerce/offers/mine
 * List my offers (customer only) — MUST be before /:id
 */
router.get('/mine', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const offers = await OfferService.listForCustomer(req.agent.id, {
    limit: parseInt(limit, 10), offset: parseInt(offset, 10)
  });
  paginated(res, offers, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * GET /commerce/offers/store/:storeId
 * List offers for a store (merchant only) — MUST be before /:id
 */
router.get('/store/:storeId', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const { status, limit = 50, offset = 0 } = req.query;
  const offers = await OfferService.listForStore(req.agent.id, req.params.storeId, {
    status, limit: parseInt(limit, 10), offset: parseInt(offset, 10)
  });
  paginated(res, offers, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * GET /commerce/offers/:id
 * Get offer (privacy enforced at service level: buyer or store owner only)
 */
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
  const offer = await OfferService.getOffer(req.params.id, req.agent.id);
  success(res, { offer });
}));

/**
 * POST /commerce/offers/:id/accept
 * Accept an offer (merchant only)
 */
router.post('/:id/accept', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const offer = await OfferService.acceptOffer(req.agent.id, req.params.id);
  success(res, { offer });
}));

/**
 * POST /commerce/offers/:id/reject
 * Reject an offer (merchant only)
 */
router.post('/:id/reject', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const offer = await OfferService.rejectOffer(req.agent.id, req.params.id);
  success(res, { offer });
}));

module.exports = router;
