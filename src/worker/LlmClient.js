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
  static async generateAction({ agent, worldState, agentContext }) {
    const provider = config.llm.provider;

    switch (provider) {
      case 'openai':
        return this._generateOpenAI({ agent, worldState, agentContext });
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
  static async _generateOpenAI({ agent, worldState, agentContext }) {
    const apiKey = _getNextLlmKey();
    if (!apiKey) {
      throw new Error('LLM_API_KEY not configured');
    }

    const OpenAI = require('openai');
    const clientOpts = { apiKey, timeout: TIMEOUT_MS };
    if (config.llm.baseUrl) clientOpts.baseURL = config.llm.baseUrl;
    const openai = new OpenAI(clientOpts);

    const systemPrompt = this._buildSystemPrompt(agent);
    const userPrompt = this._buildUserPrompt(agent, worldState, agentContext);

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
    const merchantLifecycle = `
You are a MERCHANT in a competitive marketplace. Your goal: expand your catalog, price competitively, negotiate with customers, and build reputation.

PICK ONE ACTION. Think about your situation and choose what advances your business most:

HIGH PRIORITY (do these first):
- "create_listing" if you have unlisted products (args: storeId, productId, priceCents, inventoryOnHand)
- "accept_offer" or "reject_offer" if customers made offers (args: offerId). Be realistic: accept offers >= 70% of asking price. REJECT lowball offers firmly — don't accept everything.

REGULAR ACTIONS (pick based on what helps most):
- "create_product" — EXPAND YOUR CATALOG. Invent a creative new product. Use a unique name. (args: storeId, title, description) [~25% of actions should be this]
- "update_price" — adjust pricing to stay competitive or reflect demand (args: listingId, newPriceCents, reason) [~15% of actions]
- "reply_in_thread" — respond to customer questions. Be specific and helpful, reference the customer by name. (args: threadId, content) [~20% of actions]

Available actions: create_product, create_listing, accept_offer, reject_offer, update_price, update_policies, reply_in_thread, skip

ACTION BALANCE: Avoid doing the same action repeatedly. Alternate between expanding catalog, adjusting prices, and engaging with customers.`;

    const customerLifecycle = `
You are a CUSTOMER in a marketplace. Your goal: discover products, negotiate deals, buy things, and leave honest reviews.

PICK ONE ACTION. Follow the commerce lifecycle:

MANDATORY (always do these first):
- "leave_review" if you have delivered orders without reviews (args: orderId, rating 1-5, body). Give HONEST ratings — not everything is 5 stars. [ALWAYS do this first]
- "purchase_from_offer" if you have accepted offers (args: offerId). [ALWAYS buy accepted offers]

CORE ACTIONS (the commerce loop — this is what you should mainly do):
- "ask_question" — explore a listing you haven't interacted with yet (args: listingId, content 20+ chars) [~25% of actions]
- "make_offer" — negotiate on price (args: listingId, proposedPriceCents, buyerMessage). Offer 50-90% of asking. [~25% of actions]
- "purchase_direct" — buy a listing you've already interacted with (args: listingId) [~15% of actions]
- "reply_in_thread" — engage in conversation. Reference other people BY NAME. Agree/disagree. (args: threadId, content) [~15% of actions]

RARE:
- "create_looking_for" — only when you genuinely can't find what you want. DO NOT spam these. [~5% of actions at most]

IMPORTANT RULES:
- Progress through the lifecycle: ask → offer → buy → review. Don't get stuck on one step.
- When replying, engage with OTHER agents' specific points. Don't be generic.
- DO NOT create looking_for posts frequently. Focus on buying from existing listings.

Available actions: ask_question, make_offer, purchase_direct, purchase_from_offer, leave_review, create_looking_for, reply_in_thread, skip`;

    const role = agent.agent_type === 'MERCHANT'
      ? `${merchantLifecycle}`
      : `${customerLifecycle}`;

    return `${role}

Your name is ${agent.name}. ${agent.description || ''}
Stay in character. Your personality should come through in everything you do.

Respond with a JSON object: { "actionType": "...", "args": {...}, "rationale": "..." }
Respond with ONLY the JSON object, no other text.`;
  }

  /**
   * Build the user prompt with world state context
   */
  static _buildUserPrompt(agent, worldState, agentContext) {
    // Trim world state to avoid token limits
    const trimmed = {
      activeListings: (worldState.activeListings || []).slice(0, 8),
      recentThreads: (worldState.recentThreads || []).slice(0, 5),
      pendingOffers: (worldState.pendingOffers || []).slice(0, 5)
    };

    // Build personal situation summary
    let situation = '';
    if (agentContext) {
      situation = `\nYOUR CURRENT SITUATION:\n${agentContext.summary}\n`;

      if (agent.agent_type === 'MERCHANT' && agentContext.unlistedProducts?.length > 0) {
        situation += `\nUNLISTED PRODUCTS (need to be listed for sale):\n${JSON.stringify(agentContext.unlistedProducts.slice(0, 3), null, 2)}\n`;
      }
      if (agent.agent_type === 'MERCHANT' && agentContext.myPendingOffers?.length > 0) {
        situation += `\nPENDING OFFERS (customers waiting for your response):\n${JSON.stringify(agentContext.myPendingOffers.slice(0, 3), null, 2)}\n`;
      }
      if (agent.agent_type === 'CUSTOMER' && agentContext.myUnreviewedOrders?.length > 0) {
        situation += `\nORDERS NEEDING REVIEW:\n${JSON.stringify(agentContext.myUnreviewedOrders, null, 2)}\n`;
      }
      if (agent.agent_type === 'CUSTOMER' && agentContext.acceptedOffers?.length > 0) {
        situation += `\nACCEPTED OFFERS (ready to purchase!):\n${JSON.stringify(agentContext.acceptedOffers, null, 2)}\n`;
      }
      if (agent.agent_type === 'CUSTOMER' && agentContext.canPurchase?.length > 0) {
        situation += `\nLISTINGS YOU CAN BUY (you already have gating evidence):\n${JSON.stringify(agentContext.canPurchase.slice(0, 3), null, 2)}\n`;
      }
    }

    return `${situation}
MARKETPLACE STATE:
${JSON.stringify(trimmed, null, 2)}

What should ${agent.name} do next? Pick the action that advances your goals. Respond with JSON only.`;
  }
}

module.exports = LlmClient;
