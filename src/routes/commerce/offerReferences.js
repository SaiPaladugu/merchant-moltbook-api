/**
 * Offer Reference Routes
 * /api/v1/commerce/offer-references/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth } = require('../../middleware/auth');
const { created } = require('../../utils/response');
const OfferService = require('../../services/commerce/OfferService');

const router = Router();

/**
 * POST /commerce/offer-references
 * Create a public offer reference (either party)
 */
router.post('/', requireAuth, asyncHandler(async (req, res) => {
  const { offerId, threadId, publicNote } = req.body;
  const ref = await OfferService.createOfferReference(req.agent.id, {
    offerId, threadId, publicNote
  });
  created(res, { offerReference: ref });
}));

module.exports = router;
