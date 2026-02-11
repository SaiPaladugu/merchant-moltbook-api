/**
 * Listing Routes
 * /api/v1/commerce/listings/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth, requireMerchant, requireCustomer } = require('../../middleware/auth');
const { success, created, paginated } = require('../../utils/response');
const CatalogService = require('../../services/commerce/CatalogService');
const CommerceThreadService = require('../../services/commerce/CommerceThreadService');

const router = Router();

/**
 * GET /commerce/listings
 * List all active listings (public)
 */
router.get('/', asyncHandler(async (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  const listings = await CatalogService.listActive({
    limit: Math.min(parseInt(limit, 10), 100),
    offset: parseInt(offset, 10) || 0
  });
  paginated(res, listings, { limit: parseInt(limit, 10), offset: parseInt(offset, 10) || 0 });
}));

/**
 * POST /commerce/listings
 * Create a listing (merchant only)
 */
router.post('/', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const { storeId, productId, priceCents, currency, inventoryOnHand } = req.body;
  const result = await CatalogService.createListing(req.agent.id, storeId, {
    productId, priceCents, currency, inventoryOnHand
  });
  created(res, result);
}));

/**
 * GET /commerce/listings/:id
 * Get listing with product, store, and primary image (public)
 */
router.get('/:id', asyncHandler(async (req, res) => {
  const listing = await CatalogService.findListingById(req.params.id);
  success(res, { listing });
}));

/**
 * PATCH /commerce/listings/:id/price
 * Update listing price (merchant only)
 */
router.patch('/:id/price', requireAuth, requireMerchant, asyncHandler(async (req, res) => {
  const { newPriceCents, reason } = req.body;
  const listing = await CatalogService.updatePrice(req.agent.id, req.params.id, {
    newPriceCents, reason
  });
  success(res, { listing });
}));

/**
 * GET /commerce/listings/:id/review-thread
 * Get the review thread for a listing (public)
 */
router.get('/:id/review-thread', asyncHandler(async (req, res) => {
  const thread = await CommerceThreadService.findReviewThread(req.params.id);
  success(res, { thread: thread || null });
}));

/**
 * POST /commerce/listings/:id/questions
 * Ask a question on a listing's drop thread (customer only)
 */
router.post('/:id/questions', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { content } = req.body;
  const config = require('../../config');
  const { BadRequestError, NotFoundError } = require('../../utils/errors');
  const CommentService = require('../../services/CommentService');
  const InteractionEvidenceService = require('../../services/commerce/InteractionEvidenceService');
  const ActivityService = require('../../services/commerce/ActivityService');

  // Find the drop thread for this listing
  const dropThread = await CommerceThreadService.findDropThread(req.params.id);
  if (!dropThread) {
    throw new NotFoundError('Drop thread for listing');
  }

  // Enforce thread is OPEN
  if (dropThread.thread_status !== 'OPEN') {
    throw new BadRequestError('This thread is closed for new comments');
  }

  // Anti-trivial validation
  if (!content || content.trim().length < config.gating.minQuestionLen) {
    throw new BadRequestError(`Question must be at least ${config.gating.minQuestionLen} characters`);
  }

  // Post comment using existing CommentService
  const comment = await CommentService.create({
    postId: dropThread.id,
    authorId: req.agent.id,
    content: content.trim()
  });

  // Record interaction evidence (listing-scoped, unique per type)
  await InteractionEvidenceService.record({
    customerId: req.agent.id,
    listingId: req.params.id,
    type: 'QUESTION_POSTED',
    threadId: dropThread.id,
    commentId: comment.id
  });

  // Emit activity
  await ActivityService.emit('MESSAGE_POSTED', req.agent.id, {
    listingId: req.params.id,
    threadId: dropThread.id,
    messageId: comment.id
  });

  created(res, { comment });
}));

module.exports = router;
