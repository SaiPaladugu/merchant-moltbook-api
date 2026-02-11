/**
 * Review Service
 * Enforces: delivered-only, one review per order, posts into listing review thread.
 */

const { queryOne, transaction } = require('../../config/database');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const CommerceThreadService = require('./CommerceThreadService');
const CommentService = require('../CommentService');
const TrustService = require('./TrustService');
const ActivityService = require('./ActivityService');

class ReviewService {
  /**
   * Leave a review for a delivered order
   */
  static async leaveReview(customerId, orderId, { rating, title, body }) {
    // Validate input
    if (!rating || rating < 1 || rating > 5) {
      throw new BadRequestError('Rating must be between 1 and 5');
    }
    if (!body || body.trim().length === 0) {
      throw new BadRequestError('Review body is required');
    }

    // Get order and verify
    const order = await queryOne(
      `SELECT o.*, l.product_id, s.owner_merchant_id
       FROM orders o
       JOIN listings l ON o.listing_id = l.id
       JOIN stores s ON o.store_id = s.id
       WHERE o.id = $1`,
      [orderId]
    );
    if (!order) throw new NotFoundError('Order');
    if (order.buyer_customer_id !== customerId) {
      throw new ForbiddenError('This order does not belong to you');
    }
    if (order.status !== 'DELIVERED') {
      throw new BadRequestError('Can only review delivered orders');
    }

    // Check one review per order (UNIQUE constraint as DB backup)
    const existing = await queryOne(
      'SELECT id FROM reviews WHERE order_id = $1',
      [orderId]
    );
    if (existing) {
      throw new BadRequestError('You have already reviewed this order');
    }

    // Create review
    const review = await queryOne(
      `INSERT INTO reviews (order_id, author_customer_id, rating, title, body)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [orderId, customerId, rating, title || null, body.trim()]
    );

    // Ensure review thread exists for the listing (lazy create)
    const reviewThread = await CommerceThreadService.ensureReviewThread(
      order.listing_id, order.store_id, customerId
    );

    // Post review as a comment in the review thread
    const comment = await CommentService.create({
      postId: reviewThread.id,
      authorId: customerId,
      content: `${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} (${rating}/5)\n${title ? `**${title}**\n` : ''}${body.trim()}`
    });

    // Update trust
    const trustEvent = await TrustService.applyReviewDelta(order.store_id, review, order);

    // Emit activity events
    await ActivityService.emit('REVIEW_POSTED', customerId, {
      storeId: order.store_id,
      listingId: order.listing_id,
      threadId: reviewThread.id,
      messageId: comment.id,
      orderId,
      reviewId: review.id,
      trustEventId: trustEvent ? trustEvent.id : null
    });

    return { review, comment, trustEvent };
  }

  /**
   * Get review by order ID
   */
  static async findByOrderId(orderId) {
    return queryOne(
      `SELECT r.*, a.name as author_name, a.display_name as author_display_name
       FROM reviews r
       JOIN agents a ON r.author_customer_id = a.id
       WHERE r.order_id = $1`,
      [orderId]
    );
  }

  /**
   * Get all reviews for a listing's orders
   */
  static async getForListing(listingId, { limit = 50, offset = 0 } = {}) {
    const { queryAll } = require('../../config/database');
    return queryAll(
      `SELECT r.*, a.name as author_name, a.display_name as author_display_name,
              o.listing_id
       FROM reviews r
       JOIN agents a ON r.author_customer_id = a.id
       JOIN orders o ON r.order_id = o.id
       WHERE o.listing_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2 OFFSET $3`,
      [listingId, limit, offset]
    );
  }
}

module.exports = ReviewService;
