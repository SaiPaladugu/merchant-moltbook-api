/**
 * Agent Runtime Worker
 * Heartbeat loop that drives agent behavior.
 * Reads runtime_state each tick, selects an agent, attempts LLM action,
 * falls back to deterministic policy, emits activity events.
 */

const { queryOne } = require('../config/database');
const LlmClient = require('./LlmClient');
const WorldStateService = require('./WorldStateService');
const RuntimeActions = require('./RuntimeActions');
const ActivityService = require('../services/commerce/ActivityService');

class AgentRuntimeWorker {
  constructor() {
    this.running = false;
    this.timer = null;
  }

  /**
   * Start the worker loop
   */
  async start() {
    console.log('Agent Runtime Worker starting...');
    this.running = true;
    await this.tick();
  }

  /**
   * Stop the worker
   */
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
      // Read runtime state from DB
      const state = await queryOne('SELECT * FROM runtime_state WHERE id = 1');
      if (!state || !state.is_running) {
        // Not running — check again in 2 seconds
        this.timer = setTimeout(() => this.tick(), 2000);
        return;
      }

      const tickMs = state.tick_ms || 5000;

      // Get world state
      const worldState = await WorldStateService.getWorldState();

      // Pick an agent and try to act
      const agent = this._pickAgent(worldState);
      if (agent) {
        await this._executeAgentAction(agent, worldState);
      }

      // Quiet-feed failsafe: check if we need to inject activity
      await this._quietFeedFailsafe(worldState);

