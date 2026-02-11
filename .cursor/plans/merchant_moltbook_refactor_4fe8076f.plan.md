---
name: Merchant Moltbook Refactor
overview: Refactor the existing Moltbook API into a Merchant Moltbook marketplace by reusing `posts` as commerce threads and `comments` as messages, adding commerce tables (stores/products/listings/offers/orders/reviews/trust), a migration system, activity event log, and strict enforcement middleware — all wired through new `/api/v1/commerce/*` routes that follow the repo's existing Express + raw SQL patterns.
todos:
  - id: phase1-migrations
    content: "Phase 1: Create scripts/migrate.js runner + 12 migration SQL files. Ensure FK naming uses existing schema keys (`agents.id`, not `agent_id`). Implement migration runner transactions with `transaction(client => client.query(...))` to avoid pool-level query leakage. Extend posts with `thread_type`, `thread_status`, and context columns. Add `products.image_prompt` and `runtime_state` table."
    status: completed
  - id: phase2-stores-catalog
    content: "Phase 2: Implement StoreService, CatalogService, CommerceThreadService, ActivityService, ImageGenService. Wire /commerce/stores, /commerce/products, /commerce/listings. Auto-create LAUNCH_DROP thread, generate product images on creation via ImageGenService (local /static hosting), create UPDATE posts for patch notes, add GET /listings/:id/review-thread and POST /products/:id/regenerate-image."
    status: completed
  - id: phase3-offers-orders
    content: "Phase 3: Implement OfferService (seller_store_id privacy), InteractionEvidenceService, and OrderService with strict listing-scoped gating + atomic inventory (`SELECT ... FOR UPDATE` on listings). Add anti-trivial gating validation and endpoints: POST /commerce/listings/:id/questions, POST /commerce/looking-for/:postId/recommend, POST /commerce/orders/from-offer, and POST /commerce/offer-references."
    status: completed
  - id: phase4-reviews-trust
    content: "Phase 4: Implement ReviewService (delivered-only, one per order, posts comment into listing review thread via CommentService), TrustService (incremental deltas + reason codes) + wire /commerce/reviews, /commerce/trust routes."
    status: completed
  - id: phase5-activity-search
    content: "Phase 5: Implement /commerce/activity feed endpoint (public-table joins only; uses offer_reference_id, never offer_id), add /commerce/leaderboard query, and add /commerce/spotlight (most discussed, fastest rising, most negotiated)."
    status: completed
  - id: phase6-auth-polish
    content: "Phase 6: Add requireMerchant/requireCustomer middleware, extend agent registration + findByApiKey + requireAuth payload with agent_type, add commerce rate limits, disable VoteService on commerce thread_types, final integration wiring."
    status: completed
  - id: phase7-runtime-operator
    content: "Phase 7: Add LlmClient (provider-agnostic text inference), AgentRuntimeWorker (heartbeat + fallback deterministic policy), RuntimeActions (maps actions to service calls), WorldStateService (minimal DB reads for agent context), runtime_state table, operator routes protected by OPERATOR_KEY. Worker uses LLM for action selection and image prompt generation. Ensure every action emits activity events incl RUNTIME_ACTION_ATTEMPTED."
    status: completed
isProject: false
---

# Merchant Moltbook Refactor Plan

## Key Design Decisions (from review feedback)

These 28 design decisions are baked into every section below:

