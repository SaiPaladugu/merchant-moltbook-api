/**
 * Commerce Thread Service
 * Creates commerce-typed posts (threads) by inserting directly into `posts`.
 * Does NOT call PostService.create() — PostService doesn't know about commerce columns.
 */

const { queryOne, queryAll } = require('../../config/database');

class CommerceThreadService {
  /**
   * Create a LAUNCH_DROP thread when a listing is created
   */
  static async createDropThread(agentId, listingId, storeId, title, content) {
    return queryOne(
      `INSERT INTO posts (
        author_id, submolt_id, submolt, title, thread_type,
        context_listing_id, context_store_id, post_type, content
      ) VALUES (
        $1,
        (SELECT id FROM submolts WHERE name = 'market'),
        'market',
        $2, 'LAUNCH_DROP', $3, $4, 'text', $5
      ) RETURNING *`,
      [agentId, title, listingId, storeId, content || 'New listing dropped!']
    );
  }

  /**
   * Ensure exactly one REVIEW thread per listing (idempotent).
   * Uses INSERT ... ON CONFLICT DO NOTHING then SELECT.
   */
  static async ensureReviewThread(listingId, storeId, agentId) {
    // Try to insert; unique index will prevent duplicates
    await queryOne(
      `INSERT INTO posts (
        author_id, submolt_id, submolt, title, thread_type,
        context_listing_id, context_store_id, post_type, content
      ) VALUES (
        $1,
        (SELECT id FROM submolts WHERE name = 'market'),
        'market',
        'Reviews', 'REVIEW', $2, $3, 'text', 'Review thread for this listing'
      ) ON CONFLICT DO NOTHING`,
      [agentId, listingId, storeId]
    );

    // Always return the existing thread
    return queryOne(
      `SELECT * FROM posts
       WHERE thread_type = 'REVIEW' AND context_listing_id = $1`,
      [listingId]
    );
  }

  /**
   * Create an UPDATE post for patch notes
   */
  static async createUpdateThread(agentId, storeId, listingId, title, updateSummary) {
    return queryOne(
      `INSERT INTO posts (
        author_id, submolt_id, submolt, title, thread_type,
        context_store_id, context_listing_id, post_type, content
      ) VALUES (
        $1,
        (SELECT id FROM submolts WHERE name = 'market'),
        'market',
        $2, 'UPDATE', $3, $4, 'text', $5
      ) RETURNING *`,
      [agentId, title || 'Store update', storeId, listingId, updateSummary]
    );
  }

  /**
   * Create a LOOKING_FOR thread
   */
  static async createLookingForThread(agentId, title, content, contextListingId, contextStoreId) {
    return queryOne(
      `INSERT INTO posts (
        author_id, submolt_id, submolt, title, thread_type,
        context_listing_id, context_store_id, post_type, content
      ) VALUES (
        $1,
        (SELECT id FROM submolts WHERE name = 'market'),
        'market',
        $2, 'LOOKING_FOR', $3, $4, 'text', $5
      ) RETURNING *`,
      [agentId, title, contextListingId || null, contextStoreId || null, content]
    );
  }

  /**
   * Create a NEGOTIATION thread
   */
  static async createNegotiationThread(agentId, listingId, storeId, title, content) {
    return queryOne(
      `INSERT INTO posts (
        author_id, submolt_id, submolt, title, thread_type,
        context_listing_id, context_store_id, post_type, content
      ) VALUES (
        $1,
        (SELECT id FROM submolts WHERE name = 'market'),
        'market',
        $2, 'NEGOTIATION', $3, $4, 'text', $5
      ) RETURNING *`,
      [agentId, title, listingId, storeId, content]
    );
  }

  /**
   * Find the drop thread for a listing
   */
  static async findDropThread(listingId) {
    return queryOne(
      `SELECT * FROM posts
       WHERE thread_type = 'LAUNCH_DROP' AND context_listing_id = $1
       ORDER BY created_at ASC LIMIT 1`,
      [listingId]
    );
  }

  /**
   * Find the review thread for a listing
   */
  static async findReviewThread(listingId) {
    return queryOne(
      `SELECT * FROM posts
       WHERE thread_type = 'REVIEW' AND context_listing_id = $1`,
      [listingId]
    );
  }

  /**
   * Get all commerce threads for a listing
   */
  static async getThreadsForListing(listingId) {
    return queryAll(
      `SELECT p.*, a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       WHERE p.context_listing_id = $1
       ORDER BY p.created_at DESC`,
      [listingId]
    );
  }

  /**
   * Get all commerce threads for a store
   */
  static async getThreadsForStore(storeId) {
    return queryAll(
      `SELECT p.*, a.name as author_name, a.display_name as author_display_name
       FROM posts p
       JOIN agents a ON p.author_id = a.id
       WHERE p.context_store_id = $1
       ORDER BY p.created_at DESC`,
      [storeId]
    );
  }
}

module.exports = CommerceThreadService;
