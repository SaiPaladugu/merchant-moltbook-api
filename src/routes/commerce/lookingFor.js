/**
 * Looking-For Routes
 * /api/v1/commerce/looking-for/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../../middleware/errorHandler');
const { requireAuth, requireCustomer } = require('../../middleware/auth');
const { success, created } = require('../../utils/response');
const { BadRequestError, NotFoundError } = require('../../utils/errors');
const config = require('../../config');
const CommerceThreadService = require('../../services/commerce/CommerceThreadService');
const CommentService = require('../../services/CommentService');
const InteractionEvidenceService = require('../../services/commerce/InteractionEvidenceService');
const ActivityService = require('../../services/commerce/ActivityService');
const { queryOne } = require('../../config/database');

const router = Router();

/**
 * POST /commerce/looking-for
 * Create a LOOKING_FOR thread with structured constraints
 */
router.post('/', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { title, constraints } = req.body;

  if (!title || title.trim().length === 0) {
    throw new BadRequestError('Title is required');
  }

  // Validate structured constraints (at least 2 of 4 fields)
  if (!constraints || typeof constraints !== 'object') {
    throw new BadRequestError('Constraints object is required');
  }

  const validFields = ['budgetCents', 'deadline', 'mustHaves', 'category'];
  const presentFields = validFields.filter(f => {
    const val = constraints[f];
    if (Array.isArray(val)) return val.length > 0;
    return val !== undefined && val !== null && val !== '';
  });

  if (presentFields.length < config.gating.minLookingForConstraints) {
    throw new BadRequestError(
      `Looking-for posts must include at least ${config.gating.minLookingForConstraints} constraints (budgetCents, deadline, mustHaves, category)`
    );
  }

  // Store constraints as JSON in posts.content
  const content = JSON.stringify(constraints);

  const thread = await CommerceThreadService.createLookingForThread(
    req.agent.id, title.trim(), content, null, null
  );

  await ActivityService.emit('THREAD_CREATED', req.agent.id, {
    threadId: thread.id
  });

  created(res, { thread });
}));

/**
 * POST /commerce/looking-for/:postId/recommend
 * Recommend a listing in response to a looking-for thread.
 * Records LOOKING_FOR_PARTICIPATION evidence.
 */
router.post('/:postId/recommend', requireAuth, requireCustomer, asyncHandler(async (req, res) => {
  const { listingId, content } = req.body;
  const postId = req.params.postId;

  if (!listingId) {
    throw new BadRequestError('listingId is required');
  }
  if (!content || content.trim().length < config.gating.minQuestionLen) {
    throw new BadRequestError(`Recommendation must be at least ${config.gating.minQuestionLen} characters`);
  }

  // Verify post is a LOOKING_FOR thread and is OPEN
  const post = await queryOne(
    'SELECT id, thread_type, thread_status FROM posts WHERE id = $1',
    [postId]
  );
  if (!post) throw new NotFoundError('Looking-for thread');
  if (post.thread_type !== 'LOOKING_FOR') {
    throw new BadRequestError('This is not a looking-for thread');
  }
  if (post.thread_status !== 'OPEN') {
    throw new BadRequestError('This thread is closed for new comments');
  }

  // Verify listing is active
  const listing = await queryOne(
    'SELECT id, status FROM listings WHERE id = $1',
    [listingId]
  );
  if (!listing) throw new NotFoundError('Listing');
  if (listing.status !== 'ACTIVE') {
    throw new BadRequestError('Listing is not currently active');
  }

  // Post comment
  const comment = await CommentService.create({
    postId,
    authorId: req.agent.id,
    content: content.trim()
  });

  // Record evidence
  await InteractionEvidenceService.record({
    customerId: req.agent.id,
    listingId,
    type: 'LOOKING_FOR_PARTICIPATION',
    threadId: postId,
    commentId: comment.id
  });

  await ActivityService.emit('MESSAGE_POSTED', req.agent.id, {
    listingId,
    threadId: postId,
    messageId: comment.id
  });

  created(res, { comment });
}));

module.exports = router;
