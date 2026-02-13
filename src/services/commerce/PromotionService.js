/**
 * Promotion / Ad Service
 * Manages the promotion queue: max 3 active, max 10 total (active + queued).
 * Merchants promote underperforming listings with a discount.
 */

const { queryOne, queryAll } = require('../../config/database');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../../utils/errors');

const MAX_ACTIVE = 3;
const MAX_TOTAL = 10;

class PromotionService {
  /**
   * Create a promotion for a listing.
   * Goes ACTIVE if < 3 active, otherwise QUEUED. Rejects if >= 10 total.
   */
  static async createPromotion(merchantId, listingId, promoPriceCents) {
    // Validate listing exists and merchant owns it
    const listing = await queryOne(
      `SELECT l.id, l.price_cents, l.store_id, l.status, s.owner_merchant_id
       FROM listings l JOIN stores s ON l.store_id = s.id
       WHERE l.id = $1`,
      [listingId]
    );
    if (!listing) throw new NotFoundError('Listing');
    if (listing.owner_merchant_id !== merchantId) throw new ForbiddenError('You do not own this listing');
    if (listing.status !== 'ACTIVE') throw new BadRequestError('Listing must be active to promote');

    // Validate promo price
    if (!promoPriceCents || promoPriceCents <= 0) throw new BadRequestError('Promo price must be > 0');
    if (promoPriceCents >= listing.price_cents) throw new BadRequestError('Promo price must be less than current price');

    // Check no existing active/queued promo for this listing
    const existing = await queryOne(
      `SELECT id FROM promotions WHERE listing_id = $1 AND status IN ('ACTIVE', 'QUEUED')`,
      [listingId]
    );
    if (existing) throw new BadRequestError('This listing already has an active or queued promotion');

    // Check total queue size
    const total = await queryOne(
      `SELECT COUNT(*)::int as c FROM promotions WHERE status IN ('ACTIVE', 'QUEUED')`
    );
    if (total.c >= MAX_TOTAL) throw new BadRequestError('Promotion queue is full (max 10). Try again later.');

    // Check active count to determine status
    const activeCount = await queryOne(
      `SELECT COUNT(*)::int as c FROM promotions WHERE status = 'ACTIVE'`
    );
    const status = activeCount.c < MAX_ACTIVE ? 'ACTIVE' : 'QUEUED';
    const position = total.c + 1;

    const promo = await queryOne(
      `INSERT INTO promotions (listing_id, store_id, merchant_id, original_price_cents, promo_price_cents, status, position, activated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [listingId, listing.store_id, merchantId, listing.price_cents, promoPriceCents, status, position,
       status === 'ACTIVE' ? new Date() : null]
    );

    return promo;
  }

  /**
   * Get active promotions with full listing data (for main page injection).
   */
  static async getActivePromotions() {
    return queryAll(
      `SELECT p.id as promo_id, p.original_price_cents, p.promo_price_cents, p.status as promo_status,
              p.created_at as promo_created_at, p.expires_at as promo_expires_at,
              l.id, l.store_id, l.product_id, l.price_cents, l.currency, l.inventory_on_hand, l.status, l.created_at, l.updated_at,
              pr.title as product_title, pr.description as product_description,
              s.name as store_name, s.owner_merchant_id,
              (SELECT image_url FROM product_images WHERE product_id = l.product_id ORDER BY position ASC LIMIT 1) as primary_image_url,
              (SELECT COUNT(*)::int FROM offers WHERE listing_id = l.id) as offer_count
       FROM promotions p
       JOIN listings l ON p.listing_id = l.id
       JOIN products pr ON l.product_id = pr.id
       JOIN stores s ON l.store_id = s.id
       WHERE p.status = 'ACTIVE'
       ORDER BY p.activated_at ASC
       LIMIT $1`,
      [MAX_ACTIVE]
    );
  }

  /**
   * Get active promotion for a specific store (for store page pinning).
   */
  static async getStorePromotion(storeId) {
    return queryOne(
      `SELECT p.id as promo_id, p.original_price_cents, p.promo_price_cents, p.status as promo_status,
              l.id, l.store_id, l.product_id, l.price_cents, l.currency, l.inventory_on_hand, l.status, l.created_at, l.updated_at,
              pr.title as product_title, pr.description as product_description,
              s.name as store_name, s.owner_merchant_id,
              (SELECT image_url FROM product_images WHERE product_id = l.product_id ORDER BY position ASC LIMIT 1) as primary_image_url
       FROM promotions p
       JOIN listings l ON p.listing_id = l.id
       JOIN products pr ON l.product_id = pr.id
       JOIN stores s ON l.store_id = s.id
       WHERE p.store_id = $1 AND p.status = 'ACTIVE'
       ORDER BY p.activated_at DESC
       LIMIT 1`,
      [storeId]
    );
  }

  /**
   * Expire stale promotions and promote next queued ones.
   * Called periodically from the worker.
   */
  static async expireStale() {
    // Expire past-due promotions
    const expired = await queryAll(
      `UPDATE promotions SET status = 'EXPIRED'
       WHERE status = 'ACTIVE' AND expires_at < NOW()
       RETURNING id, listing_id`
    );

    if (expired.length > 0) {
      console.log(`[promo] Expired ${expired.length} promotion(s)`);
    }

    // Promote next queued items to fill active slots
    const activeCount = await queryOne(
      `SELECT COUNT(*)::int as c FROM promotions WHERE status = 'ACTIVE'`
    );
    const slotsAvailable = MAX_ACTIVE - activeCount.c;

    if (slotsAvailable > 0) {
      const promoted = await queryAll(
        `UPDATE promotions SET status = 'ACTIVE', activated_at = NOW()
         WHERE id IN (
           SELECT id FROM promotions WHERE status = 'QUEUED'
           ORDER BY position ASC, created_at ASC
           LIMIT $1
         )
         RETURNING id, listing_id`,
        [slotsAvailable]
      );
      if (promoted.length > 0) {
        console.log(`[promo] Activated ${promoted.length} queued promotion(s)`);
      }
    }

    return { expired: expired.length, promoted: slotsAvailable > 0 ? slotsAvailable : 0 };
  }

  /**
   * Cancel a promotion (merchant only).
   */
  static async cancelPromotion(merchantId, promoId) {
    const promo = await queryOne(
      `SELECT * FROM promotions WHERE id = $1`,
      [promoId]
    );
    if (!promo) throw new NotFoundError('Promotion');
    if (promo.merchant_id !== merchantId) throw new ForbiddenError('You do not own this promotion');
    if (promo.status !== 'ACTIVE' && promo.status !== 'QUEUED') {
      throw new BadRequestError('Promotion is already expired or cancelled');
    }

    await queryOne(
      `UPDATE promotions SET status = 'CANCELLED' WHERE id = $1`,
      [promoId]
    );

    // If was active, promote next queued
    if (promo.status === 'ACTIVE') {
      await this.expireStale();
    }

    return { cancelled: true };
  }
}

module.exports = PromotionService;
