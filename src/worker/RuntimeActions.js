/**
 * Runtime Actions
 * Maps actionType strings to service-layer method calls.
 * 
 * VALIDATES all args before calling services to prevent failures.
 * Auto-resolves missing/invalid IDs from agent context where possible.
 */

const StoreService = require('../services/commerce/StoreService');
const CatalogService = require('../services/commerce/CatalogService');
const CommerceThreadService = require('../services/commerce/CommerceThreadService');
const OfferService = require('../services/commerce/OfferService');
const OrderService = require('../services/commerce/OrderService');
const ReviewService = require('../services/commerce/ReviewService');
const ActivityService = require('../services/commerce/ActivityService');
const CommentService = require('../services/CommentService');
const InteractionEvidenceService = require('../services/commerce/InteractionEvidenceService');
const { queryOne, queryAll } = require('../config/database');
const config = require('../config');

// UUID v4 pattern
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUUID(val) {
  return typeof val === 'string' && UUID_RE.test(val);
}

class RuntimeActions {
  /**
   * Execute an action with pre-flight validation.
   */
  static async execute(actionType, args, agent) {
    try {
      // Auto-resolve invalid args before calling services
      args = await this._resolveArgs(actionType, args, agent);

      let result;

      switch (actionType) {
        case 'create_product': {
          if (!isValidUUID(args.storeId)) throw new Error('Invalid storeId');
          if (!args.title || args.title.trim().length < 2) throw new Error('Product title required');
          result = await CatalogService.createProduct(agent.id, args.storeId, {
            title: args.title.trim(),
            description: (args.description || '').trim()
          });
          break;
        }
        case 'create_listing': {
          if (!isValidUUID(args.storeId)) throw new Error('Invalid storeId');
          if (!isValidUUID(args.productId)) throw new Error('Invalid productId');
          const price = parseInt(args.priceCents || args.price_cents || args.price, 10);
          if (!price || price < 1) throw new Error('Invalid priceCents');
          result = await CatalogService.createListing(agent.id, args.storeId, {
            productId: args.productId || args.product_id,
            priceCents: price,
            currency: args.currency || 'USD',
            inventoryOnHand: parseInt(args.inventoryOnHand || args.inventory || 20, 10)
          });
          break;
        }
        case 'create_looking_for':
          result = await this._createLookingFor(agent, args);
          break;
        case 'ask_question':
          result = await this._askQuestion(agent, args);
          break;
        case 'make_offer':
          result = await this._makeOffer(agent, args);
          break;
        case 'accept_offer': {
          if (!isValidUUID(args.offerId)) throw new Error('Invalid offerId');
          result = await OfferService.acceptOffer(agent.id, args.offerId);
          break;
        }
        case 'reject_offer': {
          if (!isValidUUID(args.offerId)) throw new Error('Invalid offerId');
          result = await OfferService.rejectOffer(agent.id, args.offerId);
          break;
        }
        case 'purchase_direct': {
          if (!isValidUUID(args.listingId)) throw new Error('Invalid listingId');
          // Pre-check listing is active
          const listing = await queryOne('SELECT status FROM listings WHERE id = $1', [args.listingId]);
          if (!listing || listing.status !== 'ACTIVE') throw new Error('Listing is not active');
          result = await OrderService.purchaseDirect(agent.id, args.listingId, args.quantity || 1);
          break;
        }
        case 'purchase_from_offer': {
          if (!isValidUUID(args.offerId)) throw new Error('Invalid offerId');
          // Pre-check offer is accepted and listing is active
          const offer = await queryOne(
            `SELECT o.status, l.status as listing_status FROM offers o
             JOIN listings l ON o.listing_id = l.id WHERE o.id = $1`, [args.offerId]);
          if (!offer) throw new Error('Offer not found');
          if (offer.status !== 'ACCEPTED') throw new Error('Offer is not accepted');
          if (offer.listing_status !== 'ACTIVE') throw new Error('Listing is not active');
          result = await OrderService.purchaseFromOffer(agent.id, args.offerId, args.quantity || 1);
          break;
        }
        case 'leave_review': {
          const orderId = args.orderId || args.order_id;
          if (!isValidUUID(orderId)) throw new Error('Invalid orderId');
          const reviewBody = (args.body || args.content || args.text || args.review || '').trim();
          const rating = Math.min(5, Math.max(1, parseInt(args.rating, 10) || 3));
          result = await ReviewService.leaveReview(agent.id, orderId, {
            rating,
            title: args.title || null,
            body: reviewBody.length > 0 ? reviewBody : null
          });
          break;
        }
        case 'reply_in_thread':
          result = await this._replyInThread(agent, args);
          break;
        case 'create_offer_reference':
          result = await OfferService.createOfferReference(agent.id, {
            offerId: args.offerId,
            threadId: args.threadId,
            publicNote: args.publicNote
          });
          break;
        case 'update_price': {
          const listingId = args.listingId || args.listing_id;
          if (!isValidUUID(listingId)) throw new Error('Invalid listingId');
          const newPrice = parseInt(args.newPriceCents || args.new_price_cents || args.price, 10);
          if (!newPrice || newPrice < 1) throw new Error('Invalid newPriceCents');
          result = await CatalogService.updatePrice(agent.id, listingId, {
            newPriceCents: newPrice,
            reason: args.reason || 'Price adjustment'
          });
          break;
        }
        case 'update_policies':
          result = await StoreService.updatePolicies(agent.id, args.storeId, {
            returnPolicyText: args.returnPolicyText,
            shippingPolicyText: args.shippingPolicyText,
            reason: args.reason
          });
          break;
        case 'skip':
          result = { skipped: true };
          break;
        default:
          throw new Error(`Unknown action type: ${actionType}`);
      }

      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Auto-resolve invalid or missing IDs from agent context.
   * The LLM sometimes sends placeholder strings instead of real UUIDs.
   */
  static async _resolveArgs(actionType, args, agent) {
    args = { ...args }; // shallow copy

    // Normalize common field name variations
    if (args.store_id && !args.storeId) args.storeId = args.store_id;
    if (args.product_id && !args.productId) args.productId = args.product_id;
    if (args.listing_id && !args.listingId) args.listingId = args.listing_id;
    if (args.offer_id && !args.offerId) args.offerId = args.offer_id;
    if (args.order_id && !args.orderId) args.orderId = args.order_id;
    if (args.thread_id && !args.threadId) args.threadId = args.thread_id;

    // Auto-resolve storeId for merchants with a single store
    if (['create_product', 'create_listing', 'update_policies'].includes(actionType)) {
      if (!isValidUUID(args.storeId)) {
        const store = await queryOne(
          'SELECT id FROM stores WHERE owner_merchant_id = $1 LIMIT 1', [agent.id]
        );
        if (store) args.storeId = store.id;
      }
    }

    // Auto-resolve listingId: if invalid, try to find one from agent's store
    if (['update_price'].includes(actionType) && !isValidUUID(args.listingId)) {
      const listing = await queryOne(
        `SELECT l.id FROM listings l JOIN stores s ON l.store_id = s.id
         WHERE s.owner_merchant_id = $1 AND l.status = 'ACTIVE'
         ORDER BY RANDOM() LIMIT 1`, [agent.id]
      );
      if (listing) args.listingId = listing.id;
    }

    // Auto-resolve listingId for customer actions
    if (['ask_question', 'make_offer', 'purchase_direct'].includes(actionType) && !isValidUUID(args.listingId)) {
      const listing = await queryOne(
        `SELECT id FROM listings WHERE status = 'ACTIVE' ORDER BY RANDOM() LIMIT 1`
      );
      if (listing) args.listingId = listing.id;
    }

    // Auto-resolve offerId for accept/reject
    if (['accept_offer', 'reject_offer'].includes(actionType) && !isValidUUID(args.offerId)) {
      const offer = await queryOne(
        `SELECT o.id FROM offers o JOIN stores s ON o.seller_store_id = s.id
         WHERE s.owner_merchant_id = $1 AND o.status = 'PROPOSED'
         ORDER BY o.created_at ASC LIMIT 1`, [agent.id]
      );
      if (offer) args.offerId = offer.id;
    }

    // Auto-resolve offerId for purchase_from_offer
    if (actionType === 'purchase_from_offer' && !isValidUUID(args.offerId)) {
      const offer = await queryOne(
        `SELECT o.id FROM offers o
         JOIN listings l ON o.listing_id = l.id
         WHERE o.buyer_customer_id = $1 AND o.status = 'ACCEPTED' AND l.status = 'ACTIVE'
         LIMIT 1`, [agent.id]
      );
      if (offer) args.offerId = offer.id;
    }

    // Auto-resolve orderId for leave_review
    if (actionType === 'leave_review' && !isValidUUID(args.orderId)) {
      const order = await queryOne(
        `SELECT o.id FROM orders o
         WHERE o.buyer_customer_id = $1 AND o.status = 'DELIVERED'
           AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.order_id = o.id)
         LIMIT 1`, [agent.id]
      );
      if (order) args.orderId = order.id;
    }

    // Auto-resolve threadId for reply_in_thread
    if (actionType === 'reply_in_thread' && !isValidUUID(args.threadId)) {
      const thread = await queryOne(
        `SELECT id FROM posts WHERE thread_type IS NOT NULL AND thread_status = 'OPEN'
         ORDER BY created_at DESC LIMIT 1`
      );
      if (thread) args.threadId = thread.id;
    }

    return args;
  }

  static async _createLookingFor(agent, args) {
    const constraints = args.constraints || {
      budgetCents: parseInt(args.budgetCents, 10) || 5000,
      category: args.category || 'general'
    };
    return CommerceThreadService.createLookingForThread(
      agent.id,
      args.title || 'Looking for something',
      JSON.stringify(constraints),
      null, null
    );
  }

  static async _askQuestion(agent, args) {
    const listingId = args.listingId;
    if (!isValidUUID(listingId)) throw new Error('Invalid listingId');

    const dropThread = await CommerceThreadService.findDropThread(listingId);
    if (!dropThread) throw new Error('No drop thread for listing');

    const content = (args.content || args.question || args.body || args.text || '').trim();
    if (content.length < config.gating.minQuestionLen) {
      throw new Error(`Question must be >= ${config.gating.minQuestionLen} chars`);
    }

    const comment = await CommentService.create({
      postId: dropThread.id,
      authorId: agent.id,
      content
    });

    await InteractionEvidenceService.record({
      customerId: agent.id,
      listingId,
      type: 'QUESTION_POSTED',
      threadId: dropThread.id,
      commentId: comment.id
    });

    await ActivityService.emit('MESSAGE_POSTED', agent.id, {
      listingId,
      threadId: dropThread.id,
      messageId: comment.id
    });

    return comment;
  }

  static async _makeOffer(agent, args) {
    const listingId = args.listingId;
    if (!isValidUUID(listingId)) throw new Error('Invalid listingId');

    // Pre-check listing is active
    const listing = await queryOne('SELECT status FROM listings WHERE id = $1', [listingId]);
    if (!listing || listing.status !== 'ACTIVE') throw new Error('Listing is not active');

    const price = parseInt(args.proposedPriceCents || args.proposed_price_cents || args.price, 10);
    if (!price || price < 1) throw new Error('Invalid proposedPriceCents');

    return OfferService.makeOffer(agent.id, {
      listingId,
      proposedPriceCents: price,
      currency: args.currency || 'USD',
      buyerMessage: args.buyerMessage || args.buyer_message || args.message || 'Interested in this listing.'
    });
  }

  static async _replyInThread(agent, args) {
    const threadId = args.threadId;
    if (!isValidUUID(threadId)) throw new Error('Invalid threadId');

    const raw = (args.content || args.body || args.text || args.message || '').trim();
    if (raw.length < 1) throw new Error('Reply content is empty');

    const comment = await CommentService.create({
      postId: threadId,
      authorId: agent.id,
      content: raw,
      parentId: args.parentId || args.parent_id
    });

    await ActivityService.emit('MESSAGE_POSTED', agent.id, {
      threadId,
      messageId: comment.id
    });

    return comment;
  }
}

module.exports = RuntimeActions;
