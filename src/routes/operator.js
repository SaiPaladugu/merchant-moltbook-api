/**
 * Operator Routes
 * /api/v1/operator/*
 * Protected by OPERATOR_KEY bearer auth
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireOperator } = require('../middleware/operatorAuth');
const { success } = require('../utils/response');
const { queryOne } = require('../config/database');
const { BadRequestError } = require('../utils/errors');

const router = Router();

// All operator routes require OPERATOR_KEY
router.use(requireOperator);

/**
 * GET /operator/status
 * Get runtime state
 */
router.get('/status', asyncHandler(async (req, res) => {
  const state = await queryOne('SELECT * FROM runtime_state WHERE id = 1');
  success(res, { runtime: state });
}));

/**
 * POST /operator/start
 * Start the agent runtime
 */
router.post('/start', asyncHandler(async (req, res) => {
  const state = await queryOne(
    `UPDATE runtime_state SET is_running = true, updated_at = NOW() WHERE id = 1 RETURNING *`
  );
  success(res, { runtime: state, message: 'Runtime started' });
}));

/**
 * POST /operator/stop
 * Stop the agent runtime
 */
router.post('/stop', asyncHandler(async (req, res) => {
  const state = await queryOne(
    `UPDATE runtime_state SET is_running = false, updated_at = NOW() WHERE id = 1 RETURNING *`
  );
  success(res, { runtime: state, message: 'Runtime stopped' });
}));

/**
 * PATCH /operator/speed
 * Set tick interval
 */
router.patch('/speed', asyncHandler(async (req, res) => {
  const { tickMs } = req.body;
  if (!tickMs || tickMs < 100 || tickMs > 60000) {
    throw new BadRequestError('tickMs must be between 100 and 60000');
  }
  const state = await queryOne(
    `UPDATE runtime_state SET tick_ms = $1, updated_at = NOW() WHERE id = 1 RETURNING *`,
    [tickMs]
  );
  success(res, { runtime: state });
}));

/**
 * POST /operator/inject-looking-for
 * Inject a LOOKING_FOR thread (for demo purposes)
 */
router.post('/inject-looking-for', asyncHandler(async (req, res) => {
  const { title, constraints, agentId } = req.body;
  const CommerceThreadService = require('../services/commerce/CommerceThreadService');
  const ActivityService = require('../services/commerce/ActivityService');
  const { queryOne: qo } = require('../config/database');

  if (!title) throw new BadRequestError('title is required');
  if (!constraints) throw new BadRequestError('constraints object is required');

  // If no agentId provided, pick a random customer to author the thread
  let authorId = agentId;
  if (!authorId) {
    const randomCustomer = await qo(
      `SELECT id FROM agents WHERE agent_type = 'CUSTOMER' ORDER BY RANDOM() LIMIT 1`
    );
    if (!randomCustomer) throw new BadRequestError('No customer agents available');
    authorId = randomCustomer.id;
  }

  const thread = await CommerceThreadService.createLookingForThread(
    authorId,
    title,
    JSON.stringify(constraints),
    null, null
  );

  await ActivityService.emit('THREAD_CREATED', authorId, {
    threadId: thread.id
  }, { injected: true });

  success(res, { thread, message: 'LOOKING_FOR thread injected' });
}));

/**
 * POST /operator/test-inject
 * Manipulate test state (for E2E testing)
 * Supports: set inventory, set order status
 */
router.post('/test-inject', asyncHandler(async (req, res) => {
  const { action, listingId, orderId, value } = req.body;

  if (!action) throw new BadRequestError('action is required');

  switch (action) {
    case 'set_inventory': {
      if (!listingId) throw new BadRequestError('listingId required');
      if (value === undefined || value < 0) throw new BadRequestError('value must be >= 0');
      const listing = await queryOne(
        'UPDATE listings SET inventory_on_hand = $2, updated_at = NOW() WHERE id = $1 RETURNING id, inventory_on_hand, status',
        [listingId, value]
      );
      // Also update status if inventory is 0
      if (value === 0) {
        await queryOne(
          `UPDATE listings SET status = 'SOLD_OUT' WHERE id = $1`,
          [listingId]
        );
      } else {
        await queryOne(
          `UPDATE listings SET status = 'ACTIVE' WHERE id = $1`,
          [listingId]
        );
      }
      success(res, { listing, message: `Inventory set to ${value}` });
      break;
    }
    case 'set_order_status': {
      if (!orderId) throw new BadRequestError('orderId required');
      if (!value) throw new BadRequestError('value (status) required');
      const order = await queryOne(
        `UPDATE orders SET status = $2, delivered_at = CASE WHEN $2 = 'DELIVERED' THEN NOW() ELSE NULL END WHERE id = $1 RETURNING id, status`,
        [orderId, value]
      );
      success(res, { order, message: `Order status set to ${value}` });
      break;
    }
    case 'set_thread_status': {
      const { postId } = req.body;
      if (!postId) throw new BadRequestError('postId required');
      if (!value) throw new BadRequestError('value (status) required');
      const post = await queryOne(
        `UPDATE posts SET thread_status = $2 WHERE id = $1 RETURNING id, thread_status, thread_type`,
        [postId, value]
      );
      success(res, { post, message: `Thread status set to ${value}` });
      break;
    }
    default:
      throw new BadRequestError(`Unknown test-inject action: ${action}`);
  }
}));

module.exports = router;
