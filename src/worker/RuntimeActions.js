/**
 * Runtime Actions
 * Maps actionType strings to service-layer method calls.
 * No direct DB writes — always goes through commerce services.
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
const config = require('../config');

class RuntimeActions {
  /**
   * Execute an action by type
   *
   * @param {string} actionType
   * @param {Object} args
   * @param {Object} agent - The agent performing the action
   * @returns {Promise<{success: boolean, result?: any, error?: string}>}
   */
  static async execute(actionType, args, agent) {
    try {
      let result;

      switch (actionType) {
        case 'create_product':
          result = await CatalogService.createProduct(agent.id, args.storeId || args.store_id, {
            title: args.title || 'New Product',
            description: args.description || 'A great new product.'
          });
          break;
        case 'create_listing':
          result = await CatalogService.createListing(agent.id, args.storeId || args.store_id, {
            productId: args.productId || args.product_id,
            priceCents: args.priceCents || args.price_cents || args.price || 2999,
            currency: args.currency || 'USD',
            inventoryOnHand: args.inventoryOnHand || args.inventory || 20
          });
          break;
        case 'create_looking_for':
          result = await this._createLookingFor(agent, args);
          break;
        case 'ask_question':
          result = await this._askQuestion(agent, args);
          break;
        case 'make_offer':
          result = await this._makeOffer(agent, args);
          break;
        case 'accept_offer':
          result = await OfferService.acceptOffer(agent.id, args.offerId || args.offer_id);
          break;
        case 'reject_offer':
          result = await OfferService.rejectOffer(agent.id, args.offerId || args.offer_id);
          break;
        case 'purchase_direct':
          result = await OrderService.purchaseDirect(agent.id, args.listingId, args.quantity || 1);
          break;
        case 'purchase_from_offer':
          result = await OrderService.purchaseFromOffer(agent.id, args.offerId, args.quantity || 1);
          break;
        case 'leave_review': {
          const reviewBody = (args.body || args.content || args.text || args.review || '').trim();
          const rating = Math.min(5, Math.max(1, parseInt(args.rating, 10) || 4));
          result = await ReviewService.leaveReview(agent.id, args.orderId || args.order_id, {
            rating,
            title: args.title || null,
            body: reviewBody.length > 0 ? reviewBody
              : `${rating >= 4 ? 'Great product, would recommend!' : 'Decent product, met my expectations.'}`
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
        case 'update_price':
          result = await CatalogService.updatePrice(agent.id, args.listingId, {
            newPriceCents: args.newPriceCents,
            reason: args.reason
          });
          break;
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

  static async _createLookingFor(agent, args) {
    const constraints = args.constraints || {
      budgetCents: args.budgetCents || 5000,
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
    const listingId = args.listingId || args.listing_id;
    const dropThread = await CommerceThreadService.findDropThread(listingId);
    if (!dropThread) throw new Error('No drop thread for listing');

    const content = args.content || args.question || args.body || args.text ||
      'Can you tell me more about this product? I am curious about the quality and features.';
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
    return OfferService.makeOffer(agent.id, {
      listingId: args.listingId || args.listing_id,
      proposedPriceCents: args.proposedPriceCents || args.proposed_price_cents || args.price,
      currency: args.currency || 'USD',
      buyerMessage: args.buyerMessage || args.buyer_message || args.message || 'I am interested in this listing.'
    });
  }

  static async _replyInThread(agent, args) {
    // Normalize LLM arg variations (content/body/text/message)
    // Use .trim() check to catch empty strings
    const raw = args.content || args.body || args.text || args.message || '';
    const content = raw.trim().length > 0 ? raw.trim()
      : `Interesting point! I'd like to share my thoughts on this.`;

    const comment = await CommentService.create({
      postId: args.threadId || args.thread_id || args.postId,
      authorId: agent.id,
      content,
      parentId: args.parentId || args.parent_id
    });

    await ActivityService.emit('MESSAGE_POSTED', agent.id, {
      threadId: args.threadId || args.thread_id || args.postId,
      messageId: comment.id
    });

    return comment;
  }
}

module.exports = RuntimeActions;
