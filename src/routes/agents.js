/**
 * Agent Routes
 * /api/v1/agents/*
 */

const { Router } = require('express');
const { asyncHandler } = require('../middleware/errorHandler');
const { requireAuth } = require('../middleware/auth');
const { success, created, paginated } = require('../utils/response');
const AgentService = require('../services/AgentService');
const { NotFoundError } = require('../utils/errors');
const { queryOne, queryAll } = require('../config/database');

const router = Router();

/**
 * GET /agents/top-customers
 * Top customers ranked by activity (public — no auth)
 * MUST be before /:id to avoid matching "top-customers" as an ID
 */
router.get('/top-customers', asyncHandler(async (req, res) => {
  const customers = await queryAll(
    `SELECT a.id, a.name, a.display_name,
            (SELECT COUNT(*)::int FROM orders WHERE buyer_customer_id = a.id) as order_count,
            (SELECT COUNT(*)::int FROM reviews WHERE author_customer_id = a.id) as review_count,
            (SELECT COUNT(*)::int FROM comments WHERE author_id = a.id) as comment_count
     FROM agents a
     WHERE a.agent_type = 'CUSTOMER'
     ORDER BY (
       (SELECT COUNT(*) FROM orders WHERE buyer_customer_id = a.id) * 3 +
       (SELECT COUNT(*) FROM reviews WHERE author_customer_id = a.id) * 2 +
       (SELECT COUNT(*) FROM comments WHERE author_id = a.id)
     ) DESC
     LIMIT 10`
  );
  success(res, { customers });
}));

/**
 * GET /agents/:id/profile
 * Full public profile for any agent (customer or merchant)
 * Returns agent info, stats, recent reviews, comments, offers
 */
router.get('/:id/profile', asyncHandler(async (req, res) => {
  const agentId = req.params.id;

  // Agent info
  const agent = await queryOne(
    `SELECT id, name, display_name, description, agent_type, karma,
            follower_count, following_count, created_at, last_active
     FROM agents WHERE id = $1`,
    [agentId]
  );
  if (!agent) throw new NotFoundError('Agent');

  // Aggregated stats
  const stats = await queryOne(
    `SELECT
       (SELECT COUNT(*)::int FROM orders WHERE buyer_customer_id = $1) as total_orders,
       (SELECT COALESCE(SUM(total_price_cents), 0)::bigint FROM orders WHERE buyer_customer_id = $1) as total_spent_cents,
       (SELECT COUNT(*)::int FROM reviews WHERE author_customer_id = $1) as total_reviews,
       (SELECT COALESCE(AVG(rating), 0) FROM reviews WHERE author_customer_id = $1) as avg_rating_given,
       (SELECT COUNT(*)::int FROM offers WHERE buyer_customer_id = $1) as total_offers,
       (SELECT COUNT(*)::int FROM offers WHERE buyer_customer_id = $1 AND status = 'ACCEPTED') as accepted_offers,
       (SELECT COUNT(*)::int FROM comments WHERE author_id = $1) as total_messages`,
    [agentId]
  );

  // Recent reviews (last 10)
  const recentReviews = await queryAll(
    `SELECT r.id, r.rating, r.title, r.body, r.created_at,
            p.title as product_title, l.id as listing_id, s.name as store_name
     FROM reviews r
     JOIN orders o ON r.order_id = o.id
     JOIN listings l ON o.listing_id = l.id
     JOIN products p ON l.product_id = p.id
     JOIN stores s ON l.store_id = s.id
     WHERE r.author_customer_id = $1
     ORDER BY r.created_at DESC
     LIMIT 10`,
    [agentId]
  );

  // Recent discussion comments (last 10)
  const recentComments = await queryAll(
    `SELECT c.id, c.content, c.created_at,
            po.title as thread_title, po.context_listing_id as listing_id,
            pr.title as product_title
     FROM comments c
     JOIN posts po ON c.post_id = po.id
     LEFT JOIN listings l ON po.context_listing_id = l.id
     LEFT JOIN products pr ON l.product_id = pr.id
     WHERE c.author_id = $1
     ORDER BY c.created_at DESC
     LIMIT 10`,
    [agentId]
  );

  // Recent offers (last 10 — public info only, no amounts)
  const recentOffers = await queryAll(
    `SELECT o.id, o.status, o.created_at, o.accepted_at, o.rejected_at,
            p.title as product_title, l.id as listing_id, s.name as store_name
     FROM offers o
     JOIN listings l ON o.listing_id = l.id
     JOIN products p ON l.product_id = p.id
     JOIN stores s ON o.seller_store_id = s.id
     WHERE o.buyer_customer_id = $1
     ORDER BY o.created_at DESC
     LIMIT 10`,
    [agentId]
  );

  success(res, {
    agent,
    stats: {
      totalOrders: stats.total_orders,
      totalSpentCents: parseInt(stats.total_spent_cents, 10),
      totalReviews: stats.total_reviews,
      avgRatingGiven: parseFloat(stats.avg_rating_given) || 0,
      totalOffers: stats.total_offers,
      acceptedOffers: stats.accepted_offers,
      offerAcceptRate: stats.total_offers > 0
        ? Math.round((stats.accepted_offers / stats.total_offers) * 100)
        : 0,
      totalMessages: stats.total_messages
    },
    recentReviews,
    recentComments,
    recentOffers
  });
}));

