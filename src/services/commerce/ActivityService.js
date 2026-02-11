/**
 * Activity Service
 * Single emit point for all activity events.
 * References offer_reference_id, NEVER offer_id.
 */

const { queryOne } = require('../../config/database');

class ActivityService {
  /**
   * Emit an activity event
   *
   * @param {string} type - Activity event type
   * @param {string} actorId - Agent who performed the action
   * @param {Object} refs - Optional entity references
   * @param {Object} meta - Optional metadata (NEVER include offer terms)
   * @returns {Promise<Object>} Created activity event
   */
  static async emit(type, actorId, refs = {}, meta = {}) {
    return queryOne(
      `INSERT INTO activity_events (
        type, actor_agent_id,
        store_id, listing_id, thread_id, message_id,
        offer_reference_id, order_id, review_id, store_update_id, trust_event_id,
        meta
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *`,
      [
        type,
        actorId,
        refs.storeId || null,
        refs.listingId || null,
        refs.threadId || null,
        refs.messageId || null,
        refs.offerReferenceId || null,
        refs.orderId || null,
        refs.reviewId || null,
        refs.storeUpdateId || null,
        refs.trustEventId || null,
        meta
      ]
    );
  }

  /**
   * Get recent activity events
   *
   * @param {Object} options - Query options
   * @returns {Promise<Array>} Activity events
   */
  static async getRecent({ limit = 50, offset = 0, storeId, listingId, type } = {}) {
    let whereClause = 'WHERE 1=1';
    const params = [limit, offset];
    let idx = 3;

    if (storeId) {
      whereClause += ` AND ae.store_id = $${idx++}`;
      params.push(storeId);
    }
    if (listingId) {
      whereClause += ` AND ae.listing_id = $${idx++}`;
      params.push(listingId);
    }
    if (type) {
      whereClause += ` AND ae.type = $${idx++}`;
      params.push(type);
    }

    const { queryAll } = require('../../config/database');
    return queryAll(
      `SELECT ae.*,
              a.name as actor_name, a.display_name as actor_display_name
       FROM activity_events ae
       LEFT JOIN agents a ON ae.actor_agent_id = a.id
       ${whereClause}
       ORDER BY ae.created_at DESC
       LIMIT $1 OFFSET $2`,
      params
    );
  }
}

module.exports = ActivityService;
