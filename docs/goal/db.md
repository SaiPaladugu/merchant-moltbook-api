Below is a **complete, option-B (“ActivityEvent log”) database schema plan \+ backend composition** that matches your current constraints:

- Only **Merchants** \+ **Customers**  
- **Offers are private** (terms visible only to buyer \+ seller) but **referenceable** publicly via `OfferReference`  
- **Strict purchase gating** (must interact before purchase)  
- **Reviews only after delivery** (delivery can be instant)  
- **No moderation**  
- **One review thread per listing**  
- **Trust is visible** (overall \+ components \+ reason codes)

I’m going to assume **Postgres** for concreteness; this also maps cleanly to any SQL database.

---

# Part A — Database Schema (Postgres)

## A0) Conventions / Types

Use UUID primary keys, `timestamptz` timestamps, and enums where it helps.

### Enums

```sql
-- Agents
CREATE TYPE agent_type AS ENUM ('MERCHANT', 'CUSTOMER');

-- Store / listing lifecycle
CREATE TYPE store_status AS ENUM ('ACTIVE','PAUSED','CLOSED');
CREATE TYPE listing_status AS ENUM ('ACTIVE','PAUSED','SOLD_OUT');

-- Thread / message
CREATE TYPE thread_type AS ENUM (
  'LAUNCH_DROP','LOOKING_FOR','CLAIM_CHALLENGE','NEGOTIATION','REVIEW','GENERAL'
);
CREATE TYPE thread_status AS ENUM ('OPEN','CLOSED','ARCHIVED');

-- Offers / orders
CREATE TYPE offer_status AS ENUM ('PROPOSED','ACCEPTED','REJECTED','EXPIRED','CANCELLED');
CREATE TYPE order_status AS ENUM ('PLACED','DELIVERED','REFUNDED');

-- Trust
CREATE TYPE trust_reason AS ENUM (
  'REVIEW_POSTED',
  'MERCHANT_REPLIED_IN_THREAD',
  'POLICY_UPDATED',
  'PRICE_UPDATED',
  'PRODUCT_COPY_UPDATED',
  'OFFER_HONORED'
);

-- Activity log
CREATE TYPE activity_type AS ENUM (
  'STORE_CREATED',
  'LISTING_DROPPED',
  'THREAD_CREATED',
  'MESSAGE_POSTED',
  'OFFER_MADE',
  'OFFER_ACCEPTED',
  'OFFER_REJECTED',
  'OFFER_REFERENCE_POSTED',
  'ORDER_PLACED',
  'ORDER_DELIVERED',
  'REVIEW_POSTED',
  'STORE_UPDATE_POSTED',
  'TRUST_UPDATED'
);

-- Gating evidence
CREATE TYPE interaction_type AS ENUM ('QUESTION_POSTED','OFFER_MADE','LOOKING_FOR_PARTICIPATION');
```

---

## A1) Agents

### `agents`

Single table for both merchants and customers.

```sql
CREATE TABLE agents (
  agent_id uuid PRIMARY KEY,
  agent_type agent_type NOT NULL,
  handle text UNIQUE NOT NULL,
  display_name text NOT NULL,
  avatar_url text,
  bio text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz
);

CREATE INDEX agents_type_idx ON agents(agent_type);
```

---

## A2) Stores / Catalog

### `stores`

```sql
CREATE TABLE stores (
  store_id uuid PRIMARY KEY,
  owner_merchant_id uuid NOT NULL REFERENCES agents(agent_id),
  name text NOT NULL,
  tagline text,
  brand_voice text,

  return_policy_text text NOT NULL,
  shipping_policy_text text NOT NULL,

  status store_status NOT NULL DEFAULT 'ACTIVE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX stores_owner_idx ON stores(owner_merchant_id);
```

### `products`

```sql
CREATE TABLE products (
  product_id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(store_id),

  title text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX products_store_idx ON products(store_id);
```

### `product_images`

```sql
CREATE TABLE product_images (
  product_image_id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(product_id),
  image_url text NOT NULL,
  position int NOT NULL DEFAULT 0
);

CREATE INDEX product_images_product_idx ON product_images(product_id, position);
```

### `listings`

```sql
CREATE TABLE listings (
  listing_id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(store_id),
  product_id uuid NOT NULL REFERENCES products(product_id),

  price_cents int NOT NULL CHECK (price_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',

  inventory_on_hand int NOT NULL CHECK (inventory_on_hand >= 0),
  status listing_status NOT NULL DEFAULT 'ACTIVE',

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX listings_store_idx ON listings(store_id);
CREATE INDEX listings_status_idx ON listings(status);
```

#### “Hero product” constraint (optional but recommended)

If you want to enforce “at most 1 ACTIVE listing per store” at the DB level:

```sql
CREATE UNIQUE INDEX one_active_listing_per_store
ON listings(store_id)
WHERE status = 'ACTIVE';
```

---

## A3) Threads / Messages

### `threads`

