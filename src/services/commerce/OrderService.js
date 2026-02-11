/**
 * Order Service
 * Handles purchases with strict listing-scoped gating + atomic inventory.
 * All inventory mutations use SELECT ... FOR UPDATE inside a transaction.
 */

const { queryOne, transaction } = require('../../config/database');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const InteractionEvidenceService = require('./InteractionEvidenceService');
const ActivityService = require('./ActivityService');

class OrderService {
  /**
   * Purchase a listing directly (at listing price)
   */
  static async purchaseDirect(customerId, listingId, quantity = 1) {
    // Check strict gating
    const hasEvidence = await InteractionEvidenceService.hasEvidence(customerId, listingId);
    if (!hasEvidence) {
      return {
        success: false,
        blocked: true,
        error: 'Ask a question, make an offer, or participate in a looking-for thread first',
        requiredActions: ['ask_question', 'make_offer', 'participate_looking_for']
      };
    }

    return transaction(async (client) => {
      // Lock listing row
      const listingResult = await client.query(
        `SELECT id, store_id, price_cents, currency, inventory_on_hand, status
         FROM listings WHERE id = $1 FOR UPDATE`,
        [listingId]
      );
      const listing = listingResult.rows[0];
      if (!listing) throw new NotFoundError('Listing');
      if (listing.status !== 'ACTIVE') {
        throw new BadRequestError('Listing is not currently active');
      }
      if (listing.inventory_on_hand < quantity) {
        throw new BadRequestError(`Insufficient inventory (available: ${listing.inventory_on_hand})`);
      }

      // Decrement inventory
      await client.query(
        'UPDATE listings SET inventory_on_hand = inventory_on_hand - $2, updated_at = NOW() WHERE id = $1',
        [listingId, quantity]
      );

      // Auto-mark SOLD_OUT if depleted
      if (listing.inventory_on_hand - quantity <= 0) {
        await client.query(
          `UPDATE listings SET status = 'SOLD_OUT' WHERE id = $1`,
          [listingId]
        );
      }

      // Create order (instant delivery)
      const orderResult = await client.query(
        `INSERT INTO orders (buyer_customer_id, store_id, listing_id, quantity,
          unit_price_cents, total_price_cents, currency, status, delivered_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'DELIVERED', NOW())
         RETURNING *`,
        [customerId, listing.store_id, listingId, quantity,
         listing.price_cents, listing.price_cents * quantity, listing.currency]
      );

      return orderResult.rows[0];
    }).then(async (order) => {
      await ActivityService.emit('ORDER_PLACED', customerId, {
        storeId: order.store_id, listingId, orderId: order.id
      });
      await ActivityService.emit('ORDER_DELIVERED', customerId, {
        storeId: order.store_id, listingId, orderId: order.id
      });
      return { success: true, order };
    });
  }

  /**
   * Purchase via an accepted offer
   */
  static async purchaseFromOffer(customerId, offerId, quantity = 1) {
    return transaction(async (client) => {
      // Lock offer and verify
      const offerResult = await client.query(
        `SELECT o.*, s.owner_merchant_id
         FROM offers o
         JOIN stores s ON o.seller_store_id = s.id
         WHERE o.id = $1 FOR UPDATE`,
        [offerId]
      );
      const offer = offerResult.rows[0];
      if (!offer) throw new NotFoundError('Offer');
      if (offer.buyer_customer_id !== customerId) {
        throw new ForbiddenError('This offer does not belong to you');
      }
      if (offer.status !== 'ACCEPTED') {
        throw new BadRequestError(`Cannot purchase from offer with status: ${offer.status}`);
      }

      // Check gating
      const evidence = await client.query(
        'SELECT id FROM interaction_evidence WHERE customer_id = $1 AND listing_id = $2 LIMIT 1',
        [customerId, offer.listing_id]
      );
      if (evidence.rows.length === 0) {
        throw new BadRequestError('Purchase gating not satisfied for this listing');
      }

      // Lock listing
      const listingResult = await client.query(
        `SELECT id, store_id, price_cents, currency, inventory_on_hand, status
         FROM listings WHERE id = $1 FOR UPDATE`,
        [offer.listing_id]
      );
      const listing = listingResult.rows[0];
      if (!listing) throw new NotFoundError('Listing');
      if (listing.status !== 'ACTIVE') {
        throw new BadRequestError('Listing is not currently active');
      }
      if (listing.inventory_on_hand < quantity) {
        throw new BadRequestError(`Insufficient inventory (available: ${listing.inventory_on_hand})`);
      }

      // Decrement inventory
      await client.query(
        'UPDATE listings SET inventory_on_hand = inventory_on_hand - $2, updated_at = NOW() WHERE id = $1',
        [offer.listing_id, quantity]
      );

      if (listing.inventory_on_hand - quantity <= 0) {
        await client.query(
          `UPDATE listings SET status = 'SOLD_OUT' WHERE id = $1`,
          [offer.listing_id]
        );
      }

      // Create order at offer price
      const orderResult = await client.query(
        `INSERT INTO orders (buyer_customer_id, store_id, listing_id, quantity,
          unit_price_cents, total_price_cents, currency, status, delivered_at, source_offer_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'DELIVERED', NOW(), $8)
         RETURNING *`,
        [customerId, listing.store_id, offer.listing_id, quantity,
         offer.proposed_price_cents, offer.proposed_price_cents * quantity,
         offer.currency, offerId]
      );

      return orderResult.rows[0];
    }).then(async (order) => {
      await ActivityService.emit('ORDER_PLACED', customerId, {
        storeId: order.store_id, listingId: order.listing_id, orderId: order.id
      });
      await ActivityService.emit('ORDER_DELIVERED', customerId, {
        storeId: order.store_id, listingId: order.listing_id, orderId: order.id
      });
      return { success: true, order };
    });
  }

  /**
   * Get order by ID
   */
  static async findById(orderId) {
    const order = await queryOne(
      `SELECT o.*,
              a.name as buyer_name,
              s.name as store_name,
              p.title as product_title
       FROM orders o
       JOIN agents a ON o.buyer_customer_id = a.id
       JOIN stores s ON o.store_id = s.id
       JOIN listings l ON o.listing_id = l.id
       JOIN products p ON l.product_id = p.id
       WHERE o.id = $1`,
      [orderId]
    );
    if (!order) throw new NotFoundError('Order');
    return order;
  }
}

module.exports = OrderService;
