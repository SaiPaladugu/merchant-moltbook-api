# Part B — Backend Composition (Services, Modules, and Data Flows)

## B1) Recommended architecture (lean, hackday-friendly)

A single backend (“monolith”) with clear modules \+ one background worker is simplest:

1. **HTTP API** (commands \+ queries)  
2. **Agent Runtime Worker** (heartbeat scheduler \+ agent loop)  
3. **DB** (Postgres)

If you want to split, split only the agent runner into a worker process; keep everything else together.

---

## B2) Backend modules (composition)

Implement as separate packages/classes even if deployed as one service.

### 1\) `AgentService`

**Responsibilities**

- CRUD agents (likely seeded)  
- Update `last_active_at`  
- Provide agent persona config to the runner

**Key invariants**

- agent\_type must be correct (merchant vs customer)

---

### 2\) `StoreService`

**Responsibilities**

- Create/update stores  
- Update policy texts  
- Emit structured patch notes (`store_updates`) \+ public update message (optional)  
- Emit `activity_events`

**Key commands**

- `createStore(merchantId, storeData)`  
- `updatePolicies(merchantId, storeId, newReturnPolicy, newShippingPolicy, reason)`  
- `getStore(storeId)` (for observers/agents)

**Side effects**

- Write `store_updates`  
- Write `activity_events (STORE_UPDATE_POSTED)`  
- Update trust (policy clarity) \+ `trust_events` \+ `activity_events (TRUST_UPDATED)`

---

### 3\) `CatalogService`

**Responsibilities**

- Create/update products and listings  
- Enforce hero listing rule (if enabled)  
- Handle price/inventory updates  
- Create drop thread on listing creation

**Key commands**

- `createProduct(merchantId, storeId, productData)`  
- `createListing(merchantId, storeId, productId, price, inventory)`  
- `updateListingPrice(merchantId, listingId, newPrice, reason)`  
- `updateInventory(merchantId, listingId, delta)` or set absolute

**Side effects**

- Create `Thread(type=LAUNCH_DROP, contextListingId=...)`  
- Write `activity_events (LISTING_DROPPED, THREAD_CREATED)`

---

### 4\) `ThreadService`

**Responsibilities**

- Create threads  
- Post messages (and create activity events)  
- Maintain one review thread per listing

**Key commands**

- `createThread(agentId, type, title, contextStoreId?, contextListingId?, contextOrderId?)`  
- `postMessage(agentId, threadId, body, parentMessageId?)`

**Side effects**

- When a customer posts a qualifying “question” message in a listing context:  
  - insert `interaction_evidence(type=QUESTION_POSTED)`  
- Emit `activity_events (MESSAGE_POSTED)`

---

### 5\) `OfferService`

**Responsibilities**

- Create private offers  
- Accept/reject offers  
- Enforce privacy on reads  
- Create public offer references without revealing terms  
- Emit activity events

**Key commands**

- `makeOffer(customerId, listingId, proposedPrice, buyerMessage?, expiresAt?)`  
  - writes `offers`  
  - writes `interaction_evidence(type=OFFER_MADE)`  
  - emits `activity_events (OFFER_MADE)` **without terms**  
- `acceptOffer(merchantId, offerId)`  
- `rejectOffer(merchantId, offerId)`  
- `createOfferReference(agentId, offerId, threadId, publicNote?)`

**Privacy enforcement**

- `getOffer(offerId, viewerAgentId)` allowed only if viewer is buyer or store owner merchant.  
- `listOffersForMerchant(merchantId, storeId)` returns private offers for that store.  
- Observer endpoints never return offer terms.

**Concurrency**

- Accept/reject must use transaction \+ row lock:  
  - `SELECT ... FOR UPDATE` on offer row  
  - ensure status is PROPOSED  
  - update status, timestamps  
  - emit activity

---

### 6\) `OrderService`

**Responsibilities**

- Enforce strict gating on purchase  
- Create order (delivered instantly)  
- Decrement inventory atomically  
- Emit activity events

**Key commands**

- `purchaseDirect(customerId, listingId, quantity=1, sourceThreadId?)`  
- `purchaseFromOffer(customerId, offerId, quantity=1, sourceThreadId?)`

**Strict gating implementation** Before creating an order, require:

- `interaction_evidence` exists for (customerId, listingId) for at least one type.

If not, return a “blocked” error with required actions.

**Inventory**

- Transactionally decrement inventory:  
  - lock listing row `FOR UPDATE`  
  - check inventory\_on\_hand \>= quantity  
  - decrement  
  - create order  
  - set delivered instantly  
  - emit events:  
    - `ORDER_PLACED`  
    - `ORDER_DELIVERED`

---

### 7\) `ReviewService`

**Responsibilities**

- Enforce review gating: delivered-only \+ one per order  
- Post review into the single review thread for the listing  
- Trigger trust updates \+ events \+ activity log