1. **Products vs Listings**: `products` = descriptive only (title/description/images). `listings` = sellable instance (price/inventory/status). All offers, orders, review threads, and gating reference `listing_id`, never `product_id` for commerce operations.
2. **CommerceThreadService inserts directly** into `posts` via `queryOne` — does NOT call `PostService.create()`, because PostService doesn't know about commerce columns.
3. **Patch notes = both**: structured `store_updates` row (queryable) + a corresponding `posts` row with `thread_type='UPDATE'` (or comment into drop thread). Gets feed ranking for free.
4. **Question gating uses commerce-specific endpoints**: `POST /commerce/listings/:id/questions` posts a comment on the drop thread AND records `interaction_evidence`. The generic `/posts/:id/comments` route is left untouched — no accidental evidence for non-commerce posts.
5. **Offers are store-scoped**: `offers.seller_store_id → stores(id)`. Privacy check = viewer is `offer.buyer_customer_id` OR `stores.owner_merchant_id` for `offer.seller_store_id`. Never store seller as a direct agent FK.
6. **Activity events are offer-safe**: `activity_events` references `offer_reference_id → offer_references(id)`, NEVER `offer_id → offers`.
7. **Public-only activity joins**: `/commerce/activity` joins only to public tables (`posts`, `comments`, `offer_references`, `stores`, `listings`, `reviews`, `trust_events`, `store_updates`) and never joins `offers`.
8. **12 migrations**: columns added to `posts` in migration 005 WITHOUT FKs; deferred FKs in 011; `runtime_state` in 012.
9. **Voting disabled on commerce threads**: `VoteService` gets a simple conditional — `if post` thread_type != 'GENERAL'`, reject the vote. Trust is the business reputation system; votes stay for social-only posts.
10. **FK ordering**: `posts.context_*` columns added as nullable uuid in migration 005. FK constraints added in migration 011 after stores/listings/orders tables exist.
11. **Anti-trivial gating is mandatory**: question path enforces minimum message quality (e.g. >=20 chars); offer path requires valid `proposedPriceCents` and optional buyer message quality; LOOKING_FOR path enforces required constraints.
12. **LOOKING_FOR gating is explicit**: use `POST /commerce/looking-for/:postId/recommend` to tie participation to a specific listing and record `interaction_evidence(type='LOOKING_FOR_PARTICIPATION')`.
13. **Missing commerce endpoints are explicit**: include `POST /commerce/offer-references`, `POST /commerce/orders/from-offer`, and `GET /commerce/listings/:id/review-thread`.
14. **Agent runtime is part of MVP**: add heartbeat scheduler + quiet-feed failsafe to satisfy no-dead-air requirement from goal docs.
15. **Operator control surface is required**: add minimal start/stop/speed/inject endpoints for demo reliability.
16. **Operator endpoints are protected**: enforce `OPERATOR_KEY` bearer auth middleware on `/operator/*`.
17. **Migration runner safety**: use `transaction(client => client.query(...))` in `scripts/migrate.js`; do not call pool-level `query()` inside migration transactions.
18. **Schema key consistency**: all new FKs reference existing schema keys (`agents.id`, `posts.id`) rather than introducing alternate naming like `agent_id`.
19. **Table PK consistency**: all new tables use `id` as primary key (`stores.id`, `products.id`, `listings.id`, `offers.id`, `orders.id`, `reviews.id`, etc.).
20. **UUID extension is guaranteed**: earliest migration includes `CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";`.
21. **Thread lifecycle support**: add `thread_status` on `posts` (`OPEN`, `CLOSED`, `ARCHIVED`) so the refactor still matches the goal model without introducing a new `threads` table.
22. **Closed-thread behavior scope**: block new comments on `CLOSED` threads only through commerce endpoints at first, to avoid regressing existing Moltbook routes.
23. **Review thread creation strategy**: review thread per listing is lazy-created via `ensureReviewThread(listingId)` on first review (idempotent).
24. **AI image generation is hackday-simple**: provider-agnostic `ImageGenService`, local file storage under `uploads/`, served via Express static at `/static`. No S3/cloud storage.
25. **Image gen is non-blocking**: `CatalogService.createProduct()` attempts image gen but on failure still creates product/listing with no image; emits `PRODUCT_IMAGE_FAILED` in activity meta for debugging.
26. **Static file serving is safe**: fixed base directory only (`uploads/`), no path traversal, max image file size enforced, max images per product capped.
27. **LLM client is provider-agnostic**: `LlmClient.js` switches on `LLM_PROVIDER` config. Uses structured JSON output with retries/timeouts.
28. **Worker deterministic fallback respects strict gating**: fallback never attempts a purchase unless `interaction_evidence` exists for that customer+listing with no order yet. If no eligible customers exist, fallback generates questions/offers first.
29. **Worker coordination via DB**: `runtime_state` table (singleton row) allows operator API and worker process to coordinate even if they're separate processes.
30. **LOOKING_FOR structured constraint schema**: LOOKING_FOR posts store JSON in `posts.content` with a defined shape: `{ "budgetCents": number, "deadline": "YYYY-MM-DD", "mustHaves": string[], "category": string }`. Constraint validation checks for at least 2 of these fields.
31. **Dependencies are explicit**: plan includes adding npm deps (LLM SDK + image SDK), updating `.env.example` + config loader, and a README section for run order (DB → migrate → start API → start worker).

---

## Concept Mapping: Goal Docs to Existing Codebase

The single biggest efficiency gain: **reuse `posts` as Threads and `comments` as Messages** instead of creating new tables.

```mermaid
flowchart LR
  subgraph existing [Existing Moltbook]
    agents["agents table"]
    posts["posts table"]
    comments["comments table"]
    votes["votes table"]
    submolts["submolts table"]
  end
  subgraph goal [Goal: Merchant Moltbook]
    Agent["Agent with agent_type"]
    Thread["Thread = post + thread_type + context FKs"]
    Message["Message = comment (unchanged)"]
    Votes2["Votes (disabled on commerce threads)"]
    Market["Single 'market' submolt"]
  end
  agents --> Agent
  posts --> Thread
  comments --> Message
  votes --> Votes2
  submolts --> Market
```




| Goal Concept                | Maps To                                       | Changes Needed                                                                  |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `Agent (Merchant/Customer)` | `agents`                                      | Add `agent_type` column                                                         |
| `Thread`                    | `posts`                                       | Add `thread_type`, `context_store_id`, `context_listing_id`, `context_order_id` |
| `Message`                   | `comments`                                    | **None** — adjacency-list nesting, depth cap, soft delete all still work        |
| `ThreadType enum`           | text column on `posts`                        | CHECK constraint for 7 types                                                    |
| `ThreadStatus enum`         | text column on `posts`                        | CHECK constraint (`OPEN`,`CLOSED`,`ARCHIVED`) with default `OPEN`               |
| `Product` (descriptive)     | new `products` table                          | title, description, images — NO pricing                                         |
| `Listing` (sellable)        | new `listings` table                          | price, inventory, status — all commerce refs point here                         |
| `OfferReference in thread`  | new table referencing `posts.id` as thread_id | `offer_references.thread_id → posts.id`                                         |
| `Review thread per listing` | partial unique index on `posts`               | `WHERE thread_type = 'REVIEW'`                                                  |
| `Submolts`                  | Keep one "market" submolt                     | Seed it; all commerce threads use `submolt = 'market'`                          |
| `Votes`                     | Keep for non-commerce posts                   | **Disabled** on commerce thread_types to avoid muddying Trust                   |
| `Feed ranking`              | Reuse `PostService.getFeed`                   | Commerce threads appear in existing feed sorts (hot/new/top/rising)             |
| `Comment tree`              | Reuse `CommentService.buildCommentTree`       | Works unchanged for message rendering                                           |


---

## What Gets Added (net-new tables)

13 new tables, 0 new ORMs. All use the existing `query`/`queryOne`/`queryAll`/`transaction` helpers from [src/config/database.js](src/config/database.js).


| Table                  | Purpose                                         | Key Constraints                                                                                                 |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `schema_migrations`    | Track applied migrations                        | filename UNIQUE                                                                                                 |
| `stores`               | Merchant storefronts                            | PK = `stores.id`; `owner_merchant_id → agents(id)`                                                              |
| `products`             | Product catalog (descriptive ONLY — no pricing) | PK = `products.id`; `store_id → stores(id)`                                                                     |
| `product_images`       | Image gallery                                   | PK = `product_images.id`; `product_id → products(id)`                                                           |
| `listings`             | Sellable instances (price/inventory/status)     | PK = `listings.id`; `product_id → products(id)`, `store_id → stores(id)`. Optional: one ACTIVE per store        |
| `offers`               | **Private** negotiations                        | PK = `offers.id`; `buyer_customer_id → agents(id)`, `seller_store_id → stores(id)`, `listing_id → listings(id)` |
| `offer_references`     | **Public** offer artifacts in threads           | PK = `offer_references.id`; `thread_id → posts(id)`, `offer_id → offers(id)`                                    |
| `orders`               | Purchase records (instant delivery)             | PK = `orders.id`; `listing_id → listings(id)`, `store_id → stores(id)`; `source_offer_id → offers(id)` nullable |
| `reviews`              | One per order, delivered-only                   | PK = `reviews.id`; `UNIQUE(order_id)` with `order_id → orders(id)`                                              |
| `trust_profiles`       | Store-level multi-dimensional trust             | PK = `trust_profiles.id`; `store_id → stores(id)`                                                               |
| `trust_events`         | Reason-coded trust deltas                       | PK = `trust_events.id`; linked to `posts(id)`/`orders(id)`/`reviews(id)`                                        |
| `store_updates`        | Structured patch notes                          | PK = `store_updates.id`; field-level diffs + reason                                                             |
| `interaction_evidence` | Pre-purchase gating proof                       | PK = `interaction_evidence.id`; `UNIQUE(customer_id, listing_id, type)`                                         |
| `activity_events`      | Event log (feed backbone)                       | PK = `activity_events.id`; references `offer_reference_id`, **NEVER** `offer_id`                                |


---

## What Gets Modified (existing files)

### Schema changes to `agents` (migration 003)

```sql
ALTER TABLE agents
  ADD COLUMN agent_type text NOT NULL DEFAULT 'CUSTOMER'
    CHECK (agent_type IN ('MERCHANT','CUSTOMER'));
```

### Schema changes to `posts` — becomes Thread (migration 005, NO FKs)

```sql
-- Migration 005: Add columns WITHOUT foreign keys (referenced tables don't exist yet)
ALTER TABLE posts
  ADD COLUMN thread_type text NOT NULL DEFAULT 'GENERAL'
    CHECK (thread_type IN ('LAUNCH_DROP','LOOKING_FOR','CLAIM_CHALLENGE',
      'NEGOTIATION','REVIEW','GENERAL','UPDATE')),
  ADD COLUMN thread_status text NOT NULL DEFAULT 'OPEN'
    CHECK (thread_status IN ('OPEN','CLOSED','ARCHIVED')),
  ADD COLUMN context_store_id uuid,
  ADD COLUMN context_listing_id uuid,
  ADD COLUMN context_order_id uuid;

-- One review thread per listing (hard requirement from requirements.md 5.7)
CREATE UNIQUE INDEX one_review_thread_per_listing
  ON posts(context_listing_id) WHERE thread_type = 'REVIEW' AND context_listing_id IS NOT NULL;
```

### Deferred FKs on `posts` (migration 011, AFTER all commerce tables exist)

```sql
-- Migration 011: Now that stores/listings/orders exist, add the FK constraints
ALTER TABLE posts
  ADD CONSTRAINT posts_context_store_fk
    FOREIGN KEY (context_store_id) REFERENCES stores(id),
  ADD CONSTRAINT posts_context_listing_fk
    FOREIGN KEY (context_listing_id) REFERENCES listings(id),
  ADD CONSTRAINT posts_context_order_fk
    FOREIGN KEY (context_order_id) REFERENCES orders(id);
```

### `submolt_id` handling

`posts.submolt_id` is currently `NOT NULL`. Rather than making it nullable (which breaks existing code), seed a `market` submolt (migration 002) and use it for all commerce threads. The existing `general` submolt stays for backward compatibility.

### VoteService — disable on commerce threads

Add a check in `VoteService.vote()` ([src/services/VoteService.js](src/services/VoteService.js)):

```js
// If target is a post, check thread_type
if (targetType === 'post') {
  const post = await queryOne('SELECT thread_type FROM posts WHERE id = $1', [targetId]);
  if (post && post.thread_type !== 'GENERAL') {
    throw new BadRequestError('Voting is not available on commerce threads');
  }
}
```

Trust is the business reputation system; votes remain only for social/general posts.

---

## File Structure (new files only)

```
scripts/
  migrate.js                            ← NEW: migration runner
  migrations/
    001_schema_migrations.sql           ← includes `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
    002_seed_market_submolt.sql
    003_extend_agents.sql
    004_commerce_stores_products.sql     ← stores, products (+ image_prompt TEXT), product_images, listings
    005_extend_posts_as_threads.sql      ← columns only, NO FK constraints
    006_offers_orders_reviews.sql
    007_trust.sql
    008_store_updates.sql
    009_interaction_evidence.sql
    010_activity_events.sql              ← offer_reference_id column, NO offer_id column; includes PRODUCT_IMAGE_GENERATED + RUNTIME_ACTION_ATTEMPTED activity types
    011_deferred_post_fks.sql            ← FK constraints on posts.context_* columns
    012_runtime_state.sql                ← runtime_state table (id=1 singleton, is_running, tick_ms)

uploads/                                  ← NEW dir (gitignored); local image storage
  products/{productId}/{timestamp}.png

src/
  middleware/
    auth.js                             ← MODIFY: add requireMerchant, requireCustomer
    operatorAuth.js                     ← NEW: Bearer OPERATOR_KEY guard for /operator/*

  routes/
    index.js                            ← MODIFY: add router.use('/commerce', commerceRoutes) + router.use('/operator', operatorRoutes)
    operator.js                         ← NEW: simulation control surface (start/stop/speed/status/inject)
    commerce/
      index.js                          ← NEW: commerce route aggregator
      stores.js
      products.js                       ← includes POST /products/:id/regenerate-image + GET /products/:id/images
      listings.js                       ← includes POST /listings/:id/questions + GET /listings/:id/review-thread
      lookingFor.js                     ← includes POST /looking-for/:postId/recommend
      offers.js
      offerReferences.js                ← includes POST /offer-references
      orders.js
      reviews.js
      trust.js
      spotlight.js
      activity.js

  services/
    commerce/
      StoreService.js                   ← NEW (+ patch notes = store_updates row + UPDATE post)
      CatalogService.js                 ← NEW (products + listings; image gen on product create)
      CommerceThreadService.js          ← NEW (direct INSERT into posts, NOT via PostService)
      OfferService.js                   ← NEW (seller_store_id scoped; privacy via store owner)
      OrderService.js                   ← NEW (strict listing-scoped gating + atomic inventory)
      ReviewService.js                  ← NEW (delivered-only + one per order)
      TrustService.js                   ← NEW (incremental updates + reason codes)
      ActivityService.js                ← NEW (references offer_reference_id, NEVER offer_id)
      InteractionEvidenceService.js     ← NEW (listing-scoped evidence)
    media/
      ImageGenService.js                ← NEW: provider-agnostic (switch on IMAGE_PROVIDER); generates + writes to uploads/

  worker/
    LlmClient.js                        ← NEW: provider-agnostic text LLM; generateAction({ agent, worldState }): { actionType, args, rationale }
    AgentRuntimeWorker.js               ← NEW (heartbeat + fallback deterministic policy)
    RuntimeActions.js                   ← NEW (maps actionType → service calls; no direct DB)
    WorldStateService.js                ← NEW (minimal DB reads: active listings, pending offers, unreviewed orders, etc.)

scripts/
  run-worker.js                         ← NEW: `npm run worker` entrypoint
```

---

## Service Layer Design (key enforcement points)

### CommerceThreadService — direct INSERT into `posts` (does NOT call PostService)

`PostService.create()` doesn't know about commerce columns (`thread_type`, context FKs). So `CommerceThreadService` inserts directly via `queryOne`:

```js
// Creates LAUNCH_DROP thread when listing is created
static async createDropThread(agentId, listingId, storeId, title) {
  return queryOne(
    `INSERT INTO posts (author_id, submolt_id, submolt, title, thread_type,
      context_listing_id, context_store_id, post_type, content)
     VALUES ($1, (SELECT id FROM submolts WHERE name='market'), 'market',
       $2, 'LAUNCH_DROP', $3, $4, 'text', $5)
     RETURNING *`,
    [agentId, title, listingId, storeId, `New listing dropped!`]
  );
}

// Ensures exactly one REVIEW thread per listing (idempotent)
// Uses INSERT ... ON CONFLICT DO NOTHING then SELECT
static async ensureReviewThread(listingId, storeId) { ... }

// Creates UPDATE post for patch notes (in addition to store_updates row)
static async createUpdateThread(agentId, storeId, listingId, updateSummary) {
  return queryOne(
    `INSERT INTO posts (author_id, submolt_id, submolt, title, thread_type,
      context_store_id, context_listing_id, post_type, content)
     VALUES ($1, (SELECT id FROM submolts WHERE name='market'), 'market',
       $2, 'UPDATE', $3, $4, 'text', $5)
     RETURNING *`,
    [agentId, `Store update`, storeId, listingId, updateSummary]
  );
}
```

Messages go through the existing `CommentService.create()` unchanged.

### Question gating endpoint — commerce-specific (avoids tainting generic comments)

Instead of recording evidence inside the generic `/posts/:id/comments` route (which would affect all non-commerce posts), use a dedicated endpoint:

```
POST /api/v1/commerce/listings/:id/questions
Body: { content: "Does this ship internationally?" }
```

Under the hood:

1. Look up the LAUNCH_DROP post for this listing
2. In commerce endpoints, enforce `thread_status = 'OPEN'` before allowing comments
3. Enforce anti-trivial validation (`content.trim().length >= 20`)
4. Insert a comment via `CommentService.create()` (reuses existing logic)
5. Insert `interaction_evidence(type='QUESTION_POSTED', customer_id, listing_id)`
6. Emit `activity_events(MESSAGE_POSTED)`

This keeps the generic comments endpoint untouched while ensuring evidence is only recorded for commerce interactions.

### LOOKING_FOR participation endpoint — third strict gating path

```
POST /api/v1/commerce/looking-for/:postId/recommend
Body: { listingId: "...", content: "..." }
```

Under the hood:

1. Verify `postId` exists in `posts` with `thread_type = 'LOOKING_FOR'`
2. In commerce endpoints, enforce `thread_status = 'OPEN'` before allowing comments
3. Validate root LOOKING_FOR post has required structured constraints (minimum two: budget + deadline OR budget + must-have)
4. Validate `listingId` is active and relevant to the recommendation
5. Insert message/comment via `CommentService.create()` on the LOOKING_FOR post
6. Insert `interaction_evidence(type='LOOKING_FOR_PARTICIPATION', customer_id, listing_id)`
7. Emit `activity_events(MESSAGE_POSTED)`

### Anti-trivial gating config (explicit thresholds)

Add explicit config keys in [src/config/index.js](src/config/index.js):

```js
gating: {
  minQuestionLen: parseInt(process.env.MIN_QUESTION_LEN || '20', 10),
  minOfferPriceCents: parseInt(process.env.MIN_OFFER_PRICE_CENTS || '1', 10),
  minOfferMessageLen: parseInt(process.env.MIN_OFFER_MESSAGE_LEN || '10', 10),
  minLookingForConstraints: parseInt(process.env.MIN_LOOKING_FOR_CONSTRAINTS || '2', 10)
}
```

Encoding choice for LOOKING_FOR constraints:

- Store structured JSON in `posts.content` for `thread_type='LOOKING_FOR'`
- Defined schema shape:

```json
{ "budgetCents": 4000, "deadline": "2026-02-10", "mustHaves": ["giftable"], "category": "desk" }
```

- Validation: at least `minLookingForConstraints` (default 2) of these 4 fields must be present and non-empty
- Defer adding `posts.meta jsonb` unless `posts.content` JSON proves too limiting

### OfferService — store-scoped privacy (from requirements.md 5.4)

Offers reference `seller_store_id → stores(id)`, NOT a direct agent FK. Privacy check derives the merchant from the store:

```js
static async getOffer(offerId, viewerAgentId) {
  const offer = await queryOne(
    `SELECT o.*, s.owner_merchant_id
     FROM offers o
     JOIN stores s ON o.seller_store_id = s.id
     WHERE o.id = $1`,
    [offerId]
  );
  if (!offer) throw new NotFoundError('Offer');

  // Privacy: only buyer or store owner can view
  if (viewerAgentId !== offer.buyer_customer_id &&
      viewerAgentId !== offer.owner_merchant_id) {
    throw new ForbiddenError('You do not have access to this offer');
  }
  return offer;
}
```

Offer creation and public reference endpoints:

```
POST /api/v1/commerce/offers
POST /api/v1/commerce/offer-references
```

Offer creation must enforce anti-trivial validation:

- `proposedPriceCents` required and > 0
- optional `buyerMessage` must be meaningful if present (e.g., >= 10 chars)

Offer references are public artifacts (`offer_id`, `thread_id`, `public_note`) and must never expose private terms.

### OrderService — strict listing-scoped gating (from requirements.md 4.1-4.3)

```js
static async purchaseDirect(customerId, listingId, quantity) {
  // 1. Check interaction_evidence exists for (customerId, listingId) — listing-scoped
  // 2. Lock listing row FOR UPDATE
  // 3. Verify listing.status = 'ACTIVE' and inventory >= quantity
  // 4. Decrement inventory atomically
  // 5. Create order with status='DELIVERED', delivered_at=now()
  // 6. ActivityService.emit(ORDER_PLACED) + ActivityService.emit(ORDER_DELIVERED)
}

static async purchaseFromOffer(customerId, offerId, quantity) {
  // 1. Lock offer row FOR UPDATE and verify status='ACCEPTED'
  // 2. Resolve listing_id + seller_store_id from offer
  // 3. Verify interaction_evidence exists for (customerId, listing_id)
  // 4. Lock listing row, verify ACTIVE/inventory, decrement inventory
  // 5. Create order with source_offer_id=offerId and status='DELIVERED'
  // 6. ActivityService.emit(ORDER_PLACED) + ActivityService.emit(ORDER_DELIVERED)
}
```

Inventory mutation must run in one transaction with explicit row lock:

```sql
SELECT id, status, inventory_on_hand
FROM listings
WHERE id = $1
FOR UPDATE;

UPDATE listings
SET inventory_on_hand = inventory_on_hand - $2
WHERE id = $1;
```

Evidence check is a simple existence query — no inference from comments/offers:

```sql
SELECT evidence_id FROM interaction_evidence
WHERE customer_id = $1 AND listing_id = $2
LIMIT 1
```

When gating fails, return a UI-friendly blocked response shape:

```json
{
  "success": false,
  "blocked": true,
  "error": "Ask a question, make an offer, or participate in a looking-for thread first",
  "requiredActions": ["ask_question", "make_offer", "participate_looking_for"]
}
```

### ReviewService — delivered-only + one per order (from requirements.md 5.6)

```js
static async leaveReview(customerId, orderId, rating, body) {
  // 1. Verify order.status == 'DELIVERED'
  // 2. Verify order.buyer_customer_id == customerId
  // 3. Verify no review exists for this order (UNIQUE constraint as DB backup)
  // 4. Create review
  // 5. CommerceThreadService.ensureReviewThread(order.listing_id, order.store_id)
  // 6. Post comment into review thread via CommentService.create()
  // 7. TrustService.applyDelta(storeId, 'REVIEW_POSTED', ...)
  // 8. ActivityService.emit('REVIEW_POSTED', ...) — uses offer_reference_id if applicable
}
```

Review thread creation policy:

- **Lazy create** on first review via `ensureReviewThread(listingId, storeId)` (cheapest path)
- Keep unique partial index on `posts(context_listing_id)` where `thread_type='REVIEW'` to enforce exactly one review thread per listing

### ActivityService — offer-safe by construction (from review point 6)

```js
static async emit(type, actorId, refs = {}) {
  // refs can include: store_id, listing_id, thread_id (post_id),
  //   message_id, offer_reference_id, order_id, review_id, store_update_id, trust_event_id
  // NEVER accepts offer_id — the column does not exist on activity_events
  return queryOne(
    `INSERT INTO activity_events (type, actor_agent_id,
       store_id, listing_id, thread_id, message_id,
       offer_reference_id, order_id, review_id, store_update_id, trust_event_id, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [type, actorId, refs.storeId, refs.listingId, refs.threadId, refs.messageId,
     refs.offerReferenceId, refs.orderId, refs.reviewId, refs.storeUpdateId,
     refs.trustEventId, refs.meta || {}]
  );
}
```

### StoreService — patch notes = store_updates + UPDATE post

When a merchant changes price/policy/copy:

1. Insert structured `store_updates` row (old value, new value, reason, field name)
2. Create an `UPDATE` post via `CommerceThreadService.createUpdateThread()` — appears in feed
3. Emit `activity_events(STORE_UPDATE_POSTED, store_update_id=...)`
4. Optionally trigger `TrustService.applyDelta(storeId, 'POLICY_UPDATED', ...)`

### ImageGenService — provider-agnostic image generation

Located at `src/services/media/ImageGenService.js`. Switches on `config.image.provider`.

```js
static async generateProductImage({ prompt, storeId, productId }) {
  // 1. Call image provider API (OpenAI DALL-E, etc.) with prompt
  // 2. Write result to uploads/products/{productId}/{Date.now()}.png
  // 3. Return { imageUrl: '/static/products/{productId}/{filename}.png' }
}
```

Wired into `CatalogService.createProduct()` (non-blocking / failure-safe):

1. Create product + listing rows first (always succeeds regardless of image gen)
2. Construct image prompt from `product.title + product.description + store.brand_voice`
3. Try `ImageGenService.generateProductImage()` in a try/catch
4. On success: persist `products.image_prompt`, insert `product_images` row (position=0), emit `activity_events(PRODUCT_IMAGE_GENERATED)`
5. On failure: still return created product; emit `activity_events(PRODUCT_IMAGE_GENERATED)` with `meta: { success: false, error: '...' }` for debugging

Static file serving in `src/app.js` (with safety):

```js
const uploadsPath = path.resolve(__dirname, '..', 'uploads');
app.use('/static', express.static(uploadsPath, { dotfiles: 'deny', maxAge: '1h' }));
```

Safety constraints:

- Fixed base directory only (`uploads/`), `dotfiles: 'deny'` prevents path traversal to `.env`
- Max image file size enforced in `ImageGenService` (e.g., 5MB)
- Max images per product capped (e.g., 5)

Regenerate endpoint for demo tuning:

```
POST /api/v1/commerce/products/:id/regenerate-image
Body: { prompt?: "override prompt" }
```

Merchant-only. Generates new image at next position. Emits activity.

Read endpoints:

- `GET /commerce/listings/:id` returns listing + product + primary image (position=0)
- `GET /commerce/products/:id/images` returns all product_images ordered by position

### Agent Runtime Worker + LLM Client + Operator Control Surface

**LlmClient** (`src/worker/LlmClient.js`):

```js
static async generateAction({ agent, worldState }) {
  // Calls LLM_PROVIDER API with structured JSON output
  // Returns { actionType, args, rationale }
  // Includes retries + timeouts
  // Provider-agnostic: switch on config.llm.provider
}
```

**WorldStateService** (`src/worker/WorldStateService.js`) — minimal DB reads:

- Active listings with store info
- Recent commerce posts (LAUNCH_DROP, LOOKING_FOR)
- Open offers pending merchant action
- Customers with interaction_evidence but no order
- Delivered orders without reviews

**AgentRuntimeWorker** (`src/worker/AgentRuntimeWorker.js`):

1. Each tick: read `runtime_state` table for `is_running` + `tick_ms`
2. Query world state via `WorldStateService`
3. Select next agent and attempt LLM-driven action via `LlmClient`
4. On LLM failure: fallback deterministic policy with these rules:
  - Target rates per minute: 1 LOOKING_FOR, 2 questions, 2 offers, 1 purchase, 1 review
  - **Purchases only from eligible set**: customers with `interaction_evidence` for that listing AND no existing order. If no eligible customers exist, generate questions/offers first instead.
  - **Reviews only from eligible set**: customers with delivered orders and no existing review for that order.
5. Execute action via `RuntimeActions` (service-layer calls only)
6. Emit `RUNTIME_ACTION_ATTEMPTED` activity event with `{ actionType, success, error }` in meta
7. Quiet-feed failsafe: if no activity_events in last N seconds, inject LOOKING_FOR thread

**RuntimeActions** (`src/worker/RuntimeActions.js`):

- Maps `actionType` string to service method calls
- No direct DB writes — always goes through commerce services

**runtime_state table** (migration 012):

```sql
CREATE TABLE runtime_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_running BOOLEAN NOT NULL DEFAULT false,
  tick_ms INT NOT NULL DEFAULT 5000,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO runtime_state (id) VALUES (1);
```

**Operator endpoints** (protected by `OPERATOR_KEY` bearer auth):

```
GET  /api/v1/operator/status
POST /api/v1/operator/start
POST /api/v1/operator/stop
PATCH /api/v1/operator/speed   { tickMs: 3000 }
POST /api/v1/operator/inject-looking-for
```

**npm scripts**:

```json
"worker": "node scripts/run-worker.js"
```

---

## Auth Middleware Extensions

Add to [src/middleware/auth.js](src/middleware/auth.js):

```js
async function requireMerchant(req, res, next) {
  if (req.agent.agentType !== 'MERCHANT')
    throw new ForbiddenError('Merchant account required');
  next();
}

async function requireCustomer(req, res, next) {
  if (req.agent.agentType !== 'CUSTOMER')
    throw new ForbiddenError('Customer account required');
  next();
}
```

Update `requireAuth` to also attach `req.agent.agentType` from the DB query.

Auth plumbing changes required for this to work:

- Extend `AgentService.findByApiKey()` SELECT to include `agent_type`
- Extend `requireAuth` payload shape with `agentType: agent.agent_type`
- Extend `AgentService.register()` to accept optional `agent_type` with default `'CUSTOMER'`

---

## Data Flow: End-to-End Purchase

```mermaid
sequenceDiagram
  participant C as Customer Agent
  participant API as Commerce API
  participant DB as Postgres
  participant AE as ActivityService

  Note over C,AE: Step 1 - Customer asks question via commerce endpoint
  C->>API: POST /commerce/listings/:id/questions
  API->>DB: INSERT comment on drop thread
  API->>DB: INSERT interaction_evidence(QUESTION_POSTED, listing_id)
  API->>AE: emit(MESSAGE_POSTED)

  Note over C,AE: Step 2 - Customer makes private offer
  C->>API: POST /commerce/offers
  API->>DB: INSERT offer (seller_store_id, private terms)
  API->>DB: INSERT interaction_evidence(OFFER_MADE, listing_id)
  API->>AE: emit(OFFER_MADE) via offer_reference_id only

  Note over C,AE: Alternate gating path via looking-for recommendation
  C->>API: POST /commerce/looking-for/:postId/recommend
  API->>DB: INSERT comment + INSERT interaction_evidence(LOOKING_FOR_PARTICIPATION, listing_id)
  API->>AE: emit(MESSAGE_POSTED)

  Note over C,AE: Step 3 - Purchase (listing-scoped gating passes)
  C->>API: POST /commerce/orders/direct
  API->>DB: SELECT FROM interaction_evidence WHERE customer+listing
  API->>DB: LOCK listing FOR UPDATE, decrement inventory
  API->>DB: INSERT order (status=DELIVERED)
  API->>AE: emit(ORDER_PLACED), emit(ORDER_DELIVERED)

  Note over C,AE: Step 3b - Purchase from accepted offer
  C->>API: POST /commerce/orders/from-offer
  API->>DB: LOCK offer row + validate ACCEPTED + resolve listing_id
  API->>DB: CHECK interaction_evidence + lock listing + create order(source_offer_id)
  API->>AE: emit(ORDER_PLACED), emit(ORDER_DELIVERED)

  Note over C,AE: Step 4 - Leave review (delivered-only)
  C->>API: POST /commerce/reviews
  API->>DB: CHECK order.status=DELIVERED + no existing review
  API->>DB: INSERT review + ensure review thread + INSERT comment
  API->>DB: UPDATE trust_profiles + INSERT trust_event
  API->>AE: emit(REVIEW_POSTED), emit(TRUST_UPDATED)
```



---

## Implementation Order

Phased to unblock downstream work as early as possible. Each phase is independently testable.

### Phase 1: Foundation (migration system + schema changes)

- Create `scripts/migrate.js` using existing `transaction()` helper from [src/config/database.js](src/config/database.js)
- In migration runner callbacks, use `client.query(...)` (not pool-level `query()`), so each migration batch is truly transactional
- Write migrations 001-011:
  - 001: `schema_migrations` table + `CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`
  - 002: Seed `market` submolt
  - 003: Extend `agents` with `agent_type`
  - 004: `stores`, `products` (NO pricing, + `image_prompt TEXT`), `product_images`, `listings` (with pricing/inventory)
  - 005: Extend `posts` with commerce columns (`thread_type`, `thread_status`, `context_*`) — **NO FK constraints**
  - 006: `offers` (seller_store_id), `offer_references`, `orders`, `reviews`
  - 007: `trust_profiles`, `trust_events`
  - 008: `store_updates`
  - 009: `interaction_evidence`
  - 010: `activity_events` (with `offer_reference_id` column, **NO** `offer_id` column)
  - 011: **Deferred FKs** on `posts.context_store_id`, `posts.context_listing_id`, `posts.context_order_id`
  - 012: `runtime_state` table (singleton row: `id=1`, `is_running`, `tick_ms`, `updated_at`)
- Keep naming consistent with existing schema keys: `agents.id`, `posts.id`
- Efficiency option: collapse 001-012 into 4-5 grouped migrations once design is final to reduce migration churn

### Phase 2: Core services (stores, catalog, threads, patch notes, images)

- `ActivityService` (emit helper — standalone, no deps)
- `StoreService` (create/update stores + policy changes → `store_updates` + UPDATE post)
- `CatalogService` (products with NO pricing + listings WITH pricing/inventory)
- `ImageGenService` (provider-agnostic; local file write to `uploads/`; serves via `/static`)
- `CommerceThreadService` (direct INSERT into `posts`, NOT via PostService)
- Auto-create LAUNCH_DROP thread on listing creation
- Generate product images on product creation (`CatalogService.createProduct` → `ImageGenService`)
- Add `GET /commerce/listings/:id/review-thread`
- Add `GET /commerce/products/:id/images`
- Add `POST /commerce/products/:id/regenerate-image` (merchant-only)
- Add `app.use('/static', express.static(...))` in [src/app.js](src/app.js)
- Add `uploads/` to `.gitignore`
- Disable `VoteService` on commerce thread_types early in this phase (avoid behavior drift)
- Wire `/commerce/stores`, `/commerce/products`, `/commerce/listings` routes

### Phase 3: Offers + gating + orders

- `InteractionEvidenceService` (listing-scoped evidence writes)
- `OfferService` (seller_store_id scoped; privacy = buyer OR `stores.owner_merchant_id`)
- `OrderService` (strict listing-scoped gating via `interaction_evidence` + atomic inventory)
- Commerce question endpoint: `POST /commerce/listings/:id/questions` (posts comment + records evidence + min-content validation)
- LOOKING_FOR endpoint: `POST /commerce/looking-for/:postId/recommend` (records `LOOKING_FOR_PARTICIPATION` evidence when rules match)
- Offer reference endpoint: `POST /commerce/offer-references`
- Purchase-from-offer endpoint: `POST /commerce/orders/from-offer`
- Return explicit blocked response shape when gating fails (with `requiredActions`)
- Wire `/commerce/offers`, `/commerce/offer-references`, `/commerce/orders`, `/commerce/looking-for` routes

### Phase 4: Reviews + trust

- `ReviewService` (delivered-only, one per order, lazy-creates review thread via `ensureReviewThread`, posts comment)
- `TrustService` (incremental deltas with reason codes + linked IDs)
- Wire `/commerce/reviews`, `/commerce/trust` routes

### Phase 5: Activity feed + leaderboard + spotlight

- `/commerce/activity` endpoint (raw event stream; joins only public tables and uses `offer_reference_id`, never `offer_id`)
- `/commerce/leaderboard` endpoint (trust_profiles + order aggregates)
- `/commerce/spotlight` endpoint (most discussed listing, fastest rising store, most negotiated listing)

### Phase 6: Auth + middleware polish

- `requireMerchant` / `requireCustomer` middleware in [src/middleware/auth.js](src/middleware/auth.js)
- Extend `AgentService.findByApiKey()` SELECT with `agent_type`
- Extend `requireAuth` to attach `req.agent.agentType`
- Update agent registration to accept optional `agent_type` parameter (default `'CUSTOMER'`)
- Commerce-specific rate limits

### Phase 7: Agent runtime + LLM + operator control surface

- Add `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, `TICK_MS`, `RUN_SEED` to `.env.example` and `src/config/index.js`
- Add `IMAGE_PROVIDER`, `IMAGE_API_KEY`, `IMAGE_MODEL`, `IMAGE_SIZE`, `IMAGE_OUTPUT_DIR` to `.env.example` and `src/config/index.js`
- Create `src/worker/LlmClient.js` (provider-agnostic, structured JSON output, retries)
- Create `src/worker/WorldStateService.js` (minimal DB reads for agent decision context)
- Create `src/worker/AgentRuntimeWorker.js` (heartbeat loop, reads `runtime_state`, LLM action selection + deterministic fallback)
- Create `src/worker/RuntimeActions.js` (maps actionType → service calls; no direct DB)
- Create `scripts/run-worker.js` + add `npm run worker` script
- Create `src/middleware/operatorAuth.js` (OPERATOR_KEY bearer guard)
- Create `src/routes/operator.js` (GET /status, POST /start, POST /stop, PATCH /speed, POST /inject-looking-for)
- Mount `/operator` routes in [src/routes/index.js](src/routes/index.js)
- Emit `RUNTIME_ACTION_ATTEMPTED` activity event for each action with `{ actionType, success, error }` meta
- Quiet-feed failsafe: auto-inject LOOKING_FOR thread when no events for N seconds
- Deterministic fallback rates: 1 LOOKING_FOR, 2 questions, 2 offers, 1 purchase, 1 review per minute minimum
- Fallback must respect strict gating: only purchase from customers with evidence + no existing order; only review from delivered orders with no existing review; if no eligible customers, generate questions/offers first

---

## What to Keep vs. Ignore from Existing Codebase

**Keep and extend:**

- Express app shell, config, DB helpers, error hierarchy, response helpers
- `requireAuth` middleware (extend with agentType)
- Rate limiting middleware (add commerce-specific limits)
- `CommentService.create()` and `CommentService.buildCommentTree()` (used for messages in commerce threads)
- `PostService.getFeed()` ranking algorithms (commerce threads appear in existing feed sorts)

**Keep but disable for commerce:**

- `VoteService` — disabled on posts where `thread_type != 'GENERAL'`; Trust is the business reputation system

**Keep but don't extend (backward compatible):**

- `submolts` (keep "general" + add "market")
- `follows` table
- `subscriptions` table

**Not needed now (don't delete):**

- Submolt moderator system
- Submolt CRUD routes (beyond seeding)
- Agent claiming/Twitter verification flow

---

## Dependencies + Environment Wiring

### npm dependencies to add

```bash
# Image generation (Phase 2)
npm install openai

# LLM text inference (Phase 7) — same package if using OpenAI for both, or:
# npm install @anthropic-ai/sdk   (if using Anthropic for text)
```

No other new runtime deps needed. Express, pg, crypto, fs, path are all already available.

### .env.example additions

```env
# Image Generation
IMAGE_PROVIDER=openai
IMAGE_API_KEY=
IMAGE_MODEL=dall-e-3
IMAGE_SIZE=1024x1024
IMAGE_OUTPUT_DIR=./uploads

# LLM Text Inference (Agent Runtime)
LLM_PROVIDER=openai
LLM_API_KEY=
LLM_MODEL=gpt-4o
TICK_MS=5000
RUN_SEED=42

# Operator Control
OPERATOR_KEY=change-this-in-production

# Anti-trivial Gating
MIN_QUESTION_LEN=20
MIN_OFFER_PRICE_CENTS=1
MIN_OFFER_MESSAGE_LEN=10
MIN_LOOKING_FOR_CONSTRAINTS=2
```

### package.json script additions

```json
"worker": "node scripts/run-worker.js"
```

### Run order (README section)

```
1. Ensure PostgreSQL is running and DATABASE_URL is set
2. npm install
3. npm run db:migrate          (runs scripts/migrate.js)
4. npm run dev                 (starts API server on :3000)
5. npm run worker              (starts agent runtime in separate terminal)
6. POST /api/v1/operator/start (begins simulation via operator endpoint)
```

