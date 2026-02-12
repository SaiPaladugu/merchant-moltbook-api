/**
 * Agent Runtime Worker
 * Heartbeat loop that drives agent behavior.
 * Reads runtime_state each tick, selects an agent, attempts LLM action,
 * falls back to deterministic policy, emits activity events.
 *
 * PHILOSOPHY: The LLM has full creative freedom. The fallback only handles
 * mechanical lifecycle actions (list products, accept offers, purchase).
 * All creative content (names, replies, reviews) must come from the LLM.
 */

const { queryOne, queryAll } = require('../config/database');
const LlmClient = require('./LlmClient');
const WorldStateService = require('./WorldStateService');
const RuntimeActions = require('./RuntimeActions');
const ActivityService = require('../services/commerce/ActivityService');

class AgentRuntimeWorker {
  constructor() {
    this.running = false;
    this.timer = null;
  }

  async start() {
    console.log('Agent Runtime Worker starting...');
    this.running = true;
    await this.tick();
  }

  stop() {
    console.log('Agent Runtime Worker stopping...');
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Main tick — reads runtime_state, decides what to do
   */
  async tick() {
    if (!this.running) return;

    try {
      const state = await queryOne('SELECT * FROM runtime_state WHERE id = 1');
      if (!state || !state.is_running) {
        this.timer = setTimeout(() => this.tick(), 2000);
        return;
      }

      const tickMs = state.tick_ms || 5000;

      // Heartbeat
      await queryOne('UPDATE runtime_state SET updated_at = NOW() WHERE id = 1');

      const worldState = await WorldStateService.getWorldState();

      // Supply-side check (rate-limited, LLM-driven)
      const supplyHandled = await this._supplyCheck(worldState);

      if (!supplyHandled) {
        const agent = this._pickAgent(worldState);
        if (agent) {
          await this._executeAgentAction(agent, worldState);
        }
      }

      await this._quietFeedFailsafe(worldState);

      this.timer = setTimeout(() => this.tick(), tickMs);
    } catch (error) {
      console.error('Worker tick error:', error.message);
      this.timer = setTimeout(() => this.tick(), 5000);
    }
  }

  /**
   * Pick an agent — biased toward agents with pending lifecycle work
   */
  _pickAgent(worldState) {
    const agents = worldState.agents || [];
    if (agents.length === 0) return null;

    if (Math.random() < 0.5) {
      const unreviewedBuyers = (worldState.unreviewedOrders || []).map(o => o.buyer_customer_id);
      const pendingMerchants = [...new Set((worldState.pendingOffers || []).map(o => {
        const store = (worldState.activeListings || []).find(l => l.store_id === o.seller_store_id);
        return store?.owner_merchant_id;
      }).filter(Boolean))];
      const eligibleBuyers = (worldState.eligiblePurchasers || []).map(e => e.customer_id);

      const priorityIds = [...new Set([...unreviewedBuyers, ...pendingMerchants, ...eligibleBuyers])];
      const priorityAgents = agents.filter(a => priorityIds.includes(a.id));

      if (priorityAgents.length > 0) {
        return priorityAgents[Math.floor(Math.random() * priorityAgents.length)];
      }
    }

    return agents[Math.floor(Math.random() * agents.length)];
  }

  /**
   * Execute an action — LLM first, minimal fallback second
   */
  async _executeAgentAction(agent, worldState) {
    let actionType, args, rationale, source;

    const agentContext = await WorldStateService.getAgentContext(agent.id, agent.agent_type);

    try {
      const llmResult = await LlmClient.generateAction({ agent, worldState, agentContext });
      actionType = llmResult.actionType;
      args = llmResult.args;
      rationale = llmResult.rationale;
      source = 'llm';
    } catch (error) {
      console.warn(`LLM failed for ${agent.name}: ${error.message}. Using fallback.`);
      const fallback = this._deterministic(agent, worldState, agentContext);
      actionType = fallback.actionType;
      args = fallback.args;
      rationale = fallback.rationale;
      source = 'deterministic';
    }

    if (actionType === 'skip') return;

    const result = await RuntimeActions.execute(actionType, args, agent);

    await ActivityService.emit('RUNTIME_ACTION_ATTEMPTED', agent.id, {}, {
      actionType, source,
      success: result.success,
      error: result.error || null,
      rationale
    });

    if (result.success) {
      console.log(`[${source}] ${agent.name} (${agent.agent_type}): ${actionType}`);
    } else {
      console.warn(`[${source}] ${agent.name} (${agent.agent_type}): ${actionType} FAILED: ${result.error}`);
    }
  }

  _deterministic(agent, worldState, agentContext) {
    return agent.agent_type === 'MERCHANT'
      ? this._merchantFallback(agent, worldState, agentContext)
      : this._customerFallback(agent, worldState, agentContext);
  }

  // ─── Merchant Fallback ─────────────────────────────────
  // Only handles mechanical lifecycle actions. No creative content.
  // If only creative actions remain, skip and let the LLM try next tick.
  _merchantFallback(agent, worldState, agentContext) {
    const ctx = agentContext || {};

    // 1. List unlisted products (mechanical — just needs IDs + price)
    if (ctx.unlistedProducts?.length > 0) {
      const product = ctx.unlistedProducts[0];
      const price = 1999 + Math.floor(Math.random() * 8000);
      return {
        actionType: 'create_listing',
        args: {
          storeId: product.store_id,
          productId: product.id,
          priceCents: price,
          inventoryOnHand: 10 + Math.floor(Math.random() * 40)
        },
        rationale: `Listing "${product.title}" for sale`
      };
    }

    // 2. Respond to pending offers (mechanical — accept/reject based on ratio)
    if (ctx.myPendingOffers?.length > 0) {
      const offer = ctx.myPendingOffers[0];
      const listing = ctx.myListings?.find(l => l.id === offer.listing_id);
      const listingPrice = listing?.price_cents || 5000;
      const offerRatio = offer.proposed_price_cents / listingPrice;
      const accept = offerRatio >= 0.7 || (offerRatio >= 0.5 && Math.random() > 0.6);
      return {
        actionType: accept ? 'accept_offer' : 'reject_offer',
        args: { offerId: offer.id },
        rationale: accept
          ? `Accepting offer at ${Math.round(offerRatio * 100)}% of asking`
          : `Rejecting offer at ${Math.round(offerRatio * 100)}% of asking`
      };
    }

    // 3. Update price (mechanical — just math)
    if (Math.random() < 0.3 && ctx.myListings?.length > 0) {
      const listing = ctx.myListings[Math.floor(Math.random() * ctx.myListings.length)];
      const factor = 0.8 + Math.random() * 0.4; // 0.8x to 1.2x
      return {
        actionType: 'update_price',
        args: {
          listingId: listing.id,
          newPriceCents: Math.round(listing.price_cents * factor),
          reason: factor < 1 ? 'Adjusting to market demand' : 'Reflecting premium quality'
        },
        rationale: `Adjusting price on ${listing.product_title}`
      };
    }

    // Everything else requires creativity → skip, let LLM handle next tick
    return { actionType: 'skip', args: {}, rationale: 'Waiting for LLM to handle creative actions' };
  }

  // ─── Customer Fallback ─────────────────────────────────
  // Only handles mechanical lifecycle actions. No creative content.
  _customerFallback(agent, worldState, agentContext) {
    const ctx = agentContext || {};
    const listings = worldState.activeListings || [];

    // 1. Purchase from accepted offers (mechanical)
    if (ctx.acceptedOffers?.length > 0) {
      const offer = ctx.acceptedOffers[0];
      return {
        actionType: 'purchase_from_offer',
        args: { offerId: offer.id },
        rationale: `Buying ${offer.product_title} via accepted offer`
      };
    }

    // 2. Purchase listing with evidence (mechanical)
    if (ctx.canPurchase?.length > 0 && Math.random() < 0.4) {
      const pick = ctx.canPurchase[Math.floor(Math.random() * ctx.canPurchase.length)];
      return {
        actionType: 'purchase_direct',
        args: { listingId: pick.listing_id },
        rationale: `Purchasing ${pick.product_title}`
      };
    }

    // 3. Make offer (semi-mechanical — just needs a price number)
    if (Math.random() < 0.3 && listings.length > 0) {
      const listing = listings[Math.floor(Math.random() * listings.length)];
      const discount = 0.5 + Math.random() * 0.4;
      return {
        actionType: 'make_offer',
        args: {
          listingId: listing.id,
          proposedPriceCents: Math.round(listing.price_cents * discount),
          buyerMessage: `Interested in ${listing.product_title}. Would you consider this price?`
        },
        rationale: `Offering on ${listing.product_title}`
      };
    }

    // Reviews, replies, questions, looking-for all need creativity → skip
    return { actionType: 'skip', args: {}, rationale: 'Waiting for LLM to handle creative actions' };
  }

  // ─── Supply Check ──────────────────────────────────────
  // Ensures catalog growth. Rate-limited by image generation.
  // Uses LLM for product creation (no hardcoded names).
  async _supplyCheck(worldState) {
    // Only run 10% of ticks
    if (Math.random() > 0.10) return false;

    const merchants = (worldState.agents || []).filter(a => a.agent_type === 'MERCHANT');
    if (merchants.length === 0) return false;

    const merchant = merchants[Math.floor(Math.random() * merchants.length)];
    const ctx = await WorldStateService.getAgentContext(merchant.id, 'MERCHANT');
    const myStoreId = ctx.myStores?.[0]?.id;
    if (!myStoreId) return false;

    // Priority 1: List unlisted products
    if (ctx.unlistedProducts?.length > 0) {
      const product = ctx.unlistedProducts[0];
      const price = 1999 + Math.floor(Math.random() * 8000);
      const result = await RuntimeActions.execute('create_listing', {
        storeId: product.store_id,
        productId: product.id,
        priceCents: price,
        inventoryOnHand: 10 + Math.floor(Math.random() * 40)
      }, merchant);
      if (result.success) {
        await ActivityService.emit('RUNTIME_ACTION_ATTEMPTED', merchant.id, {}, {
          actionType: 'create_listing', source: 'supply_check', success: true,
          rationale: `Listing "${product.title}"`
        });
        console.log(`[supply] ${merchant.name}: listed "${product.title}"`);
        return true;
      }
    }

    // Priority 2: Update price (30% chance)
    if (Math.random() < 0.3 && ctx.myListings?.length > 0) {
      const listing = ctx.myListings[Math.floor(Math.random() * ctx.myListings.length)];
      const factor = 0.8 + Math.random() * 0.4;
      const result = await RuntimeActions.execute('update_price', {
        listingId: listing.id,
        newPriceCents: Math.round(listing.price_cents * factor),
        reason: factor < 1 ? 'Competitive price adjustment' : 'Premium quality pricing'
      }, merchant);
      if (result.success) {
        await ActivityService.emit('RUNTIME_ACTION_ATTEMPTED', merchant.id, {}, {
          actionType: 'update_price', source: 'supply_check', success: true
        });
        console.log(`[supply] ${merchant.name}: price update on "${listing.product_title}"`);
        return true;
      }
    }

    // Priority 3: Create new product via LLM
    // Rate-limit: only if the merchant's most recent product already has an image
    const lastProductWithoutImage = await queryOne(
      `SELECT p.id FROM products p
       WHERE p.store_id = $1
         AND NOT EXISTS (SELECT 1 FROM product_images pi WHERE pi.product_id = p.id)
       LIMIT 1`,
      [myStoreId]
    );

    // If there's already a product waiting for an image, don't create another
    if (lastProductWithoutImage) {
      return false;
    }

    // Use the LLM to generate a creative product name + description
    try {
      const agentContext = ctx;
      const llmResult = await LlmClient.generateAction({
        agent: merchant,
        worldState,
        agentContext,
        forceAction: 'create_product' // hint to the LLM
      });

      if (llmResult.actionType === 'create_product' && llmResult.args?.title) {
        const result = await RuntimeActions.execute('create_product', {
          storeId: myStoreId,
          title: llmResult.args.title,
          description: llmResult.args.description || ''
        }, merchant);

        if (result.success) {
          await ActivityService.emit('RUNTIME_ACTION_ATTEMPTED', merchant.id, {}, {
            actionType: 'create_product', source: 'supply_check_llm', success: true,
            rationale: llmResult.rationale || `Created "${llmResult.args.title}"`
          });
          console.log(`[supply-llm] ${merchant.name}: created "${llmResult.args.title}"`);
          return true;
        }
      }
    } catch (err) {
      // LLM failed for supply check — that's OK, skip this tick
      console.warn(`[supply] LLM product generation failed: ${err.message}`);
    }

    return false;
  }

  /**
   * Quiet-feed failsafe — 5 minute silence threshold
   */
  async _quietFeedFailsafe(worldState) {
    const { queryOne: qo } = require('../config/database');

    const recent = await qo(
      `SELECT id FROM activity_events
       WHERE created_at > NOW() - INTERVAL '5 minutes'
       LIMIT 1`
    );

    if (recent) return;
    if (worldState.agents.length === 0) return;

    // Nudge a random agent through the normal LLM path
    const agent = worldState.agents[Math.floor(Math.random() * worldState.agents.length)];
    try {
      await this._executeAgentAction(agent, worldState);
    } catch (err) {
      console.warn(`[failsafe] Nudge failed: ${err.message}`);
    }
  }
}

module.exports = AgentRuntimeWorker;
