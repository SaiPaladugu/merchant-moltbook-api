/**
 * Offer Service
 * Handles private offers with store-scoped privacy enforcement.
 * seller_store_id → stores(id), privacy = buyer OR stores.owner_merchant_id.
 */

const { queryOne, queryAll, transaction } = require('../../config/database');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const config = require('../../config');
const InteractionEvidenceService = require('./InteractionEvidenceService');
const ActivityService = require('./ActivityService');

class OfferService {
  /**
   * Create a private offer (customer only)
   */
  static async makeOffer(customerId, { listingId, proposedPriceCents, currency, buyerMessage, expiresAt }) {
    // Anti-trivial validation
    if (!proposedPriceCents || proposedPriceCents < config.gating.minOfferPriceCents) {
      throw new BadRequestError(`Offer price must be at least ${config.gating.minOfferPriceCents} cents`);
    }
    if (buyerMessage && buyerMessage.trim().length > 0 && buyerMessage.trim().length < config.gating.minOfferMessageLen) {
      throw new BadRequestError(`Offer message must be at least ${config.gating.minOfferMessageLen} characters`);
    }

    // Verify listing exists and is active
    const listing = await queryOne(
      `SELECT l.id, l.store_id, l.status FROM listings l WHERE l.id = $1`,
      [listingId]
    );
    if (!listing) throw new NotFoundError('Listing');
    if (listing.status !== 'ACTIVE') {
      throw new BadRequestError('Listing is not currently active');
    }

    const offer = await queryOne(
      `INSERT INTO offers (listing_id, buyer_customer_id, seller_store_id, proposed_price_cents, currency, buyer_message, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [listingId, customerId, listing.store_id, proposedPriceCents,
       currency || 'USD', buyerMessage || null, expiresAt || null]
    );

    // Record interaction evidence
    await InteractionEvidenceService.record({
      customerId,
      listingId,
      type: 'OFFER_MADE',
      offerId: offer.id
    });

    // Emit activity (offer-safe: no terms, just existence)
    await ActivityService.emit('OFFER_MADE', customerId, {
      storeId: listing.store_id,
      listingId
    });

    return offer;
  }

  /**
   * Get offer with privacy enforcement
   */
  static async getOffer(offerId, viewerAgentId) {
    const offer = await queryOne(
      `SELECT o.*, s.owner_merchant_id
       FROM offers o
       JOIN stores s ON o.seller_store_id = s.id
       WHERE o.id = $1`,
      [offerId]
    );
    if (!offer) throw new NotFoundError('Offer');

    // Privacy: only buyer or store owner can view
    if (viewerAgentId !== offer.buyer_customer_id &&
        viewerAgentId !== offer.owner_merchant_id) {
      throw new ForbiddenError('You do not have access to this offer');
    }
    return offer;
  }

  /**
   * List offers for a merchant's store (merchant only)
   */
  static async listForStore(merchantId, storeId, { status, limit = 50, offset = 0 } = {}) {
    // Verify store ownership
    const store = await queryOne(
      'SELECT id, owner_merchant_id FROM stores WHERE id = $1',
      [storeId]
    );
    if (!store) throw new NotFoundError('Store');
    if (store.owner_merchant_id !== merchantId) {
      throw new ForbiddenError('You do not own this store');
    }

    let whereClause = 'WHERE o.seller_store_id = $1';
    const params = [storeId, limit, offset];
    let idx = 4;

    if (status) {
      whereClause += ` AND o.status = $${idx++}`;
      params.push(status);
    }

    return queryAll(
      `SELECT o.*, a.name as buyer_name, a.display_name as buyer_display_name,
              l.price_cents as listing_price_cents
       FROM offers o
       JOIN agents a ON o.buyer_customer_id = a.id
       JOIN listings l ON o.listing_id = l.id
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      params
    );
  }

