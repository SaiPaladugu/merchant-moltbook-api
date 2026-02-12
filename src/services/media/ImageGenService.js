/**
 * Image Generation Service
 * Provider-agnostic image generation with GCS-backed storage (local fallback).
 * Switches on config.image.provider.
 * 
 * Proxy-compatible: tries URL format first (download), falls back to b64_json,
 * then falls back to no response_format at all (for proxies that don't support it).
 * 
 * Storage:
 *  - Production (GCS_BUCKET set): uploads to GCS, serves via /static proxy route
 *  - Development: saves to local filesystem, serves via express.static
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');

// Lazy-init GCS client (only when bucket is configured)
let _gcsClient = null;
let _gcsBucket = null;

function _getGcsBucket() {
  if (!config.image.gcsBucket) return null;
  if (!_gcsClient) {
    const { Storage } = require('@google-cloud/storage');
    _gcsClient = new Storage();
    _gcsBucket = _gcsClient.bucket(config.image.gcsBucket);
  }
  return _gcsBucket;
}

// Key pool rotation state for image generation
let _imageKeyIndex = 0;

function _getNextImageKey() {
  const keys = config.image.apiKeys;
  if (!keys || keys.length === 0) return config.image.apiKey;
  if (keys.length === 1) return keys[0];
  return keys[_imageKeyIndex % keys.length];
}

function _rotateImageKey() {
  const keys = config.image.apiKeys;
  if (keys && keys.length > 1) {
    _imageKeyIndex = (_imageKeyIndex + 1) % keys.length;
  }
}

class ImageGenService {
  /**
   * Generate a product image
   */
  static async generateProductImage({ prompt, storeId, productId }) {
    const provider = config.image.provider;

    switch (provider) {
      case 'openai':
        return this._generateOpenAI({ prompt, productId });
      default:
        throw new Error(`Unsupported image provider: ${provider}`);
    }
  }

  /**
   * Build an image prompt from product + store context
   */
  static buildPrompt(product, store) {
    const parts = [
      `Product photo of: ${product.title}`,
      product.description ? `Description: ${product.description}` : null,
      store.brand_voice ? `Brand style: ${store.brand_voice}` : null,
      'Professional product photography, clean background, high quality'
    ].filter(Boolean);

    return parts.join('. ');
  }

  /**
   * OpenAI DALL-E provider — proxy-compatible
   * Tries strategies in order: URL mode → b64_json mode → no response_format
   */
  static async _generateOpenAI({ prompt, productId }) {
    if (!config.image.apiKey) {
      throw new Error('IMAGE_API_KEY not configured');
    }

    const apiKey = _getNextImageKey();

    const OpenAI = require('openai');
    const clientOpts = { apiKey };
    if (config.image.baseUrl) clientOpts.baseURL = config.image.baseUrl;
    const openai = new OpenAI(clientOpts);

    const baseParams = {
      model: config.image.model,
      prompt: prompt.substring(0, 4000),
      n: 1,
      size: config.image.size
    };

    // Strategy 1: URL format (most proxy-compatible)
    try {
      const response = await openai.images.generate(baseParams);
      const url = response.data[0]?.url;
      if (url) {
        const buffer = await this._downloadImage(url);
        const imageUrl = await this._saveImage(buffer, productId);
        return { imageUrl };
      }
      // If no URL, try b64
      const b64 = response.data[0]?.b64_json;
      if (b64) {
        const buffer = Buffer.from(b64, 'base64');
        const imageUrl = await this._saveImage(buffer, productId);
        return { imageUrl };
      }
      throw new Error('No image data in response');
    } catch (firstError) {
      // Rotate key on rate limit before trying next strategy
      if (firstError.status === 429) {
        _rotateImageKey();
        console.warn(`Image gen rate limited, rotating to key #${_imageKeyIndex}`);
      }
      // Strategy 2: Explicit b64_json format
      try {
        const response = await openai.images.generate({
          ...baseParams,
          response_format: 'b64_json'
        });
        const b64 = response.data[0]?.b64_json;
        if (!b64) throw new Error('No b64_json in response');
        const buffer = Buffer.from(b64, 'base64');
        const imageUrl = await this._saveImage(buffer, productId);
        return { imageUrl };
      } catch (secondError) {
        // Strategy 3: Explicit URL format
        try {
          const response = await openai.images.generate({
            ...baseParams,
            response_format: 'url'
          });
          const url = response.data[0]?.url;
          if (!url) throw new Error('No URL in response');
          const buffer = await this._downloadImage(url);
          const imageUrl = await this._saveImage(buffer, productId);
          return { imageUrl };
        } catch (thirdError) {
          // All strategies failed — throw the original error with context
          throw new Error(
            `Image generation failed (all strategies). ` +
            `Strategy 1: ${firstError.message}. ` +
            `Strategy 2: ${secondError.message}. ` +
            `Strategy 3: ${thirdError.message}`
          );
        }
      }
    }
  }

  /**
   * Download image from URL
   */
  static async _downloadImage(url) {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Enforce max file size
    const maxBytes = config.image.maxFileSizeMb * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new Error(`Downloaded image exceeds max size of ${config.image.maxFileSizeMb}MB`);
    }

    return buffer;
  }

  /**
   * Save image buffer — GCS in production, local filesystem in dev.
   * Always returns a URL path like /static/products/{productId}/{filename}
   * that works with the API's static proxy route.
   */
  static async _saveImage(buffer, productId) {
    // Enforce max file size
    const maxBytes = config.image.maxFileSizeMb * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new Error(`Image exceeds max size of ${config.image.maxFileSizeMb}MB`);
    }

    const filename = `${Date.now()}.png`;
    const gcsKey = `products/${productId}/${filename}`;
    const bucket = _getGcsBucket();

    if (bucket) {
      // Upload to GCS (production path)
      const file = bucket.file(gcsKey);
      await file.save(buffer, {
        contentType: 'image/png',
        metadata: { cacheControl: 'public, max-age=3600' }
      });
      console.log(`  Image uploaded to GCS: gs://${config.image.gcsBucket}/${gcsKey}`);
    }

    // Also save locally (worker reference / dev fallback)
    try {
      const baseDir = path.resolve(config.image.outputDir);
      const productDir = path.join(baseDir, 'products', productId);
      fs.mkdirSync(productDir, { recursive: true });
      fs.writeFileSync(path.join(productDir, filename), buffer);
    } catch (localErr) {
      // In Cloud Run the filesystem is ephemeral — local save is best-effort
      if (bucket) {
        console.warn(`Local save failed (GCS is primary): ${localErr.message}`);
      } else {
        throw localErr; // No GCS and no local = real failure
      }
    }

    // Return consistent URL path — API serves via /static proxy
    return `/static/${gcsKey}`;
  }

  /**
   * Stream an image from GCS (used by the API proxy route).
   * Returns { stream, contentType } or null if not found / GCS not configured.
   */
  static async streamFromGcs(gcsKey) {
    const bucket = _getGcsBucket();
    if (!bucket) return null;

    const file = bucket.file(gcsKey);
    const [exists] = await file.exists();
    if (!exists) return null;

    return {
      stream: file.createReadStream(),
      contentType: 'image/png'
    };
  }

  /**
   * Generate a signed URL for a GCS image (bypasses IAP).
   * Valid for 1 hour by default. Returns null if GCS is not configured or file doesn't exist.
   *
   * @param {string} gcsKey - e.g. "products/{productId}/{timestamp}.png"
   * @param {number} expiresInMs - URL lifetime in milliseconds (default: 1 hour)
   * @returns {Promise<string|null>} signed URL or null
   */
  static async getSignedUrl(gcsKey, expiresInMs = 604800000) {
    const bucket = _getGcsBucket();
    if (!bucket) return null;

    const file = bucket.file(gcsKey);
    const [exists] = await file.exists();
    if (!exists) return null;

    const [url] = await file.getSignedUrl({
      action: 'read',
      expires: Date.now() + expiresInMs
    });

    return url;
  }

  /**
   * Convert a DB image path (/static/products/...) to a signed URL.
   * Returns the original path unchanged if GCS is not configured or signing fails.
   */
  static async resolveImageUrl(dbPath) {
    if (!dbPath) return null;
    if (!config.image.gcsBucket) return dbPath; // local dev — return as-is

    try {
      const gcsKey = dbPath.replace('/static/', '');
      const signedUrl = await this.getSignedUrl(gcsKey);
      return signedUrl || dbPath;
    } catch (err) {
      console.warn(`Signed URL failed for ${dbPath}: ${err.message}`);
      return dbPath; // fallback to relative path
    }
  }
}

module.exports = ImageGenService;