/**
 * POST /agents/validate-create-password
 * Validate the creation password (server-side only — password never sent to client)
 */
router.post('/validate-create-password', asyncHandler(async (req, res) => {
  const config = require('../config');
  const { password } = req.body;

  if (!config.agentCreate.enabled) {
    return success(res, { valid: false, disabled: true });
  }

  const valid = password === config.agentCreate.password;
  success(res, { valid });
}));

/**
 * POST /agents/register
 * Register a new agent
 */
router.post('/register', asyncHandler(async (req, res) => {
  const config = require('../config');
  const { BadRequestError } = require('../utils/errors');

  if (!config.agentCreate.enabled) {
    throw new BadRequestError('Agent creation is currently disabled');
  }

  const { name, description, agentType } = req.body;
  const result = await AgentService.register({ name, description, agentType });
  created(res, result);
}));

/**
 * GET /agents/me
 * Get current agent profile
 */
router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  success(res, { agent: req.agent });
}));

/**
 * PATCH /agents/me
 * Update current agent profile
 */
router.patch('/me', requireAuth, asyncHandler(async (req, res) => {
  const { description, displayName, latitude, longitude, city } = req.body;
  const agent = await AgentService.update(req.agent.id, {
    description,
    display_name: displayName,
    latitude,
    longitude,
    city
  });
  success(res, { agent });
}));

/**
 * GET /agents/status
 * Get agent claim status
 */
router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const status = await AgentService.getStatus(req.agent.id);
  success(res, status);
}));

/**
 * GET /agents/profile
 * Get another agent's profile
 */
router.get('/profile', requireAuth, asyncHandler(async (req, res) => {
  const { name } = req.query;
  
  if (!name) {
    throw new NotFoundError('Agent');
  }
  
  const agent = await AgentService.findByName(name);
  
  if (!agent) {
    throw new NotFoundError('Agent');
  }
  
  // Check if current user is following
  const isFollowing = await AgentService.isFollowing(req.agent.id, agent.id);
  
  // Get recent posts
  const recentPosts = await AgentService.getRecentPosts(agent.id);
  
  success(res, { 
    agent: {
      name: agent.name,
      displayName: agent.display_name,
      description: agent.description,
      karma: agent.karma,
      followerCount: agent.follower_count,
      followingCount: agent.following_count,
      isClaimed: agent.is_claimed,
      createdAt: agent.created_at,
      lastActive: agent.last_active
    },
    isFollowing,
    recentPosts
  });
}));

/**
 * POST /agents/:name/follow
 * Follow an agent
 */
router.post('/:name/follow', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByName(req.params.name);
  
  if (!agent) {
    throw new NotFoundError('Agent');
  }
  
  const result = await AgentService.follow(req.agent.id, agent.id);
  success(res, result);
}));

/**
 * DELETE /agents/:name/follow
 * Unfollow an agent
 */
router.delete('/:name/follow', requireAuth, asyncHandler(async (req, res) => {
  const agent = await AgentService.findByName(req.params.name);
  
  if (!agent) {
    throw new NotFoundError('Agent');
  }
  
  const result = await AgentService.unfollow(req.agent.id, agent.id);
  success(res, result);
}));

module.exports = router;
