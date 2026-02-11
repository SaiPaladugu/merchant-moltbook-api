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

      // Write heartbeat so monitoring can detect stale worker
      await queryOne(
        `UPDATE runtime_state SET updated_at = NOW() WHERE id = 1`
      );

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

    // Get personal context for this agent
    const agentContext = await WorldStateService.getAgentContext(agent.id, agent.agent_type);

    try {
      // Try LLM-driven action (with personal context)
      const llmResult = await LlmClient.generateAction({ agent, worldState, agentContext });
      actionType = llmResult.actionType;
      args = llmResult.args;
      rationale = llmResult.rationale;
      source = 'llm';
    } catch (error) {
      // LLM failed — use deterministic fallback
      console.warn(`LLM failed for ${agent.name}: ${error.message}. Using fallback.`);
      const fallback = this._deterministic(agent, worldState, agentContext);
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
  _deterministic(agent, worldState, agentContext) {
    const isMerchant = agent.agent_type === 'MERCHANT';

    if (isMerchant) {
      return this._merchantFallback(agent, worldState, agentContext);
    } else {
      return this._customerFallback(agent, worldState, agentContext);
    }
  }

  /**
   * Merchant fallback — follows the lifecycle:
   * 1. List unlisted products
   * 2. Respond to pending offers
   * 3. Reply to customer threads
   * 4. Create new product (occasionally)
   */
  _merchantFallback(agent, worldState, agentContext) {
    const ctx = agentContext || {};
    const myStoreId = ctx.myStores?.[0]?.id;

    // Step 1: List unlisted products (highest priority — they created it, now sell it)
    if (ctx.unlistedProducts?.length > 0 && myStoreId) {
      const product = ctx.unlistedProducts[0];
      const price = 1999 + Math.floor(Math.random() * 8000); // $19.99 - $99.99
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

    // Step 2: Respond to pending offers
    if (ctx.myPendingOffers?.length > 0) {
      const offer = ctx.myPendingOffers[0];
      // Accept if offer is > 60% of a reasonable price, reject lowballs
      const accept = offer.proposed_price_cents > 1000 && Math.random() > 0.3;
      return {
        actionType: accept ? 'accept_offer' : 'reject_offer',
        args: { offerId: offer.id },
        rationale: accept
          ? `Accepting ${offer.buyer_name}'s offer of $${(offer.proposed_price_cents/100).toFixed(2)}`
          : `Rejecting lowball offer from ${offer.buyer_name}`
      };
    }

    // Step 3: Reply to threads with customer activity
    if (ctx.myThreadsWithQuestions?.length > 0) {
      const thread = ctx.myThreadsWithQuestions[Math.floor(Math.random() * ctx.myThreadsWithQuestions.length)];
      return {
        actionType: 'reply_in_thread',
        args: {
          threadId: thread.thread_id,
          content: 'Thanks for your interest! Happy to answer any questions. Our products are crafted with premium materials and we stand behind our quality.'
        },
        rationale: 'Responding to customer questions'
      };
    }

    // Step 4: Create new product (10% chance)
    if (myStoreId && Math.random() > 0.9) {
      const productNames = [
        'Minimalist Pen Holder', 'Bamboo Laptop Stand', 'Ceramic Desk Tray',
        'Felt Cable Sleeve', 'Magnetic Whiteboard Tile', 'Cork Coaster Set',
        'Brass Pencil Cup', 'Leather Mouse Pad', 'Oak Card Holder'
      ];
      const name = productNames[Math.floor(Math.random() * productNames.length)];
      return {
        actionType: 'create_product',
        args: { storeId: myStoreId, title: name, description: `A beautifully crafted ${name.toLowerCase()} for the modern workspace.` },
        rationale: 'Expanding catalog'
      };
    }

    // Step 5: Engage in any active thread
    const threads = worldState.recentThreads || [];
    if (threads.length > 0) {
      const thread = threads[Math.floor(Math.random() * threads.length)];
      return {
        actionType: 'reply_in_thread',
        args: { threadId: thread.id, content: 'Great to see the marketplace buzzing! Check out our store for quality products.' },
        rationale: 'Staying visible in the marketplace'
      };
    }

    return { actionType: 'skip', args: {}, rationale: 'Nothing to do right now' };
  }

  /**
   * Customer fallback — follows the lifecycle:
   * 1. Review unreviewed orders
   * 2. Purchase from accepted offers
   * 3. Purchase listings with evidence
   * 4. Make offers on listings with evidence
   * 5. Ask questions on new listings
   * 6. Browse / create looking-for
   */
  _customerFallback(agent, worldState, agentContext) {
    const ctx = agentContext || {};
    const listings = worldState.activeListings || [];

    // Step 1: Review unreviewed orders (close the loop!)
    if (ctx.myUnreviewedOrders?.length > 0) {
      const order = ctx.myUnreviewedOrders[0];
      const rating = 2 + Math.floor(Math.random() * 4); // 2-5
      return {
        actionType: 'leave_review',
        args: {
          orderId: order.order_id,
          rating,
          body: rating >= 4
            ? `Love the ${order.product_title} from ${order.store_name}! Excellent quality and fast delivery.`
            : rating >= 3
            ? `The ${order.product_title} is okay. Does what it says but nothing special.`
            : `Disappointed with the ${order.product_title}. Expected more for the price.`
        },
        rationale: `Reviewing ${order.product_title}`
      };
    }

    // Step 2: Purchase from accepted offers
    if (ctx.acceptedOffers?.length > 0) {
      const offer = ctx.acceptedOffers[0];
      return {
        actionType: 'purchase_from_offer',
        args: { offerId: offer.id },
        rationale: `Buying ${offer.product_title} via accepted offer`
      };
    }

    // Step 3: Purchase listings where we have evidence but no order
    if (ctx.canPurchase?.length > 0 && Math.random() > 0.3) {
      const pick = ctx.canPurchase[0];
      return {
        actionType: 'purchase_direct',
        args: { listingId: pick.listing_id },
        rationale: `Purchasing ${pick.product_title} — already asked/offered`
      };
    }

    // Step 4: Make an offer on a listing we've interacted with (but haven't bought)
    if (ctx.myEvidence?.length > 0) {
      // Find a listing we asked about but haven't offered on
      const askedOnly = ctx.myEvidence.filter(e =>
        e.type === 'QUESTION_POSTED' &&
        !ctx.myOffers?.some(o => o.listing_id === e.listing_id)
      );
      if (askedOnly.length > 0) {
        const pick = askedOnly[0];
        const discount = 0.65 + Math.random() * 0.25;
        return {
          actionType: 'make_offer',
          args: {
            listingId: pick.listing_id,
            proposedPriceCents: Math.round(pick.price_cents * discount),
            buyerMessage: `I asked about the ${pick.product_title} earlier. Would you take this price?`
          },
          rationale: `Following up with an offer on ${pick.product_title}`
        };
      }
    }

    // Step 5: Ask a question on a listing we haven't interacted with yet
    const untouched = listings.filter(l =>
      !ctx.myEvidence?.some(e => e.listing_id === l.id)
    );
    if (untouched.length > 0) {
      const listing = untouched[Math.floor(Math.random() * untouched.length)];
      const questions = [
        `What makes the ${listing.product_title} worth $${(listing.price_cents/100).toFixed(2)}? Convince me.`,
        `How does the ${listing.product_title} compare to alternatives? I am looking at several options.`,
        `Can you tell me about the materials and build quality of the ${listing.product_title}?`,
        `Is the ${listing.product_title} really as good as described? Any known issues?`,
        `What is the return policy for the ${listing.product_title}? I want to try before I commit.`
      ];
      return {
        actionType: 'ask_question',
        args: { listingId: listing.id, content: questions[Math.floor(Math.random() * questions.length)] },
        rationale: `Exploring ${listing.product_title}`
      };
    }

    // Step 6: Make an offer on any listing
    if (listings.length > 0) {
      const listing = listings[Math.floor(Math.random() * listings.length)];
      const discount = 0.5 + Math.random() * 0.4;
      return {
        actionType: 'make_offer',
        args: {
          listingId: listing.id,
          proposedPriceCents: Math.round(listing.price_cents * discount),
          buyerMessage: 'Interested in this. Would you accept this price?'
        },
        rationale: 'Making an offer to start negotiation'
      };
    }

    // Step 7: Create a looking-for post
    const categories = ['desk accessories', 'cable management', 'lighting', 'gifts', 'workspace upgrade'];
    const cat = categories[Math.floor(Math.random() * categories.length)];
    return {
      actionType: 'create_looking_for',
      args: {
        title: `Looking for ${cat}`,
        constraints: { budgetCents: 3000 + Math.floor(Math.random() * 7000), category: cat, mustHaves: ['quality'] }
      },
      rationale: 'Browsing for new products'
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
