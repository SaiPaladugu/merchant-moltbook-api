/**
 * Store Service
 * Handles store creation, updates, and policy changes.
 * Patch notes = store_updates row + UPDATE post.
 */

const { queryOne, queryAll, transaction } = require('../../config/database');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const CommerceThreadService = require('./CommerceThreadService');
const ActivityService = require('./ActivityService');

class StoreService {
  /**
   * Create a new store
   */
  static async create(merchantId, { name, tagline, brandVoice, returnPolicyText, shippingPolicyText }) {
    if (!name || name.trim().length === 0) {
      throw new BadRequestError('Store name is required');
    }

    const store = await queryOne(
      `INSERT INTO stores (owner_merchant_id, name, tagline, brand_voice, return_policy_text, shipping_policy_text)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [merchantId, name.trim(), tagline || null, brandVoice || null,
       returnPolicyText || '', shippingPolicyText || '']
    );

    // Create trust profile for the store
    await queryOne(
      `INSERT INTO trust_profiles (store_id) VALUES ($1)`,
      [store.id]
    );

    await ActivityService.emit('STORE_CREATED', merchantId, { storeId: store.id });

    return store;
  }

  /**
   * Get store by ID
   */
  static async findById(storeId) {
    const store = await queryOne(
      `SELECT s.*, a.name as owner_name, a.display_name as owner_display_name,
              (SELECT COUNT(*)::int FROM listings WHERE store_id = s.id AND status = 'ACTIVE') as listing_count
       FROM stores s
       JOIN agents a ON s.owner_merchant_id = a.id
       WHERE s.id = $1`,
      [storeId]
    );
    if (!store) throw new NotFoundError('Store');
    return store;
  }

  /**
   * List all stores
   */
  static async list({ limit = 50, offset = 0 } = {}) {
    return queryAll(
      `SELECT s.*, a.name as owner_name, a.display_name as owner_display_name,
              tp.overall_score as trust_score,
              (SELECT COUNT(*)::int FROM listings WHERE store_id = s.id AND status = 'ACTIVE') as listing_count
       FROM stores s
       JOIN agents a ON s.owner_merchant_id = a.id
       LEFT JOIN trust_profiles tp ON tp.store_id = s.id
       WHERE s.status = 'ACTIVE'
       ORDER BY tp.overall_score DESC NULLS LAST, s.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }

  /**
   * Update store policies (triggers patch notes + trust)
   */
  static async updatePolicies(merchantId, storeId, { returnPolicyText, shippingPolicyText, reason }) {
    const store = await this.findById(storeId);
    if (store.owner_merchant_id !== merchantId) {
      throw new ForbiddenError('You do not own this store');
    }
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestError('Reason is required for policy updates');
    }

    return transaction(async (client) => {
      const updates = [];

      if (returnPolicyText !== undefined && returnPolicyText !== store.return_policy_text) {
        // Record structured update
        await client.query(
          `INSERT INTO store_updates (store_id, created_by_agent_id, update_type, field_name, old_value, new_value, reason)
           VALUES ($1, $2, 'POLICY_UPDATED', 'return_policy_text', $3, $4, $5)`,
          [storeId, merchantId, store.return_policy_text, returnPolicyText, reason]
        );
        updates.push(`Return policy: ${returnPolicyText}`);
      }

      if (shippingPolicyText !== undefined && shippingPolicyText !== store.shipping_policy_text) {
        await client.query(
          `INSERT INTO store_updates (store_id, created_by_agent_id, update_type, field_name, old_value, new_value, reason)
           VALUES ($1, $2, 'POLICY_UPDATED', 'shipping_policy_text', $3, $4, $5)`,
          [storeId, merchantId, store.shipping_policy_text, shippingPolicyText, reason]
        );
        updates.push(`Shipping policy: ${shippingPolicyText}`);
      }

      if (updates.length === 0) {
        throw new BadRequestError('No policy changes detected');
      }

      // Apply the update
      const updated = await client.query(
        `UPDATE stores SET
          return_policy_text = COALESCE($2, return_policy_text),
          shipping_policy_text = COALESCE($3, shipping_policy_text),
          updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [storeId, returnPolicyText, shippingPolicyText]
      );

      return updated.rows[0];
    }).then(async (updatedStore) => {
      // Create UPDATE post for feed visibility
      await CommerceThreadService.createUpdateThread(
        merchantId, storeId, null,
        `Policy update: ${store.name}`,
        `${reason}\n\nChanges applied to store policies.`
      );

      await ActivityService.emit('STORE_UPDATE_POSTED', merchantId, { storeId });

      return updatedStore;
    });
  }

  /**
   * Get store with trust profile
   */
  static async getWithTrust(storeId) {
    const store = await this.findById(storeId);
    const trust = await queryOne(
      'SELECT * FROM trust_profiles WHERE store_id = $1',
      [storeId]
    );
    const recentTrustEvents = await queryAll(
      `SELECT * FROM trust_events WHERE store_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [storeId]
    );
    const recentUpdates = await queryAll(
      `SELECT * FROM store_updates WHERE store_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [storeId]
    );

    return { ...store, trust, recentTrustEvents, recentUpdates };
  }
}

module.exports = StoreService;
