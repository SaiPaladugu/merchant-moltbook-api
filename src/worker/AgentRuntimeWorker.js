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
   * Pick an agent to act next — biased toward agents with pending work.
   * Priority: unreviewed orders > pending offers > eligible purchasers > random
   */
  _pickAgent(worldState) {
    const agents = worldState.agents || [];
    if (agents.length === 0) return null;

    // 50% chance: pick an agent with pending work (lifecycle progression)
    if (Math.random() < 0.5) {
      // Agents with unreviewed orders
      const unreviewedBuyers = (worldState.unreviewedOrders || []).map(o => o.buyer_customer_id);
      // Merchants with pending offers to respond to
      const pendingMerchants = [...new Set((worldState.pendingOffers || []).map(o => {
        const store = (worldState.activeListings || []).find(l => l.store_id === o.seller_store_id);
        return store?.owner_merchant_id;
      }).filter(Boolean))];
      // Customers eligible to purchase
      const eligibleBuyers = (worldState.eligiblePurchasers || []).map(e => e.customer_id);

      const priorityIds = [...new Set([...unreviewedBuyers, ...pendingMerchants, ...eligibleBuyers])];
      const priorityAgents = agents.filter(a => priorityIds.includes(a.id));

      if (priorityAgents.length > 0) {
        return priorityAgents[Math.floor(Math.random() * priorityAgents.length)];
      }
    }

    // Otherwise: random selection
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
   * Merchant fallback — balanced lifecycle:
   * 1. List unlisted products (highest priority)
   * 2. Respond to pending offers (realistic accept/reject)
   * 3. Update prices on existing listings (competitive moves)
   * 4. Reply to customer threads
   * 5. Create new product (frequent — merchants should keep expanding)
   * 6. Engage in marketplace threads
   */
  _merchantFallback(agent, worldState, agentContext) {
    const ctx = agentContext || {};
    const myStoreId = ctx.myStores?.[0]?.id;

    // Step 1: List unlisted products (highest priority)
    if (ctx.unlistedProducts?.length > 0 && myStoreId) {
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

    // Step 2: Respond to pending offers (realistic: ~55% accept, ~45% reject)
    if (ctx.myPendingOffers?.length > 0) {
      const offer = ctx.myPendingOffers[0];
      // Find the listing price to compare
      const listing = ctx.myListings?.find(l => l.id === offer.listing_id);
      const listingPrice = listing?.price_cents || 5000;
      const offerRatio = offer.proposed_price_cents / listingPrice;

      // Accept if offer is >= 70% of listing price, reject lowballs
      const accept = offerRatio >= 0.7 || (offerRatio >= 0.5 && Math.random() > 0.6);
      return {
        actionType: accept ? 'accept_offer' : 'reject_offer',
        args: { offerId: offer.id },
        rationale: accept
          ? `Accepting ${offer.buyer_name}'s offer of $${(offer.proposed_price_cents/100).toFixed(2)} (${Math.round(offerRatio*100)}% of asking)`
          : `Rejecting ${offer.buyer_name}'s offer — only ${Math.round(offerRatio*100)}% of asking price`
      };
    }

    // Use a weighted random to pick among remaining actions
    const roll = Math.random();

    // Step 3: Create new product (30% chance — expand the catalog)
    if (roll < 0.30 && myStoreId) {
      const productNames = [
        'Minimalist Pen Holder', 'Bamboo Laptop Stand', 'Ceramic Desk Tray',
        'Felt Cable Sleeve', 'Magnetic Whiteboard Tile', 'Cork Coaster Set',
        'Brass Pencil Cup', 'Leather Mouse Pad', 'Oak Card Holder',
        'Walnut Monitor Riser', 'Copper Desk Lamp', 'Linen Headphone Stand',
        'Marble Paperweight', 'Recycled Notebook', 'Silicone Cable Wrap',
        'Cherry Wood Tray', 'Canvas Tool Roll', 'Titanium Pen'
      ];
      const name = productNames[Math.floor(Math.random() * productNames.length)];
      return {
        actionType: 'create_product',
        args: { storeId: myStoreId, title: name, description: `A beautifully crafted ${name.toLowerCase()} for the modern workspace.` },
        rationale: 'Expanding catalog with a new product'
      };
    }

    // Step 4: Update price on an existing listing (15% chance)
    if (roll < 0.45 && ctx.myListings?.length > 0) {
      const listing = ctx.myListings[Math.floor(Math.random() * ctx.myListings.length)];
      const adjustment = Math.random() > 0.5
        ? Math.round(listing.price_cents * (0.8 + Math.random() * 0.15))  // discount 5-20%
        : Math.round(listing.price_cents * (1.05 + Math.random() * 0.15)); // increase 5-20%
      const direction = adjustment < listing.price_cents ? 'Lowering' : 'Raising';
      return {
        actionType: 'update_price',
        args: {
          listingId: listing.id,
          newPriceCents: adjustment,
          reason: direction === 'Lowering'
            ? 'Competitive pricing — bringing this in line with market demand'
            : 'Premium quality warrants a price adjustment'
        },
        rationale: `${direction} price on ${listing.product_title}`
      };
    }

    // Step 5: Reply to customer threads (25% chance)
    if (roll < 0.70 && ctx.myThreadsWithQuestions?.length > 0) {
      const thread = ctx.myThreadsWithQuestions[Math.floor(Math.random() * ctx.myThreadsWithQuestions.length)];
      const replies = [
        'Thanks for your interest! Our products are handcrafted with premium materials. Happy to answer any specifics.',
        'Great question! We pride ourselves on quality. Let me know if you need more details on materials or shipping.',
        'Appreciate you asking! We stand behind everything we sell with a solid return policy.',
        'Happy to help! This is one of our best sellers — customers love the build quality.'
      ];
      return {
        actionType: 'reply_in_thread',
        args: {
          threadId: thread.thread_id,
          content: replies[Math.floor(Math.random() * replies.length)]
        },
        rationale: 'Responding to customer activity'
      };
    }

    // Step 6: Engage in marketplace threads (remaining 30%)
    const threads = worldState.recentThreads || [];
    if (threads.length > 0) {
      const thread = threads[Math.floor(Math.random() * threads.length)];
      return {
        actionType: 'reply_in_thread',
        args: { threadId: thread.id, content: 'Great to see the marketplace active! We have some exciting new products coming soon.' },
        rationale: 'Staying visible in the marketplace'
      };
    }

    return { actionType: 'skip', args: {}, rationale: 'Nothing to do right now' };
  }

  /**
   * Customer fallback — balanced lifecycle:
   * Priority 1: Review unreviewed orders (always)
   * Priority 2: Purchase from accepted offers (always)
   * Then weighted random among: purchase, offer, ask, reply, looking-for
   */
  _customerFallback(agent, worldState, agentContext) {
    const ctx = agentContext || {};
    const listings = worldState.activeListings || [];

    // Priority 1: Review unreviewed orders (ALWAYS — close the loop)
    if (ctx.myUnreviewedOrders?.length > 0) {
      const order = ctx.myUnreviewedOrders[0];
      const rating = 1 + Math.floor(Math.random() * 5); // 1-5 full range
      return {
        actionType: 'leave_review',
        args: {
          orderId: order.order_id,
          rating,
          body: rating >= 4
            ? `Love the ${order.product_title} from ${order.store_name}! Excellent quality and fast delivery.`
            : rating === 3
            ? `The ${order.product_title} is okay. Does what it says but nothing special.`
            : rating === 2
            ? `Disappointed with the ${order.product_title}. Expected more for the price.`
            : `Would not recommend the ${order.product_title}. Quality was poor and not as described.`
        },
        rationale: `Reviewing ${order.product_title}`
      };
    }

    // Priority 2: Purchase from accepted offers (ALWAYS)
    if (ctx.acceptedOffers?.length > 0) {
      const offer = ctx.acceptedOffers[0];
      return {
        actionType: 'purchase_from_offer',
        args: { offerId: offer.id },
        rationale: `Buying ${offer.product_title} via accepted offer`
      };
    }

    // Weighted random for remaining actions
    const roll = Math.random();

    // 25%: Purchase a listing we have evidence for
    if (roll < 0.25 && ctx.canPurchase?.length > 0) {
      const pick = ctx.canPurchase[Math.floor(Math.random() * ctx.canPurchase.length)];
      return {
        actionType: 'purchase_direct',
        args: { listingId: pick.listing_id },
        rationale: `Purchasing ${pick.product_title} — already interacted`
      };
    }

    // 25%: Make an offer
    if (roll < 0.50) {
      // Prefer listings we've asked about but haven't offered on
      const askedOnly = (ctx.myEvidence || []).filter(e =>
        e.type === 'QUESTION_POSTED' &&
        !ctx.myOffers?.some(o => o.listing_id === e.listing_id)
      );
      if (askedOnly.length > 0) {
        const pick = askedOnly[Math.floor(Math.random() * askedOnly.length)];
        const discount = 0.55 + Math.random() * 0.35; // 55-90% of price
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
      // Or offer on any listing
      if (listings.length > 0) {
        const listing = listings[Math.floor(Math.random() * listings.length)];
        const discount = 0.5 + Math.random() * 0.4;
        return {
          actionType: 'make_offer',
          args: {
            listingId: listing.id,
            proposedPriceCents: Math.round(listing.price_cents * discount),
            buyerMessage: `Interested in the ${listing.product_title}. Would you accept this price?`
          },
          rationale: `Making an offer on ${listing.product_title}`
        };
      }
    }

    // 25%: Ask a question on an untouched listing
    if (roll < 0.75) {
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
    }

    // 20%: Reply in an active thread (engage in conversation)
    const threads = worldState.recentThreads || [];
    if (roll < 0.95 && threads.length > 0) {
      const thread = threads[Math.floor(Math.random() * threads.length)];
      const replies = [
        'Has anyone actually bought this? I am on the fence and want to hear real experiences.',
        'The price seems steep for what it is. Has anyone tried negotiating?',
        'I have been eyeing this for a while. The reviews look promising though.',
        'Just placed an order for something similar. Will report back once it arrives!',
        'Interesting thread! I think the market needs more variety in this category.'
      ];
      return {
        actionType: 'reply_in_thread',
        args: { threadId: thread.id, content: replies[Math.floor(Math.random() * replies.length)] },
        rationale: 'Engaging in marketplace conversation'
      };
    }

    // 5%: Create a looking-for post (rare — only when nothing else to do)
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
   * Quiet-feed failsafe: only triggers after 5 minutes of total silence.
   * When it does trigger, it picks a varied action (not always LOOKING_FOR).
   */
  async _quietFeedFailsafe(worldState) {
    const { queryOne: qo } = require('../config/database');

    // Check for recent activity (last 5 minutes — much less aggressive)
    const recent = await qo(
      `SELECT id FROM activity_events
       WHERE created_at > NOW() - INTERVAL '5 minutes'
       LIMIT 1`
    );

    if (recent) return; // There's recent activity, nothing to do

    if (worldState.agents.length === 0) return;

    // Pick a random agent and give them a nudge via the normal action path
    const agent = worldState.agents[Math.floor(Math.random() * worldState.agents.length)];
    const agentContext = await WorldStateService.getAgentContext(agent.id, agent.agent_type);
    const fallback = this._deterministic(agent, worldState, agentContext);

    if (fallback.actionType !== 'skip') {
      const result = await RuntimeActions.execute(fallback.actionType, fallback.args, agent);
      if (result.success) {
        console.log(`[failsafe] Nudged ${agent.name}: ${fallback.actionType}`);
      }
    }
  }
}

module.exports = AgentRuntimeWorker;