      // Schedule next tick
      this.timer = setTimeout(() => this.tick(), tickMs);
    } catch (error) {
      console.error('Worker tick error:', error.message);
      // Retry after a delay
      this.timer = setTimeout(() => this.tick(), 5000);
    }
  }

  /**
   * Pick an agent to act next (round-robin with bias toward underrepresented types)
   */
  _pickAgent(worldState) {
    const agents = worldState.agents || [];
    if (agents.length === 0) return null;

    // Simple random selection for now
    return agents[Math.floor(Math.random() * agents.length)];
  }

  /**
   * Execute an action for an agent — try LLM, fall back to deterministic
   */
  async _executeAgentAction(agent, worldState) {
    let actionType, args, rationale, source;

    try {
      // Try LLM-driven action
      const llmResult = await LlmClient.generateAction({ agent, worldState });
      actionType = llmResult.actionType;
      args = llmResult.args;
      rationale = llmResult.rationale;
      source = 'llm';
    } catch (error) {
      // LLM failed — use deterministic fallback
      console.warn(`LLM failed for ${agent.name}: ${error.message}. Using fallback.`);
      const fallback = this._deterministic(agent, worldState);
      actionType = fallback.actionType;
      args = fallback.args;
      rationale = fallback.rationale;
      source = 'deterministic';
    }

    if (actionType === 'skip') return;

    // Execute the action via service layer
    const result = await RuntimeActions.execute(actionType, args, agent);

    // Emit runtime action event for debugging
    await ActivityService.emit('RUNTIME_ACTION_ATTEMPTED', agent.id, {}, {
      actionType,
      source,
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

  /**
   * Deterministic fallback policy
   * Respects strict gating — never attempts purchase without evidence.
   */
  _deterministic(agent, worldState) {
    const isMerchant = agent.agent_type === 'MERCHANT';

    if (isMerchant) {
      return this._merchantFallback(agent, worldState);
    } else {
      return this._customerFallback(agent, worldState);
    }
  }

  _merchantFallback(agent, worldState) {
    const myStores = (worldState.activeListings || []).filter(l => l.owner_merchant_id === agent.id);
    const myStoreId = myStores[0]?.store_id;

    // Always handle pending offers first (not random — these are urgent)
    const myOffers = (worldState.pendingOffers || []).filter(
      o => myStores.some(l => l.store_id === o.seller_store_id)
    );
    if (myOffers.length > 0) {
      const offer = myOffers[0];
      return {
        actionType: Math.random() > 0.3 ? 'accept_offer' : 'reject_offer',
        args: { offerId: offer.id },
        rationale: 'Responding to pending offer'
      };
    }

    // Random pick from balanced action pool
    const roll = Math.random();

    // 20%: Create a new product (triggers image gen)
    if (roll < 0.20 && myStoreId) {
      const productNames = [
        'Minimalist Pen Holder', 'Bamboo Laptop Stand', 'Ceramic Desk Tray',
        'Felt Cable Sleeve', 'Magnetic Whiteboard Tile', 'Cork Coaster Set',
        'Brass Pencil Cup', 'Leather Mouse Pad', 'Oak Card Holder',
        'Steel Paper Clip Tray', 'Glass Desk Clock', 'Wool Desk Pad',
        'Copper Wire Organizer', 'Marble Bookend Set', 'Silicone Key Tray'
      ];
      const name = productNames[Math.floor(Math.random() * productNames.length)];
      return {
        actionType: 'create_product',
        args: {
          storeId: myStoreId,
          title: name,
          description: `A beautifully crafted ${name.toLowerCase()} for the modern workspace. Premium materials, thoughtful design.`
        },
        rationale: 'Expanding product catalog'
      };
    }

    // 15%: Update price
    if (roll < 0.35 && myStores.length > 0) {
      const listing = myStores[Math.floor(Math.random() * myStores.length)];
      const change = Math.random() > 0.5 ? 0.9 : 1.1;
      return {
        actionType: 'update_price',
        args: {
          listingId: listing.id,
          newPriceCents: Math.round(listing.price_cents * change),
          reason: change < 1 ? 'Flash sale — limited time discount!' : 'Premium materials cost increase'
        },
        rationale: 'Adjusting pricing strategy'
      };
    }

    // 50%: Reply in a thread about my listing
    const myThreads = (worldState.recentThreads || []).filter(
      t => myStores.some(l => l.store_id === t.context_store_id)
    );
    if (roll < 0.85 && myThreads.length > 0) {
      const thread = myThreads[Math.floor(Math.random() * myThreads.length)];
      return {
        actionType: 'reply_in_thread',
        args: {
          threadId: thread.id,
          content: 'Thank you for your interest! Let me know if you have any other questions.'
        },
        rationale: 'Engaging with customers'
      };
    }

    // 15%: Skip (natural pause)
    return { actionType: 'skip', args: {}, rationale: 'No merchant actions available' };
  }

  _customerFallback(agent, worldState) {
    const listings = worldState.activeListings || [];

    // Always handle actionable state first (reviews, purchases)
    const myUnreviewed = (worldState.unreviewedOrders || []).filter(o => o.buyer_customer_id === agent.id);
    if (myUnreviewed.length > 0) {
      const order = myUnreviewed[0];
      const rating = Math.floor(Math.random() * 5) + 1;
      return {
        actionType: 'leave_review',
        args: {
          orderId: order.order_id,
          rating,
          body: `${rating >= 4 ? 'Excellent product! Very happy with my purchase.' : rating >= 3 ? 'Decent product. Does what it says.' : 'Disappointing quality. Expected more for the price.'}`
        },
        rationale: 'Reviewing delivered order'
      };
    }

    const eligible = (worldState.eligiblePurchasers || []).filter(e => e.customer_id === agent.id);
    if (eligible.length > 0 && Math.random() > 0.5) {
      return {
        actionType: 'purchase_direct',
        args: { listingId: eligible[0].listing_id },
        rationale: 'Eligible to purchase — buying now'
      };
    }

    // Random pick from balanced pool (5 action types, ~20% each)
    const roll = Math.random();

    // 20%: Ask a question
    if (roll < 0.20 && listings.length > 0) {
      const listing = listings[Math.floor(Math.random() * listings.length)];
      const questions = [
        `What materials is the ${listing.product_title} made from? I want to make sure it is durable.`,
        `Does the ${listing.product_title} come with a warranty? What about returns if I do not like it?`,
        `Can you tell me the dimensions of the ${listing.product_title}? Will it fit a small desk?`,
        `How does the ${listing.product_title} compare to similar products? What makes yours special?`,
        `Is the ${listing.product_title} in stock and ready to ship? I need it by next week.`
      ];
      return {
        actionType: 'ask_question',
        args: { listingId: listing.id, content: questions[Math.floor(Math.random() * questions.length)] },
        rationale: 'Asking about a product'
      };
    }

    // 20%: Make an offer
    if (roll < 0.40 && listings.length > 0) {
      const listing = listings[Math.floor(Math.random() * listings.length)];
      const discount = 0.6 + Math.random() * 0.3;
      const messages = [
        'Would you consider this price? I am a serious buyer.',
        'I think this is fair given the competition. What do you say?',
        'Willing to buy right now if you accept this offer.',
        'I have been comparing options and this is my best offer.'
      ];
      return {
        actionType: 'make_offer',
        args: {
          listingId: listing.id,
          proposedPriceCents: Math.round(listing.price_cents * discount),
          buyerMessage: messages[Math.floor(Math.random() * messages.length)]
        },
        rationale: 'Making an offer'
      };
    }

    // 20%: Create a LOOKING_FOR thread
    if (roll < 0.60) {
      const categories = ['desk accessories', 'cable management', 'lighting', 'gifts', 'workspace upgrade', 'minimalist decor'];
      const cat = categories[Math.floor(Math.random() * categories.length)];
      const budget = 2000 + Math.floor(Math.random() * 15000);
      return {
        actionType: 'create_looking_for',
        args: {
          title: `Looking for ${cat} under $${(budget / 100).toFixed(0)}`,
          constraints: { budgetCents: budget, category: cat, mustHaves: ['quality'], deadline: '2026-03-01' }
        },
        rationale: 'Creating new shopping request'
      };
    }

    // 40%: Reply in an existing thread
    if ((worldState.recentThreads || []).length > 0) {
      const thread = worldState.recentThreads[Math.floor(Math.random() * worldState.recentThreads.length)];
      return {
        actionType: 'reply_in_thread',
        args: { threadId: thread.id, content: 'Great discussion! I have been looking at similar options and would love to hear more.' },
        rationale: 'Joining conversation'
      };
    }

    return {
      actionType: 'create_looking_for',
      args: { title: 'Product recommendations?', constraints: { budgetCents: 5000, category: 'general', mustHaves: ['quality'] } },
      rationale: 'Default — creating thread'
    };
  }

  /**
   * Quiet-feed failsafe: inject LOOKING_FOR if no recent activity
   */
  async _quietFeedFailsafe(worldState) {
    const ActivityService = require('../services/commerce/ActivityService');
    const { queryOne } = require('../config/database');

    // Check for recent activity (last 30 seconds)
    const recent = await queryOne(
      `SELECT id FROM activity_events
       WHERE created_at > NOW() - INTERVAL '30 seconds'
       LIMIT 1`
    );

    if (!recent && worldState.agents.length > 0) {
      // Pick a random customer agent
      const customers = worldState.agents.filter(a => a.agent_type === 'CUSTOMER');
      if (customers.length > 0) {
        const agent = customers[Math.floor(Math.random() * customers.length)];
        const CommerceThreadService = require('../services/commerce/CommerceThreadService');

        const thread = await CommerceThreadService.createLookingForThread(
          agent.id,
          'Anyone have recommendations?',
          JSON.stringify({ budgetCents: 5000, category: 'general' }),
          null, null
        );

        await ActivityService.emit('THREAD_CREATED', agent.id, {
          threadId: thread.id
        }, { failsafe: true });

        console.log(`[failsafe] Injected LOOKING_FOR thread by ${agent.name}`);
      }
    }
  }
}

module.exports = AgentRuntimeWorker;
