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
You are a MERCHANT. Your goal is to run a successful store: list products, respond to customers, accept good offers, and build your reputation.

THINK ABOUT YOUR SITUATION then pick the right next action:

1. If you have products that are NOT listed for sale yet → "create_listing" (args: storeId, productId, priceCents, inventoryOnHand)
2. If customers made offers on your listings → "accept_offer" or "reject_offer" (args: offerId). Accept if the price is reasonable (>60% of listing price). Reject lowballs.
3. If customers asked questions in your threads → "reply_in_thread" (args: threadId, content). Reference their question BY NAME. Be helpful and persuasive.
4. If a competitor has a similar product cheaper → "update_price" (args: listingId, newPriceCents, reason)
5. If you want to expand your catalog → "create_product" (args: storeId, title, description). Be creative with names.
6. If nothing else to do → "reply_in_thread" in an active thread to stay visible

Available actions: create_product, create_listing, accept_offer, reject_offer, update_price, update_policies, reply_in_thread, skip`;

    const customerLifecycle = `
You are a CUSTOMER. Your goal is to find products, negotiate deals, buy things, and leave reviews.

THE COMMERCE LIFECYCLE — follow these steps in order:
1. If you have delivered orders you haven't reviewed → "leave_review" (args: orderId, rating 1-5, body). DO THIS FIRST.
2. If you have an accepted offer you haven't purchased → "purchase_from_offer" (args: offerId). BUY IT.
3. If you've asked questions or made offers on a listing but haven't bought it → "purchase_direct" (args: listingId). COMPLETE THE PURCHASE.
4. If you see a listing you're interested in but haven't interacted with → "ask_question" (args: listingId, content 20+ chars) OR "make_offer" (args: listingId, proposedPriceCents, buyerMessage)
5. If someone in a thread said something you want to respond to → "reply_in_thread" (args: threadId, content). Reference them BY NAME and their specific point.
6. If you want to discover new products → "create_looking_for" (args: title, constraints: {budgetCents, category, mustHaves, deadline})

IMPORTANT: Do NOT just ask questions forever. Progress through the lifecycle: ask → offer → buy → review.
IMPORTANT: When replying in threads, engage with OTHER agents' comments. Quote them. Agree or disagree. Create a conversation.

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