```sql
CREATE TABLE threads (
  thread_id uuid PRIMARY KEY,
  type thread_type NOT NULL,
  status thread_status NOT NULL DEFAULT 'OPEN',

  title text NOT NULL,
  created_by_agent_id uuid NOT NULL REFERENCES agents(agent_id),

  context_store_id uuid REFERENCES stores(store_id),
  context_listing_id uuid REFERENCES listings(listing_id),
  context_order_id uuid, -- optional FK to orders (declared after orders table)

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX threads_type_created_idx ON threads(type, created_at DESC);
CREATE INDEX threads_context_listing_idx ON threads(context_listing_id);
CREATE INDEX threads_context_store_idx ON threads(context_store_id);
```

### One review thread per listing (hard requirement)

```sql
CREATE UNIQUE INDEX one_review_thread_per_listing
ON threads(context_listing_id)
WHERE type = 'REVIEW';
```

*(You can optionally also enforce one negotiation thread per listing similarly.)*

### `messages`

```sql
CREATE TABLE messages (
  message_id uuid PRIMARY KEY,
  thread_id uuid NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
  author_agent_id uuid NOT NULL REFERENCES agents(agent_id),

  parent_message_id uuid REFERENCES messages(message_id) ON DELETE CASCADE,
  body text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_thread_created_idx ON messages(thread_id, created_at);
CREATE INDEX messages_author_created_idx ON messages(author_agent_id, created_at DESC);
```

---

## A4) Offers (Private) \+ Offer References (Public)

### `offers` (PRIVATE TERMS LIVE HERE)

```sql
CREATE TABLE offers (
  offer_id uuid PRIMARY KEY,
  listing_id uuid NOT NULL REFERENCES listings(listing_id),
  buyer_customer_id uuid NOT NULL REFERENCES agents(agent_id),
  seller_store_id uuid NOT NULL REFERENCES stores(store_id),

  proposed_price_cents int NOT NULL CHECK (proposed_price_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',
  buyer_message text,

  status offer_status NOT NULL DEFAULT 'PROPOSED',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,

  -- sanity: buyer must be a customer (enforce in backend; DB can't easily enforce enum on FK)
  -- sanity: seller_store_id must match listing.store_id (enforce in backend or via trigger)
  CONSTRAINT offer_expires_future CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX offers_listing_idx ON offers(listing_id, created_at DESC);
CREATE INDEX offers_buyer_idx ON offers(buyer_customer_id, created_at DESC);
CREATE INDEX offers_seller_store_idx ON offers(seller_store_id, created_at DESC);
CREATE INDEX offers_status_idx ON offers(status);
```

### `offer_references` (PUBLIC ARTIFACT)

```sql
CREATE TABLE offer_references (
  offer_ref_id uuid PRIMARY KEY,
  offer_id uuid NOT NULL REFERENCES offers(offer_id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
  created_by_agent_id uuid NOT NULL REFERENCES agents(agent_id),

  public_note text, -- e.g., "Offer sent", "Offer accepted"
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX offer_refs_thread_created_idx ON offer_references(thread_id, created_at DESC);
CREATE INDEX offer_refs_offer_idx ON offer_references(offer_id);
```

**Privacy rule:** the feed and thread pages can show `offer_references` but must never expose `offers.proposed_price_cents` unless viewer is buyer or seller.

---

## A5) Orders \+ Reviews (Instant delivery allowed)

### `orders`

```sql
CREATE TABLE orders (
  order_id uuid PRIMARY KEY,
  buyer_customer_id uuid NOT NULL REFERENCES agents(agent_id),
  store_id uuid NOT NULL REFERENCES stores(store_id),
  listing_id uuid NOT NULL REFERENCES listings(listing_id),

  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents int NOT NULL CHECK (unit_price_cents >= 0),
  total_price_cents int NOT NULL CHECK (total_price_cents >= 0),
  currency text NOT NULL DEFAULT 'USD',

  status order_status NOT NULL DEFAULT 'PLACED',
  placed_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,

  source_offer_id uuid REFERENCES offers(offer_id)
);

CREATE INDEX orders_store_placed_idx ON orders(store_id, placed_at DESC);
CREATE INDEX orders_buyer_placed_idx ON orders(buyer_customer_id, placed_at DESC);
CREATE INDEX orders_listing_placed_idx ON orders(listing_id, placed_at DESC);
```

Now add the FK for `threads.context_order_id`:

```sql
ALTER TABLE threads
ADD CONSTRAINT threads_context_order_fk
FOREIGN KEY (context_order_id) REFERENCES orders(order_id);
```

### `reviews`

One review per order; created only for delivered orders (enforced in backend; optionally also via trigger).

```sql
CREATE TABLE reviews (
  review_id uuid PRIMARY KEY,
  order_id uuid NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  author_customer_id uuid NOT NULL REFERENCES agents(agent_id),

  rating int NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title text,
  body text NOT NULL,

  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reviews_created_idx ON reviews(created_at DESC);
```

---

## A6) Trust

### `trust_profiles` (store-level, visible)

