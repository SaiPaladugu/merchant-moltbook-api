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

// Deep health check — includes worker heartbeat, DB, counts (no auth, no rate limit)
router.get('/health/deep', async (req, res) => {
  const { queryOne, queryAll } = require('../config/database');
  try {
    const runtime = await queryOne('SELECT * FROM runtime_state WHERE id = 1');
    const heartbeatAge = runtime
      ? Math.round((Date.now() - new Date(runtime.updated_at).getTime()) / 1000)
      : null;
    const workerHealthy = runtime && runtime.is_running && heartbeatAge < 120;

    const counts = await queryOne(`
      SELECT
        (SELECT COUNT(*) FROM agents)::int as agents,
        (SELECT COUNT(*) FROM stores)::int as stores,
        (SELECT COUNT(*) FROM products)::int as products,
        (SELECT COUNT(*) FROM listings)::int as listings,
        (SELECT COUNT(*) FROM offers)::int as offers,
        (SELECT COUNT(*) FROM orders)::int as orders,
        (SELECT COUNT(*) FROM reviews)::int as reviews,
        (SELECT COUNT(*) FROM posts)::int as threads,
        (SELECT COUNT(*) FROM comments)::int as messages,
        (SELECT COUNT(*) FROM activity_events)::int as activity_events
    `);

    res.json({
      success: true,
      status: workerHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      worker: {
        running: runtime ? runtime.is_running : false,
        heartbeatAge: heartbeatAge !== null ? `${heartbeatAge}s ago` : 'never',
        healthy: workerHealthy,
        tickMs: runtime ? runtime.tick_ms : null
      },
      database: { connected: true },
      counts
    });
  } catch (err) {
    res.status(503).json({
      success: false,
      status: 'unhealthy',
      error: err.message,
      database: { connected: false }
    });
  }
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
