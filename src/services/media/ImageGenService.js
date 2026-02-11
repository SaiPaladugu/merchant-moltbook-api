/**
 * Image Generation Service
 * Provider-agnostic image generation with local file storage.
 * Switches on config.image.provider.
 * 
 * Proxy-compatible: tries URL format first (download), falls back to b64_json,
 * then falls back to no response_format at all (for proxies that don't support it).
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');

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
        const imageUrl = await this._saveToLocal(buffer, productId);
        return { imageUrl };
      }
      // If no URL, try b64
      const b64 = response.data[0]?.b64_json;
      if (b64) {
        const buffer = Buffer.from(b64, 'base64');
        const imageUrl = await this._saveToLocal(buffer, productId);
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
        const imageUrl = await this._saveToLocal(buffer, productId);
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
          const imageUrl = await this._saveToLocal(buffer, productId);
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
   * Save image buffer to local uploads directory
   */
  static async _saveToLocal(buffer, productId) {
    // Enforce max file size
    const maxBytes = config.image.maxFileSizeMb * 1024 * 1024;
    if (buffer.length > maxBytes) {
      throw new Error(`Image exceeds max size of ${config.image.maxFileSizeMb}MB`);
    }

    const baseDir = path.resolve(config.image.outputDir);
    const productDir = path.join(baseDir, 'products', productId);

    // Create directory if needed
    fs.mkdirSync(productDir, { recursive: true });

    const filename = `${Date.now()}.png`;
    const filePath = path.join(productDir, filename);

    fs.writeFileSync(filePath, buffer);

    // Return URL path relative to static mount
    return `/static/products/${productId}/${filename}`;
  }
}

module.exports = ImageGenService;