  /**
   * List offers for a listing (public - no auth required)
   * Returns only public info: buyer name, status, timestamps
   * Does NOT expose offer amounts
   */
  static async listForListing(listingId, { limit = 50, offset = 0 } = {}) {
    return queryAll(
      `SELECT 
         o.id,
         o.listing_id,
         o.status,
         o.created_at,
         o.accepted_at,
         o.rejected_at,
         a.name as buyer_name,
         a.display_name as buyer_display_name
       FROM offers o
       JOIN agents a ON o.buyer_customer_id = a.id
       WHERE o.listing_id = $1
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [listingId, limit, offset]
    );
  }

  /**
   * List offers by customer
   */
  static async listForCustomer(customerId, { limit = 50, offset = 0 } = {}) {
    return queryAll(
      `SELECT o.*, s.name as store_name,
              p.title as product_title, l.price_cents as listing_price_cents
       FROM offers o
       JOIN stores s ON o.seller_store_id = s.id
       JOIN listings l ON o.listing_id = l.id
       JOIN products p ON l.product_id = p.id
       WHERE o.buyer_customer_id = $1
       ORDER BY o.created_at DESC
       LIMIT $2 OFFSET $3`,
      [customerId, limit, offset]
    );
  }

  /**
   * Accept an offer (merchant only, transactional with row lock)
   */
  static async acceptOffer(merchantId, offerId) {
    return transaction(async (client) => {
      // Lock offer row
      const offer = await client.query(
        `SELECT o.*, s.owner_merchant_id
         FROM offers o
         JOIN stores s ON o.seller_store_id = s.id
         WHERE o.id = $1
         FOR UPDATE`,
        [offerId]
      );
      const row = offer.rows[0];
      if (!row) throw new NotFoundError('Offer');
      if (row.owner_merchant_id !== merchantId) {
        throw new ForbiddenError('You do not own this store');
      }
      if (row.status !== 'PROPOSED') {
        throw new BadRequestError(`Cannot accept offer with status: ${row.status}`);
      }

      const result = await client.query(
        `UPDATE offers SET status = 'ACCEPTED', accepted_at = NOW() WHERE id = $1 RETURNING *`,
        [offerId]
      );

      return result.rows[0];
    }).then(async (accepted) => {
      await ActivityService.emit('OFFER_ACCEPTED', merchantId, {
        storeId: accepted.seller_store_id,
        listingId: accepted.listing_id
      });
      return accepted;
    });
  }

  /**
   * Reject an offer (merchant only)
   */
  static async rejectOffer(merchantId, offerId) {
    return transaction(async (client) => {
      const offer = await client.query(
        `SELECT o.*, s.owner_merchant_id
         FROM offers o
         JOIN stores s ON o.seller_store_id = s.id
         WHERE o.id = $1
         FOR UPDATE`,
        [offerId]
      );
      const row = offer.rows[0];
      if (!row) throw new NotFoundError('Offer');
      if (row.owner_merchant_id !== merchantId) {
        throw new ForbiddenError('You do not own this store');
      }
      if (row.status !== 'PROPOSED') {
        throw new BadRequestError(`Cannot reject offer with status: ${row.status}`);
      }

      const result = await client.query(
        `UPDATE offers SET status = 'REJECTED', rejected_at = NOW() WHERE id = $1 RETURNING *`,
        [offerId]
      );
      return result.rows[0];
    }).then(async (rejected) => {
      await ActivityService.emit('OFFER_REJECTED', merchantId, {
        storeId: rejected.seller_store_id,
        listingId: rejected.listing_id
      });
      return rejected;
    });
  }

  /**
   * Create a public offer reference (either party)
   */
  static async createOfferReference(agentId, { offerId, threadId, publicNote }) {
    // Verify agent has access to the offer
    const offer = await this.getOffer(offerId, agentId);

    const ref = await queryOne(
      `INSERT INTO offer_references (offer_id, thread_id, created_by_agent_id, public_note)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [offerId, threadId, agentId, publicNote || null]
    );

    await ActivityService.emit('OFFER_REFERENCE_POSTED', agentId, {
      storeId: offer.seller_store_id,
      listingId: offer.listing_id,
      threadId,
      offerReferenceId: ref.id
    });

    return ref;
  }
}

module.exports = OfferService;
