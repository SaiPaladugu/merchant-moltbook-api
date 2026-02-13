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
  static async generateAction({ agent, worldState, agentContext, forceAction }) {
    const provider = config.llm.provider;

    switch (provider) {
      case 'openai':
        return this._generateOpenAI({ agent, worldState, agentContext, forceAction });
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
  static async _generateOpenAI({ agent, worldState, agentContext, forceAction }) {
    const apiKey = _getNextLlmKey();
    if (!apiKey) {
      throw new Error('LLM_API_KEY not configured');
    }

    const OpenAI = require('openai');
    const clientOpts = { apiKey, timeout: TIMEOUT_MS };
    if (config.llm.baseUrl) clientOpts.baseURL = config.llm.baseUrl;
    const openai = new OpenAI(clientOpts);

    const systemPrompt = this._buildSystemPrompt(agent);
    const userPrompt = this._buildUserPrompt(agent, worldState, agentContext, forceAction);

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
    const merchantPrompt = `You are ${agent.name}, a merchant in a competitive marketplace.
${agent.description || ''}

You have COMPLETE CREATIVE FREEDOM. Your personality, brand, and aesthetic should come through in EVERYTHING — your store name, product names, descriptions, pricing, and how you talk to customers.

AVAILABLE ACTIONS (pick ONE):

"create_store" — Create YOUR store. Choose a name, tagline, and brand voice that reflect YOUR unique identity. You MUST do this before you can sell anything.
  args: { name: "<your store name>", tagline: "<your motto>", brandVoice: "<your style>", returnPolicyText: "<your policy>", shippingPolicyText: "<your policy>" }

"create_product" — Invent a product that fits YOUR brand. Be wildly creative and DIFFERENT from what's already on the marketplace. NO generic names. NO copying other stores' themes.
  args: { storeId: "<your store ID>", title: "<unique creative name>", description: "<vivid detailed description>" }

"create_listing" — List an unlisted product for sale. Set your own price.
  args: { storeId, productId, priceCents: <integer>, inventoryOnHand: <integer> }

"accept_offer" / "reject_offer" — Respond to offers with a personal message. A sale at 50-60% of asking is better than no sale — only reject truly insulting lowballs (below 30%). Write a response in your brand voice.
  args: { offerId: "<ID from PENDING OFFERS>", message: "<your response to the buyer>" }

"update_price" — Adjust pricing. Explain why.
  args: { listingId: "<ID from your listings>", newPriceCents: <integer>, reason: "<your reasoning>" }

"promote_listing" — Run an ad! Discount an underperforming listing to boost visibility. Great for listings with few offers or orders. The promoted listing gets highlighted in the marketplace with a special badge and appears at the top.
  args: { listingId: "<ID from your listings>", promoPriceCents: <integer — must be less than current price> }

"reply_in_thread" — Reply to customer questions and comments on your listings. Address them BY NAME. If multiple customers are talking, join the conversation — answer questions, clarify details, thank people for interest. Check recentComments to see what was asked.
  args: { threadId: "<ID from threads>", content: "<your response to the customer>" }

"skip" — Do nothing this turn.

RULES:
- If you don't have a store yet, your FIRST action MUST be "create_store".
- ALWAYS use real IDs from YOUR SITUATION. NEVER use placeholders.
- Look at what other stores sell — create something DIFFERENT. Differentiate yourself.
- Your brand identity matters. Stay consistent with who you are.`;

    const customerPrompt = `You are ${agent.name}, a customer shopping in a marketplace.
${agent.description || ''}

You have COMPLETE CREATIVE FREEDOM. Your personality should drive every decision — what you buy, how you negotiate, what you say in reviews.

AVAILABLE ACTIONS (pick ONE):

"leave_review" — Write an HONEST review. Rate 1-5. Be HARSH when deserved. A realistic marketplace has plenty of 1-2 star reviews. If the price was too high, say so. If the description overpromised, call it out. If you're disappointed, give it 1 star. Channel YOUR personality — skeptics should be brutal, bargain hunters should complain about price.
  args: { orderId: "<ID from ORDERS NEEDING REVIEW>", rating: <1-5>, body: "<your honest review>" }

"purchase_from_offer" — Complete a purchase from an accepted offer.
  args: { offerId: "<ID from ACCEPTED OFFERS>" }

"purchase_direct" — Buy a listing you've already interacted with.
  args: { listingId: "<ID from LISTINGS YOU CAN BUY>" }

"ask_question" — Post on a listing's discussion thread. You can either:
  (a) Ask a NEW question about the product (don't start with @, just ask your question)
  (b) Reply to someone by starting with @theirname (check recentComments for who said what)
  Mix it up — sometimes start fresh conversations, sometimes join existing ones. Minimum 20 characters.
  args: { listingId: "<ID from active listings>", content: "<your question or reply>" }

"make_offer" — Negotiate on price. Explain your reasoning in the message.
  args: { listingId: "<ID from active listings>", proposedPriceCents: <integer>, buyerMessage: "<your pitch>" }

"reply_in_thread" — Continue an ongoing conversation. Respond directly to what someone said — agree, disagree, add your experience, ask a follow-up. Reference people BY NAME. Look at recentComments to see what was said.
  args: { threadId: "<ID from threads>", content: "<your reply to the conversation>" }

"create_looking_for" — Post what you're looking for. Only when existing listings genuinely don't have what you want.
  args: { title: "<what you want>", constraints: { budgetCents: <int>, category: "<type>", mustHaves: ["<feature>", ...] } }

"skip" — Do nothing this turn.

LIFECYCLE: Review orders first → buy accepted offers → then explore/ask/offer/buy/reply.
RULES:
- ALWAYS use real IDs from YOUR SITUATION. NEVER make up IDs.
- Write reviews that reflect YOUR actual opinion. Not everything is 5 stars.
- CONVERSATIONS MATTER: If a thread has recentComments, sometimes reply (start with @name) and sometimes ask a fresh question. A mix of both feels natural — like a real marketplace where people start new conversations AND respond to existing ones.
- When replying, reference people by name: "@skeptic_sam I agree!" or "Good point @deal_hunter_dana, but..."
- When asking a new question, don't start with @. Just ask about the product directly.`;

    const role = agent.agent_type === 'MERCHANT' ? merchantPrompt : customerPrompt;

    return `${role}

Respond with a JSON object: { "actionType": "...", "args": {...}, "rationale": "..." }
Respond with ONLY the JSON object, no other text.`;
  }

  /**
   * Build the user prompt with world state context
   */
  static _buildUserPrompt(agent, worldState, agentContext, forceAction) {
    const trimmed = {
      activeListings: (worldState.activeListings || []).slice(0, 8),
      recentThreads: (worldState.recentThreads || []).slice(0, 5),
      pendingOffers: (worldState.pendingOffers || []).slice(0, 5)
    };

    let situation = '';
    if (agentContext) {
      situation = `\nYOUR CURRENT SITUATION:\n${agentContext.summary}\n`;

      if (agent.agent_type === 'MERCHANT') {
        if (agentContext.myStores?.length > 0) {
          situation += `\nYOUR STORE: ${JSON.stringify(agentContext.myStores[0])}\n`;
        } else {
          situation += `\nYOU DO NOT HAVE A STORE YET. You MUST use "create_store" as your first action. Create a store that reflects your unique personality and brand.\n`;
        }
        if (agentContext.unlistedProducts?.length > 0) {
          situation += `\nUNLISTED PRODUCTS (list these for sale!):\n${JSON.stringify(agentContext.unlistedProducts.slice(0, 3), null, 2)}\n`;
        }
        if (agentContext.myPendingOffers?.length > 0) {
          situation += `\nPENDING OFFERS (respond to these!):\n${JSON.stringify(agentContext.myPendingOffers.slice(0, 3), null, 2)}\n`;
        }
        if (agentContext.myListings?.length > 0) {
          situation += `\nYOUR ACTIVE LISTINGS:\n${JSON.stringify(agentContext.myListings.slice(0, 5), null, 2)}\n`;
        }
      }

      if (agent.agent_type === 'CUSTOMER') {
        if (agentContext.myUnreviewedOrders?.length > 0) {
          situation += `\nORDERS NEEDING REVIEW (do this FIRST):\n${JSON.stringify(agentContext.myUnreviewedOrders, null, 2)}\n`;
        }
        if (agentContext.acceptedOffers?.length > 0) {
          situation += `\nACCEPTED OFFERS (buy these!):\n${JSON.stringify(agentContext.acceptedOffers, null, 2)}\n`;
        }
        if (agentContext.canPurchase?.length > 0) {
          situation += `\nLISTINGS YOU CAN BUY:\n${JSON.stringify(agentContext.canPurchase.slice(0, 3), null, 2)}\n`;
        }
      }
    }

    let instruction = `What should ${agent.name} do next? Pick the action that advances your goals.`;

    // Supply check can force a specific action
    if (forceAction === 'create_product') {
      instruction = `${agent.name}: Your store needs a NEW PRODUCT. Look at the existing marketplace listings — create something COMPLETELY DIFFERENT from what's already there. Invent a product that fits YOUR brand identity. Use "create_product" with your store ID, a creative title, and a vivid description. NO space/cosmic themes unless that's genuinely your brand.`;
    }
    if (forceAction === 'create_store') {
      instruction = `${agent.name}: You need to create YOUR STORE first before you can sell anything. Use "create_store" with a creative name, tagline, and brand voice that reflect your unique personality. Make it distinctly YOURS.`;
    }

    return `${situation}
MARKETPLACE STATE:
${JSON.stringify(trimmed, null, 2)}

${instruction} Respond with JSON only.`;
  }
}

module.exports = LlmClient;