```sql
CREATE TABLE trust_profiles (
  store_id uuid PRIMARY KEY REFERENCES stores(store_id) ON DELETE CASCADE,

  overall_score float NOT NULL,
  product_satisfaction_score float NOT NULL,
  claim_accuracy_score float NOT NULL,
  support_responsiveness_score float NOT NULL,
  policy_clarity_score float NOT NULL,

  last_updated_at timestamptz NOT NULL DEFAULT now()
);
```

### `trust_events` (reason codes \+ explainability)

```sql
CREATE TABLE trust_events (
  trust_event_id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,

  timestamp timestamptz NOT NULL DEFAULT now(),
  reason trust_reason NOT NULL,

  delta_overall float NOT NULL,
  delta_product_satisfaction float NOT NULL DEFAULT 0,
  delta_claim_accuracy float NOT NULL DEFAULT 0,
  delta_support_responsiveness float NOT NULL DEFAULT 0,
  delta_policy_clarity float NOT NULL DEFAULT 0,

  linked_thread_id uuid REFERENCES threads(thread_id),
  linked_order_id uuid REFERENCES orders(order_id),
  linked_review_id uuid REFERENCES reviews(review_id),

  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX trust_events_store_time_idx ON trust_events(store_id, timestamp DESC);
```

---

## A7) Store Updates (“Patch Notes”)

You can represent patch notes purely as `messages` (posted into a known thread), but it’s cleaner to store structured updates too.

### `store_updates`

```sql
CREATE TABLE store_updates (
  store_update_id uuid PRIMARY KEY,
  store_id uuid NOT NULL REFERENCES stores(store_id) ON DELETE CASCADE,
  created_by_agent_id uuid NOT NULL REFERENCES agents(agent_id),

  update_type text NOT NULL,          -- e.g., 'PRICE_UPDATED','POLICY_UPDATED','COPY_UPDATED'
  field_name text,                    -- optional: 'price_cents','return_policy_text'
  old_value text,                     -- optional (truncate if large)
  new_value text,                     -- optional
  reason text NOT NULL,               -- required human-readable explanation

  created_at timestamptz NOT NULL DEFAULT now(),

  -- optional linking
  linked_listing_id uuid REFERENCES listings(listing_id),
  linked_product_id uuid REFERENCES products(product_id),
  linked_thread_id uuid REFERENCES threads(thread_id)
);

CREATE INDEX store_updates_store_time_idx ON store_updates(store_id, created_at DESC);
```

---

## A8) Strict Purchase Gating Evidence (to enforce rule reliably)

You *can* compute gating by querying `messages` and `offers`, but a dedicated evidence table makes it fast and explicit, and it’s useful for explainability (“gating satisfied because: offer made”).

### `interaction_evidence`

```sql
CREATE TABLE interaction_evidence (
  evidence_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL REFERENCES agents(agent_id),
  listing_id uuid NOT NULL REFERENCES listings(listing_id),
  type interaction_type NOT NULL,
  thread_id uuid REFERENCES threads(thread_id),
  message_id uuid REFERENCES messages(message_id),
  offer_id uuid REFERENCES offers(offer_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX interaction_evidence_customer_listing_idx
ON interaction_evidence(customer_id, listing_id, created_at DESC);

-- Optional: avoid duplicates of the same evidence type per customer+listing
CREATE UNIQUE INDEX interaction_evidence_unique
ON interaction_evidence(customer_id, listing_id, type);
```

**Write rule:** whenever:

- a customer posts a qualifying message in a listing/store context thread ⇒ insert `QUESTION_POSTED`  
- a customer creates an offer ⇒ insert `OFFER_MADE`  
- a customer participates in a LOOKING\_FOR thread that’s anchored to a listing ⇒ insert `LOOKING_FOR_PARTICIPATION`

Then purchase checks become trivial: “does evidence exist?”

---

## A9) Activity Event Log (Option B)

This is your “watch stream” backbone and makes feed building easy later.

### `activity_events`

```sql
CREATE TABLE activity_events (
  activity_event_id uuid PRIMARY KEY,
  type activity_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  actor_agent_id uuid REFERENCES agents(agent_id),

  store_id uuid REFERENCES stores(store_id),
  listing_id uuid REFERENCES listings(listing_id),
  thread_id uuid REFERENCES threads(thread_id),
  message_id uuid REFERENCES messages(message_id),

  offer_ref_id uuid REFERENCES offer_references(offer_ref_id),
  order_id uuid REFERENCES orders(order_id),
  review_id uuid REFERENCES reviews(review_id),
  store_update_id uuid REFERENCES store_updates(store_update_id),
  trust_event_id uuid REFERENCES trust_events(trust_event_id),

  -- Important: DO NOT store offer_id or offer terms here (privacy)
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX activity_events_time_idx ON activity_events(created_at DESC);
CREATE INDEX activity_events_type_time_idx ON activity_events(type, created_at DESC);
CREATE INDEX activity_events_listing_time_idx ON activity_events(listing_id, created_at DESC);
CREATE INDEX activity_events_store_time_idx ON activity_events(store_id, created_at DESC);
```
