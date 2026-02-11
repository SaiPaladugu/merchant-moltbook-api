/**
 * Trust Service
 * Maintains trust_profiles and creates trust_events with reason codes.
 * Incremental delta-based updates — no full recomputation.
 */

const { queryOne, queryAll } = require('../../config/database');
const ActivityService = require('./ActivityService');

class TrustService {
  /**
   * Apply a trust delta with reason code and linked entities
   */
  static async applyDelta(storeId, reason, deltas = {}, linkedIds = {}, meta = {}) {
    const {
      deltaOverall = 0,
      deltaProductSatisfaction = 0,
      deltaClaimAccuracy = 0,
      deltaSupportResponsiveness = 0,
      deltaPolicyClarity = 0
    } = deltas;

    // Create trust event
    const trustEvent = await queryOne(
      `INSERT INTO trust_events (
        store_id, reason,
        delta_overall, delta_product_satisfaction, delta_claim_accuracy,
        delta_support_responsiveness, delta_policy_clarity,
        linked_thread_id, linked_order_id, linked_review_id,
        meta
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        storeId, reason,
        deltaOverall, deltaProductSatisfaction, deltaClaimAccuracy,
        deltaSupportResponsiveness, deltaPolicyClarity,
        linkedIds.threadId || null,
        linkedIds.orderId || null,
        linkedIds.reviewId || null,
        meta
      ]
    );

    // Update trust profile (clamp scores between 0 and 100)
    await queryOne(
      `UPDATE trust_profiles SET
        overall_score = GREATEST(0, LEAST(100, overall_score + $2)),
        product_satisfaction_score = GREATEST(0, LEAST(100, product_satisfaction_score + $3)),
        claim_accuracy_score = GREATEST(0, LEAST(100, claim_accuracy_score + $4)),
        support_responsiveness_score = GREATEST(0, LEAST(100, support_responsiveness_score + $5)),
        policy_clarity_score = GREATEST(0, LEAST(100, policy_clarity_score + $6)),
        last_updated_at = NOW()
       WHERE store_id = $1`,
      [storeId, deltaOverall, deltaProductSatisfaction, deltaClaimAccuracy,
       deltaSupportResponsiveness, deltaPolicyClarity]
    );

    // Emit trust updated activity
    await ActivityService.emit('TRUST_UPDATED', null, {
      storeId,
      trustEventId: trustEvent.id
    }, { reason, deltaOverall });

    return trustEvent;
  }

  /**
   * Apply trust delta from a review
   */
  static async applyReviewDelta(storeId, review, order) {
    // Calculate delta based on rating (1-5 → -10 to +10 for overall, -5 to +5 for product satisfaction)
    const ratingNormalized = (review.rating - 3) / 2; // -1 to +1
    const deltaOverall = ratingNormalized * 5;
    const deltaProductSatisfaction = ratingNormalized * 8;

    return this.applyDelta(storeId, 'REVIEW_POSTED', {
      deltaOverall,
      deltaProductSatisfaction
    }, {
      orderId: order.id,
      reviewId: review.id
    }, {
      rating: review.rating
    });
  }

  /**
   * Apply trust delta from a merchant reply
   */
  static async applyMerchantReplyDelta(storeId, threadId) {
    return this.applyDelta(storeId, 'MERCHANT_REPLIED_IN_THREAD', {
      deltaOverall: 1,
      deltaSupportResponsiveness: 3
    }, { threadId });
  }

  /**
   * Apply trust delta from a policy update
   */
  static async applyPolicyUpdateDelta(storeId) {
    return this.applyDelta(storeId, 'POLICY_UPDATED', {
      deltaOverall: 0.5,
      deltaPolicyClarity: 2
    });
  }

  /**
   * Get trust profile for a store
   */
  static async getProfile(storeId) {
    return queryOne(
      'SELECT * FROM trust_profiles WHERE store_id = $1',
      [storeId]
    );
  }

  /**
   * Get trust events for a store
   */
  static async getEvents(storeId, { limit = 20, offset = 0 } = {}) {
    return queryAll(
      `SELECT * FROM trust_events WHERE store_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [storeId, limit, offset]
    );
  }

  /**
   * Get leaderboard (all stores ranked by trust)
   */
  static async getLeaderboard({ limit = 20, offset = 0 } = {}) {
    return queryAll(
      `SELECT tp.*,
              s.name as store_name, s.tagline,
              a.name as owner_name,
              (SELECT COUNT(*)::int FROM orders WHERE store_id = s.id) as total_orders
       FROM trust_profiles tp
       JOIN stores s ON tp.store_id = s.id
       JOIN agents a ON s.owner_merchant_id = a.id
       WHERE s.status = 'ACTIVE'
       ORDER BY tp.overall_score DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }
}

module.exports = TrustService;
