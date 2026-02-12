/**
 * Catalog Service
 * Handles products (descriptive, no pricing) and listings (sellable, with pricing/inventory).
 * Image generation is non-blocking — product is created even if image gen fails.
 */

const { queryOne, queryAll, transaction } = require('../../config/database');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../../utils/errors');
const CommerceThreadService = require('./CommerceThreadService');
const ActivityService = require('./ActivityService');
const ImageGenService = require('../media/ImageGenService');

class CatalogService {
  // ─── Products ───────────────────────────────────────────────

  /**
   * Create a product (descriptive only — no pricing)
   * Triggers image generation (non-blocking).
   * Returns existing product if one with the same title already exists in this store.
   */
  static async createProduct(merchantId, storeId, { title, description }) {
    if (!title || title.trim().length === 0) {
      throw new BadRequestError('Product title is required');
    }

    // Verify store ownership
    const store = await queryOne(
      'SELECT id, owner_merchant_id, brand_voice FROM stores WHERE id = $1',
      [storeId]
    );
    if (!store) throw new NotFoundError('Store');
    if (store.owner_merchant_id !== merchantId) {
      throw new ForbiddenError('You do not own this store');
    }

    // Check for existing product with same title in this store (prevent duplicates)
    const existingProduct = await queryOne(
      'SELECT * FROM products WHERE store_id = $1 AND LOWER(title) = LOWER($2)',
      [storeId, title.trim()]
    );
    if (existingProduct) {
      console.log(`Product "${title}" already exists in store ${storeId}, returning existing`);
      return existingProduct;
    }

    // Create product first (always succeeds regardless of image gen)
    const product = await queryOne(
      `INSERT INTO products (store_id, title, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [storeId, title.trim(), description || '']
    );

    // Attempt image generation (non-blocking)
    try {
      const prompt = ImageGenService.buildPrompt(product, store);
      const { imageUrl } = await ImageGenService.generateProductImage({
        prompt,
        storeId,
        productId: product.id
      });

      // Persist prompt and image
      await queryOne(
        'UPDATE products SET image_prompt = $2 WHERE id = $1',
        [product.id, prompt]
      );
      await queryOne(
        `INSERT INTO product_images (product_id, image_url, position)
         VALUES ($1, $2, 0)`,
        [product.id, imageUrl]
      );

      await ActivityService.emit('PRODUCT_IMAGE_GENERATED', merchantId, {
        storeId, listingId: null
      }, { success: true, productId: product.id });

    } catch (error) {
      // Image gen failed — product still created, emit failure for debugging
      console.warn(`Image generation failed for product ${product.id}:`, error.message);
      await ActivityService.emit('PRODUCT_IMAGE_GENERATED', merchantId, {
        storeId, listingId: null
      }, { success: false, error: error.message, productId: product.id });
    }

    return product;
  }

  /**
   * Get product by ID with images
   */
  static async findProductById(productId) {
    const product = await queryOne(
      'SELECT * FROM products WHERE id = $1',
      [productId]
    );
    if (!product) throw new NotFoundError('Product');
    return product;
  }

  /**
   * Get product images ordered by position
   */
  static async getProductImages(productId) {
    return queryAll(
      'SELECT * FROM product_images WHERE product_id = $1 ORDER BY position ASC',
      [productId]
    );
  }

  /**
   * Regenerate product image with optional prompt override
   */
  static async regenerateImage(merchantId, productId, promptOverride) {
    const product = await this.findProductById(productId);
    const store = await queryOne(
      'SELECT * FROM stores WHERE id = $1',
      [product.store_id]
    );
    if (!store) throw new NotFoundError('Store');
    if (store.owner_merchant_id !== merchantId) {
      throw new ForbiddenError('You do not own this store');
    }

    // Check max images
    const config = require('../../config');
    const imageCount = await queryOne(
      'SELECT COUNT(*)::int as count FROM product_images WHERE product_id = $1',
      [productId]
    );
    if (imageCount.count >= config.image.maxImagesPerProduct) {
      throw new BadRequestError(`Maximum ${config.image.maxImagesPerProduct} images per product`);
    }

    const prompt = promptOverride || ImageGenService.buildPrompt(product, store);
    const { imageUrl } = await ImageGenService.generateProductImage({
      prompt,
      storeId: store.id,
      productId
    });

    // Update prompt and add new image at next position
    await queryOne(
      'UPDATE products SET image_prompt = $2, updated_at = NOW() WHERE id = $1',
      [productId, prompt]
    );
    const image = await queryOne(
      `INSERT INTO product_images (product_id, image_url, position)
       VALUES ($1, $2, (SELECT COALESCE(MAX(position), -1) + 1 FROM product_images WHERE product_id = $1))
       RETURNING *`,
      [productId, imageUrl]
    );

    await ActivityService.emit('PRODUCT_IMAGE_GENERATED', merchantId, {
      storeId: store.id
    }, { success: true, productId, regenerated: true });

    return image;
  }

  // ─── Listings ───────────────────────────────────────────────

  /**
   * Create a listing (sellable instance with pricing/inventory).
   * Auto-creates a LAUNCH_DROP thread.
   */
  static async createListing(merchantId, storeId, { productId, priceCents, currency, inventoryOnHand }) {
    if (priceCents === undefined || priceCents < 0) {
      throw new BadRequestError('Price is required and must be >= 0');
    }
    if (inventoryOnHand === undefined || inventoryOnHand < 0) {
      throw new BadRequestError('Inventory is required and must be >= 0');
    }

    // Verify store + product ownership
    const store = await queryOne(
      'SELECT id, owner_merchant_id, name FROM stores WHERE id = $1',
      [storeId]
    );
    if (!store) throw new NotFoundError('Store');
    if (store.owner_merchant_id !== merchantId) {
      throw new ForbiddenError('You do not own this store');
    }

    const product = await queryOne(
      'SELECT id, title, store_id FROM products WHERE id = $1',
      [productId]
    );
    if (!product) throw new NotFoundError('Product');
    if (product.store_id !== storeId) {
      throw new BadRequestError('Product does not belong to this store');
    }

    const listing = await queryOne(
      `INSERT INTO listings (store_id, product_id, price_cents, currency, inventory_on_hand)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [storeId, productId, priceCents, currency || 'USD', inventoryOnHand]
    );

    // Auto-create LAUNCH_DROP thread
    const thread = await CommerceThreadService.createDropThread(
      merchantId, listing.id, storeId,
      `${product.title} — Now available at ${store.name}`,
      `${product.title} is now listed for $${(priceCents / 100).toFixed(2)} ${currency || 'USD'}. ${inventoryOnHand} in stock.`
    );

    await ActivityService.emit('LISTING_DROPPED', merchantId, {
      storeId, listingId: listing.id, threadId: thread.id
    });
    await ActivityService.emit('THREAD_CREATED', merchantId, {
      storeId, listingId: listing.id, threadId: thread.id
    });

    return { listing, thread };
  }

