/**
 * Operator authentication middleware
 * Requires Bearer OPERATOR_KEY for /operator/* endpoints
 */

const config = require('../config');
const { UnauthorizedError } = require('../utils/errors');

function requireOperator(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new UnauthorizedError('Operator key required');
    }

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      throw new UnauthorizedError('Invalid authorization format');
    }

    if (parts[1] !== config.operatorKey) {
      throw new UnauthorizedError('Invalid operator key');
    }

    next();
  } catch (error) {
    next(error);
  }
}

module.exports = { requireOperator };
