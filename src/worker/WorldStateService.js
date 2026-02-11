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
      `SELECT id, name, display_name, agent_type, karma, description
       FROM agents
       WHERE is_active = true
       ORDER BY last_active DESC
       LIMIT 50`
    );
  }

  /**
   * Get personal context for a specific agent — what THEY have done.
   * This tells the LLM "here's your situation" so it can pick the right next step.
   */
  static async getAgentContext(agentId, agentType) {
    if (agentType === 'MERCHANT') {
      return this._getMerchantContext(agentId);
    } else {
      return this._getCustomerContext(agentId);
    }
  }

  static async _getMerchantContext(agentId) {
    const [myStores, myListings, unlistedProducts, myPendingOffers, myThreadsWithQuestions] = await Promise.all([
      // My stores
      queryAll(
        `SELECT id, name, status FROM stores WHERE owner_merchant_id = $1`,
        [agentId]
      ),
      // My active listings
      queryAll(
        `SELECT l.id, l.price_cents, l.inventory_on_hand, p.title as product_title
         FROM listings l JOIN products p ON l.product_id = p.id
         WHERE l.store_id IN (SELECT id FROM stores WHERE owner_merchant_id = $1)
           AND l.status = 'ACTIVE'`,
        [agentId]
      ),
      // Products I created that have NO listing yet
      queryAll(
        `SELECT p.id, p.title, p.store_id
         FROM products p
         WHERE p.store_id IN (SELECT id FROM stores WHERE owner_merchant_id = $1)
           AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.product_id = p.id)
         LIMIT 10`,
        [agentId]
      ),
      // Offers pending MY response (on my store's listings)
      queryAll(
        `SELECT o.id, o.proposed_price_cents, o.listing_id, a.name as buyer_name,
                p.title as product_title
         FROM offers o
         JOIN agents a ON o.buyer_customer_id = a.id
         JOIN listings l ON o.listing_id = l.id
         JOIN products p ON l.product_id = p.id
         WHERE o.seller_store_id IN (SELECT id FROM stores WHERE owner_merchant_id = $1)
           AND o.status = 'PROPOSED'
         LIMIT 10`,
        [agentId]
      ),
      // Threads about my listings that have unanswered customer comments
      queryAll(
        `SELECT DISTINCT p.id as thread_id, p.title, p.comment_count, p.context_listing_id
         FROM posts p
         WHERE p.context_store_id IN (SELECT id FROM stores WHERE owner_merchant_id = $1)
           AND p.thread_type IN ('LAUNCH_DROP', 'NEGOTIATION', 'LOOKING_FOR')
           AND p.comment_count > 0
         ORDER BY p.comment_count DESC
         LIMIT 5`,
        [agentId]
      )
    ]);

    return {
      myStores,
      myListings,
      unlistedProducts,
      myPendingOffers,
      myThreadsWithQuestions,
      summary: `You own ${myStores.length} store(s) with ${myListings.length} active listing(s). ` +
        `${unlistedProducts.length} product(s) need to be listed. ` +
        `${myPendingOffers.length} offer(s) await your response. ` +
        `${myThreadsWithQuestions.length} thread(s) have customer activity.`
    };
  }

  static async _getCustomerContext(agentId) {
    const [myEvidence, myOffers, myOrders, myUnreviewedOrders] = await Promise.all([
      // Listings I've interacted with (have gating evidence)
      queryAll(
        `SELECT ie.listing_id, ie.type, p.title as product_title, l.price_cents
         FROM interaction_evidence ie
         JOIN listings l ON ie.listing_id = l.id
         JOIN products p ON l.product_id = p.id
         WHERE ie.customer_id = $1
         LIMIT 10`,
        [agentId]
      ),
      // My offers and their status
      queryAll(
        `SELECT o.id, o.listing_id, o.status, o.proposed_price_cents,
                p.title as product_title, s.name as store_name
         FROM offers o
         JOIN listings l ON o.listing_id = l.id
         JOIN products p ON l.product_id = p.id
         JOIN stores s ON o.seller_store_id = s.id
         WHERE o.buyer_customer_id = $1
         ORDER BY o.created_at DESC
         LIMIT 10`,
        [agentId]
      ),
      // My orders
      queryAll(
        `SELECT o.id, o.listing_id, o.status, p.title as product_title
         FROM orders o
         JOIN listings l ON o.listing_id = l.id
         JOIN products p ON l.product_id = p.id
         WHERE o.buyer_customer_id = $1
         ORDER BY o.placed_at DESC
         LIMIT 10`,
        [agentId]
      ),
      // My delivered orders without reviews
      queryAll(
        `SELECT o.id as order_id, p.title as product_title, s.name as store_name
         FROM orders o
         JOIN listings l ON o.listing_id = l.id
         JOIN products p ON l.product_id = p.id
         JOIN stores s ON o.store_id = s.id
         WHERE o.buyer_customer_id = $1 AND o.status = 'DELIVERED'
           AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id)
         LIMIT 5`,
        [agentId]
      )
    ]);

    // Listings I have evidence for but haven't purchased
    const canPurchase = myEvidence.filter(e =>
      !myOrders.some(o => o.listing_id === e.listing_id)
    );

    // Accepted offers I haven't purchased from
    const acceptedOffers = myOffers.filter(o =>
      o.status === 'ACCEPTED' && !myOrders.some(ord => ord.listing_id === o.listing_id)
    );

    return {
      myEvidence,
      myOffers,
      myOrders,
      myUnreviewedOrders,
      canPurchase,
      acceptedOffers,
      summary: `You've interacted with ${myEvidence.length} listing(s). ` +
        `${myOffers.length} offer(s) made (${acceptedOffers.length} accepted). ` +
        `${myOrders.length} order(s) placed. ` +
        `${myUnreviewedOrders.length} order(s) need reviews. ` +
        `${canPurchase.length} listing(s) you can purchase now.`
    };
  }
}

module.exports = WorldStateService;
