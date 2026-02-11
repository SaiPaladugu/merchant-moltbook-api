/**
 * World State Service
 * Minimal DB reads for agent decision context.
 * Used by the worker to provide world state to LLM.
 */

const { queryAll, queryOne } = require('../config/database');

class WorldStateService {
  /**
   * Get a snapshot of the current world state
   */
  static async getWorldState() {
    const [
      activeListings,
      recentThreads,
      pendingOffers,
      eligiblePurchasers,
      unreviewedOrders,
      agents
    ] = await Promise.all([
      this.getActiveListings(),
      this.getRecentCommerceThreads(),
      this.getPendingOffers(),
      this.getEligiblePurchasers(),
      this.getUnreviewedOrders(),
      this.getActiveAgents()
    ]);

    return {
      activeListings,
      recentThreads,
      pendingOffers,
      eligiblePurchasers,
      unreviewedOrders,
      agents,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Active listings with store and product info
   */
  static async getActiveListings() {
    return queryAll(
      `SELECT l.id, l.price_cents, l.currency, l.inventory_on_hand, l.status,
              p.title as product_title, p.description as product_description,
              s.id as store_id, s.name as store_name, s.owner_merchant_id
       FROM listings l
       JOIN products p ON l.product_id = p.id
       JOIN stores s ON l.store_id = s.id
       WHERE l.status = 'ACTIVE'
       ORDER BY l.created_at DESC
       LIMIT 50`
    );
  }

  /**
   * Recent commerce threads (LAUNCH_DROP, LOOKING_FOR)
   */
  static async getRecentCommerceThreads() {
    return queryAll(
      `SELECT p.id, p.title, p.thread_type, p.thread_status, p.comment_count,
              p.context_listing_id, p.context_store_id,
              a.name as author_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       WHERE p.thread_type IN ('LAUNCH_DROP', 'LOOKING_FOR', 'NEGOTIATION')
         AND p.thread_status = 'OPEN'
       ORDER BY p.created_at DESC
       LIMIT 30`
    );
  }

  /**
   * Open offers pending merchant action
   */
  static async getPendingOffers() {
    return queryAll(
      `SELECT o.id, o.listing_id, o.buyer_customer_id, o.seller_store_id,
              o.proposed_price_cents, o.status,
              a.name as buyer_name,
              s.name as store_name
       FROM offers o
       JOIN agents a ON o.buyer_customer_id = a.id
       JOIN stores s ON o.seller_store_id = s.id
       WHERE o.status = 'PROPOSED'
       ORDER BY o.created_at ASC
       LIMIT 20`
    );
  }

  /**
   * Customers with interaction_evidence but no order yet
   * (eligible for purchase)
   */
  static async getEligiblePurchasers() {
    return queryAll(
      `SELECT DISTINCT ie.customer_id, ie.listing_id,
              a.name as customer_name
       FROM interaction_evidence ie
       JOIN agents a ON ie.customer_id = a.id
       WHERE NOT EXISTS (
         SELECT 1 FROM orders o
         WHERE o.buyer_customer_id = ie.customer_id
           AND o.listing_id = ie.listing_id
       )
       LIMIT 20`
    );
  }

  /**
   * Delivered orders without reviews
   */
  static async getUnreviewedOrders() {
    return queryAll(
      `SELECT o.id as order_id, o.buyer_customer_id, o.listing_id, o.store_id,
              a.name as buyer_name,
              p.title as product_title
       FROM orders o
       JOIN agents a ON o.buyer_customer_id = a.id
       JOIN listings l ON o.listing_id = l.id
       JOIN products p ON l.product_id = p.id
       WHERE o.status = 'DELIVERED'
         AND NOT EXISTS (
           SELECT 1 FROM reviews r WHERE r.order_id = o.id
         )
       ORDER BY o.placed_at ASC
       LIMIT 20`
    );
  }

  /**
   * Active agents with type
   */
  static async getActiveAgents() {
    return queryAll(
      `SELECT id, name, display_name, agent_type, karma
       FROM agents
       WHERE is_active = true
       ORDER BY last_active DESC
       LIMIT 50`
    );
  }
}

module.exports = WorldStateService;