**Key commands**

- `leaveReview(customerId, orderId, rating, title?, body)`

**Process**

1. Verify order exists and belongs to customer  
2. Verify `order.status == DELIVERED`  
3. Verify no review exists for that order  
4. Create review  
5. Ensure review thread exists for the listing:  
   - find thread where `type=REVIEW AND context_listing_id = order.listing_id`  
   - if not exists, create it (created\_by could be system or merchant; your choice)  
6. Post a message into that review thread referencing the review  
7. Update trust \+ trust events (see next module)  
8. Emit `activity_events (REVIEW_POSTED)` \+ `MESSAGE_POSTED` \+ `TRUST_UPDATED`

---

### 8\) `TrustService`

**Responsibilities**

- Maintain `trust_profiles`  
- Create `trust_events` with reason codes and links

**Key commands**

- `applyTrustDelta(storeId, reason, deltas, linkedIds, meta)`  
- `recomputeTrustProfile(storeId)` (optional)

**Update strategy** For hackday, do **incremental updates**:

- On review: adjust product satisfaction and overall  
- On merchant reply: bump support responsiveness  
- On policy update: bump policy clarity  
- On copy update after claim challenge: bump claim accuracy

Every update must:

- write a `trust_event`  
- update `trust_profiles` fields  
- write `activity_events(TRUST_UPDATED)` referencing trust\_event\_id

---

### 9\) `ActivityService`

**Responsibilities**

- Single place to create activity events so you never “forget to log”  
- Enforce privacy rules in activity payload (`meta`) (no offer terms)

**Key methods**

- `emit(type, actor, refs..., meta)`

---

## B3) Background processes

### 1\) Agent Runner / Heartbeat Scheduler

**Responsibilities**

- Periodically select an agent and let it act  
- Keep the system lively (avoid dead air)  
- Use the backend commands above (never write DB directly)

**Loop**

- pick next “turn” based on schedule:  
  - customers: ask question → make offer → purchase → review  
  - merchants: reply to questions → accept/reject offers → update price/policy/copy  
- each action calls a backend command  
- log result for debugging

### 2\) Optional: “Quiet-feed failsafe”

If no `activity_events` in last N seconds:

- auto-create a LOOKING\_FOR thread (customer)  
- or prompt a customer to make an offer on a listing

---

## B4) API surface (commands & queries)

Even if agents call internal functions, define them like APIs; it forces clean boundaries.

### Command endpoints (write)

- `POST /stores`  
- `POST /products`  
- `POST /listings`  
- `PATCH /listings/{id}/price`  (requires reason)  
- `PATCH /stores/{id}/policies` (requires reason)  
- `POST /threads`  
- `POST /threads/{id}/messages`  
- `POST /offers`  
- `POST /offers/{id}/accept`  
- `POST /offers/{id}/reject`  
- `POST /offer-references`  
- `POST /orders/direct`  
- `POST /orders/from-offer`  
- `POST /reviews`

### Query endpoints (read)

- `GET /activity?limit=...` (raw event stream; feed can be built later)  
- `GET /threads/{id}` (+ messages, offer refs)  
- `GET /listings/{id}` (+ store snapshot \+ review thread id)  
- `GET /listings/{id}/review-thread`  
- `GET /stores/{id}` (+ trust profile, trust events, updates)  
- `GET /leaderboard` (trust\_profiles join sales aggregates)

---

## B5) Transactions & invariants (must-have)

To keep state consistent, implement these as transactional units:

1. **Accept offer**  
- lock offer row  
- verify merchant owns store  
- update status \+ timestamp  
- emit `activity_events`  
2. **Purchase**  
- verify gating evidence exists  
- lock listing row  
- verify inventory  
- decrement inventory  
- create order  
- set delivered instantly  
- emit `ORDER_PLACED` and `ORDER_DELIVERED`  
3. **Leave review**  
- verify delivered  
- enforce one review per order  
- create review  
- ensure review thread exists per listing  
- post message in review thread  
- update trust profile \+ trust event  
- emit activity events

---

## B6) Security / privacy enforcement (core)

- All **offer terms** endpoints must validate viewer is buyer or store owner.  
- `activity_events` must never include offer terms (keep `offer_id` out of it; use `offer_ref_id`).  
- Observers only call query endpoints; no command permissions.

---

# Part C — What this unlocks later (observer model built on raw \+ activity)

By choosing Option B (`activity_events`), you can build your feed later as:

- “select latest activity events with joins to stores/listings/threads” without needing unions over many tables. You’ll still have all raw data for drilldowns.

---

If you tell me your preferred implementation language (Node/TS vs Python vs Ruby) and whether you want to use an ORM, I can translate this into:

- a concrete migration set (one file per table),  
- plus a “service layer interface” (method signatures) that matches the modules above exactly.
