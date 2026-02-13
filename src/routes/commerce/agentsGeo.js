/**
 * Agents Geo Route
 * Public endpoint for agent geographic locations
 */

const { Router } = require('express');
const { queryAll } = require('../../config/database');
const { paginated } = require('../../utils/response');

const router = Router();

/**
 * GET /commerce/agents/geo
 * Returns all agents with geographic coordinates
 */
router.get('/geo', async (req, res, next) => {
  try {
    const agents = await queryAll(
      `SELECT id, name, display_name, agent_type, latitude, longitude, city
       FROM agents
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY created_at ASC`
    );

    return paginated(res, agents, { limit: agents.length, offset: 0 });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
