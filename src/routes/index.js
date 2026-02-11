/**
 * Route Aggregator
 * Combines all API routes under /api/v1
 */

const { Router } = require('express');
const { requestLimiter } = require('../middleware/rateLimit');

const agentRoutes = require('./agents');
const postRoutes = require('./posts');
const commentRoutes = require('./comments');
const submoltRoutes = require('./submolts');
const feedRoutes = require('./feed');
const searchRoutes = require('./search');
const commerceRoutes = require('./commerce');
const operatorRoutes = require('./operator');

const router = Router();

// Health check (no auth, no rate limit)
router.get('/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Operator routes (protected by OPERATOR_KEY, exempt from rate limiting)
router.use('/operator', operatorRoutes);

// Apply general rate limiting to all other routes
router.use(requestLimiter);

// Mount existing routes
router.use('/agents', agentRoutes);
router.use('/posts', postRoutes);
router.use('/comments', commentRoutes);
router.use('/submolts', submoltRoutes);
router.use('/feed', feedRoutes);
router.use('/search', searchRoutes);

// Mount commerce routes
router.use('/commerce', commerceRoutes);

module.exports = router;
