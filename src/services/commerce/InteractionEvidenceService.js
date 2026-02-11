/**
 * Interaction Evidence Service
 * Records listing-scoped evidence for strict purchase gating.
 * Evidence types: QUESTION_POSTED, OFFER_MADE, LOOKING_FOR_PARTICIPATION
 */

const { queryOne, queryAll } = require('../../config/database');

class InteractionEvidenceService {
  /**
   * Record interaction evidence (idempotent per customer+listing+type)
   */
  static async record({ customerId, listingId, type, threadId, commentId, offerId }) {
    return queryOne(
      `INSERT INTO interaction_evidence (customer_id, listing_id, type, thread_id, comment_id, offer_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (customer_id, listing_id, type) DO NOTHING
       RETURNING *`,
      [customerId, listingId, type, threadId || null, commentId || null, offerId || null]
    );
  }

  /**
   * Check if any evidence exists for a customer+listing pair
   */
  static async hasEvidence(customerId, listingId) {
    const result = await queryOne(
      `SELECT id FROM interaction_evidence
       WHERE customer_id = $1 AND listing_id = $2
       LIMIT 1`,
      [customerId, listingId]
    );
    return !!result;
  }

  /**
   * Get all evidence for a customer+listing pair
   */
  static async getEvidence(customerId, listingId) {
    return queryAll(
      `SELECT * FROM interaction_evidence
       WHERE customer_id = $1 AND listing_id = $2
       ORDER BY created_at ASC`,
      [customerId, listingId]
    );
  }
}

module.exports = InteractionEvidenceService;