  /**
   * Get listing by ID with product, store, and primary image
   */
  static async findListingById(listingId) {
    const listing = await queryOne(
      `SELECT l.*,
              p.title as product_title, p.description as product_description,
              s.name as store_name, s.owner_merchant_id,
              (SELECT image_url FROM product_images WHERE product_id = l.product_id ORDER BY position ASC LIMIT 1) as primary_image_url
       FROM listings l
       JOIN products p ON l.product_id = p.id
       JOIN stores s ON l.store_id = s.id
       WHERE l.id = $1`,
      [listingId]
    );
    if (!listing) throw new NotFoundError('Listing');
    return listing;
  }

  /**
   * List all active listings
   */
  static async listActive({ limit = 50, offset = 0 } = {}) {
    return queryAll(
      `SELECT l.*,
              p.title as product_title, p.description as product_description,
              s.name as store_name, s.owner_merchant_id,
              (SELECT image_url FROM product_images WHERE product_id = l.product_id ORDER BY position ASC LIMIT 1) as primary_image_url
       FROM listings l
       JOIN products p ON l.product_id = p.id
       JOIN stores s ON l.store_id = s.id
       WHERE l.status = 'ACTIVE'
       ORDER BY l.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
  }

  /**
   * Update listing price (triggers patch notes)
   */
  static async updatePrice(merchantId, listingId, { newPriceCents, reason }) {
    if (!reason || reason.trim().length === 0) {
      throw new BadRequestError('Reason is required for price updates');
    }

    const listing = await this.findListingById(listingId);
    if (listing.owner_merchant_id !== merchantId) {
      throw new ForbiddenError('You do not own this listing');
    }

    const oldPrice = listing.price_cents;

    const updated = await queryOne(
      `UPDATE listings SET price_cents = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [listingId, newPriceCents]
    );

    // Record structured update
    await queryOne(
      `INSERT INTO store_updates (store_id, created_by_agent_id, update_type, field_name, old_value, new_value, reason, linked_listing_id)
       VALUES ($1, $2, 'PRICE_UPDATED', 'price_cents', $3, $4, $5, $6)`,
      [listing.store_id, merchantId, String(oldPrice), String(newPriceCents), reason, listingId]
    );

    // Create UPDATE post
    await CommerceThreadService.createUpdateThread(
      merchantId, listing.store_id, listingId,
      `Price update: ${listing.product_title}`,
      `Price changed from $${(oldPrice / 100).toFixed(2)} to $${(newPriceCents / 100).toFixed(2)}. Reason: ${reason}`
    );

    await ActivityService.emit('STORE_UPDATE_POSTED', merchantId, {
      storeId: listing.store_id, listingId
    });

    return updated;
  }
}

module.exports = CatalogService;
