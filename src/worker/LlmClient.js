/**
 * LLM Client
 * Provider-agnostic text inference with structured JSON output.
 * Switches on config.llm.provider.
 * 
 * Proxy-compatible: tries response_format first, falls back to raw text parsing
 * if the proxy doesn't support it.
 */

const config = require('../config');

const MAX_RETRIES = 2;
const TIMEOUT_MS = 30000;

// Key pool rotation state
let _llmKeyIndex = 0;

function _getNextLlmKey() {
  const keys = config.llm.apiKeys;
  if (!keys || keys.length === 0) return config.llm.apiKey;
  if (keys.length === 1) return keys[0];
  const key = keys[_llmKeyIndex % keys.length];
  return key;
}

function _rotateLlmKey() {
  const keys = config.llm.apiKeys;
  if (keys && keys.length > 1) {
    _llmKeyIndex = (_llmKeyIndex + 1) % keys.length;
  }
}

class LlmClient {
  /**
   * Generate an action for an agent given world state
   */
  static async generateAction({ agent, worldState }) {
    const provider = config.llm.provider;

    switch (provider) {
      case 'openai':
        return this._generateOpenAI({ agent, worldState });
      case 'anthropic':
        return this._generateAnthropic({ agent, worldState });
      default:
        throw new Error(`Unsupported LLM provider: ${provider}`);
    }
  }

  /**
   * OpenAI provider — proxy-compatible
   * Tries with response_format first, falls back to raw text + JSON extraction
   */
  static async _generateOpenAI({ agent, worldState }) {
    const apiKey = _getNextLlmKey();
    if (!apiKey) {
      throw new Error('LLM_API_KEY not configured');
    }

    const OpenAI = require('openai');
    const clientOpts = { apiKey, timeout: TIMEOUT_MS };
    if (config.llm.baseUrl) clientOpts.baseURL = config.llm.baseUrl;
    const openai = new OpenAI(clientOpts);

    const systemPrompt = this._buildSystemPrompt(agent);
    const userPrompt = this._buildUserPrompt(agent, worldState);

    const baseMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Strategy 1: Try with response_format (structured JSON)
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const params = {
          model: config.llm.model,
          messages: baseMessages,
          temperature: 0.8,
          max_tokens: 1000
        };

        // First attempt tries response_format; subsequent attempts skip it
        if (attempt === 0) {
          params.response_format = { type: 'json_object' };
        }

        const response = await openai.chat.completions.create(params);

        const content = response.choices[0]?.message?.content;
        if (!content) throw new Error('Empty LLM response');

        // Extract JSON from response (handles both structured and raw text)
        const parsed = this._extractJSON(content);
        if (!parsed.actionType) throw new Error('Missing actionType in LLM response');

        return {
          actionType: parsed.actionType,
          args: parsed.args || {},
          rationale: parsed.rationale || ''
        };
      } catch (error) {
        lastError = error;
        // Rate limited (429) — rotate to next key and retry
        if (error.status === 429) {
          _rotateLlmKey();
          console.warn(`LLM rate limited, rotating to key #${_llmKeyIndex}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
        // If response_format caused the error, retry without it immediately
        if (attempt === 0 && error.message && (
          error.message.includes('response_format') ||
          error.message.includes('Unknown parameter') ||
          error.status === 400
        )) {
          continue; // retry without response_format
        }
        if (attempt < MAX_RETRIES) {
          await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
      }
    }

    throw lastError;
  }

  /**
   * Extract JSON from LLM response text
   * Handles: pure JSON, JSON in markdown code blocks, JSON embedded in text
   */
  static _extractJSON(text) {
    // Try direct parse first
    try {
      return JSON.parse(text);
    } catch (e) {
      // ignore
    }

    // Try extracting from markdown code block
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      try {
        return JSON.parse(codeBlockMatch[1].trim());
      } catch (e) {
        // ignore
      }
    }

    // Try finding JSON object in text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (e) {
        // ignore
      }
    }

    throw new Error(`Could not extract JSON from LLM response: ${text.substring(0, 200)}`);
  }

  /**
   * Anthropic provider (stub)
   */
  static async _generateAnthropic({ agent, worldState }) {
    throw new Error('Anthropic provider not yet implemented');
  }

  /**
   * Build the system prompt for agent behavior
   */
  static _buildSystemPrompt(agent) {
    const merchantActions = `
MERCHANT actions (in priority order):
1. "create_product" — launch a NEW product (args: storeId, title, description). DO THIS if you have fewer than 3 products.
2. "create_listing" — list an existing product for sale (args: storeId, productId, priceCents, inventoryOnHand). DO THIS after creating a product.
3. "accept_offer" / "reject_offer" — respond to pending offers (args: offerId)
4. "update_price" — change a listing price (args: listingId, newPriceCents, reason)
5. "update_policies" — change store policies (args: storeId, returnPolicyText, shippingPolicyText, reason)
6. "reply_in_thread" — respond to customer questions (args: threadId, content). ONLY do this if customers are asking YOU directly.`;

    const customerActions = `
CUSTOMER actions (in priority order):
1. "create_looking_for" — post what you're shopping for (args: title, constraints: {budgetCents, category, mustHaves, deadline})
2. "ask_question" — ask a merchant about their product (args: listingId, content). Content MUST be 20+ chars.
3. "make_offer" — propose a price to a merchant (args: listingId, proposedPriceCents, buyerMessage)
4. "purchase_direct" — buy a listing (args: listingId). Only works if you've asked a question or made an offer first.
5. "leave_review" — review a delivered order (args: orderId, rating 1-5, body)
6. "reply_in_thread" — continue a conversation (args: threadId, content). Use SPARINGLY — prefer new actions above.`;

    const role = agent.agent_type === 'MERCHANT'
      ? `You are an AI merchant agent in the Moltbook marketplace.\n${merchantActions}`
      : `You are an AI customer agent in the Moltbook marketplace.\n${customerActions}`;

    return `${role}

Your name is ${agent.name}. Stay in character.

RULES:
- Mix your actions: create new content AND reply to existing threads in roughly equal proportion.
- Aim for variety: questions, offers, looking-for posts, replies, reviews, product launches.
- Do NOT do the same action type twice in a row if you can help it.
- When creating products, be creative — invent new product names and descriptions that fit your store brand.
- When replying, add substance — reference specific products and prices.
- Always include all required args fields.

Respond with a JSON object: { "actionType": "...", "args": {...}, "rationale": "..." }
Respond with ONLY the JSON object, no other text.`;
  }

  /**
   * Build the user prompt with world state context
   */
  static _buildUserPrompt(agent, worldState) {
    // Trim world state to avoid token limits
    const trimmed = {
      activeListings: (worldState.activeListings || []).slice(0, 5),
      recentThreads: (worldState.recentThreads || []).slice(0, 5),
      pendingOffers: (worldState.pendingOffers || []).slice(0, 5),
      eligiblePurchasers: (worldState.eligiblePurchasers || []).slice(0, 5),
      unreviewedOrders: (worldState.unreviewedOrders || []).slice(0, 5)
    };

    return `Current world state:
${JSON.stringify(trimmed, null, 2)}

What action should ${agent.name} take next? Respond with JSON only.`;
  }
}

module.exports = LlmClient;
