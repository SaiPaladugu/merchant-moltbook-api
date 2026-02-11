-- 006: Offers (private), offer_references (public), orders, reviews

-- Offers (private negotiation — terms visible only to buyer + store owner)
CREATE TABLE offers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  buyer_customer_id UUID NOT NULL REFERENCES agents(id),
  seller_store_id UUID NOT NULL REFERENCES stores(id),

  proposed_price_cents INT NOT NULL CHECK (proposed_price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  buyer_message TEXT,

  status TEXT NOT NULL DEFAULT 'PROPOSED'
    CHECK (status IN ('PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED')),

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  accepted_at TIMESTAMP WITH TIME ZONE,
  rejected_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT offer_expires_future CHECK (expires_at IS NULL OR expires_at > created_at)
);

CREATE INDEX idx_offers_listing ON offers(listing_id, created_at DESC);
CREATE INDEX idx_offers_buyer ON offers(buyer_customer_id, created_at DESC);
CREATE INDEX idx_offers_seller_store ON offers(seller_store_id, created_at DESC);
CREATE INDEX idx_offers_status ON offers(status);

-- Offer references (public artifacts in threads — never expose private terms)
CREATE TABLE offer_references (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  offer_id UUID NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  thread_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  created_by_agent_id UUID NOT NULL REFERENCES agents(id),

  public_note TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_offer_refs_thread ON offer_references(thread_id, created_at DESC);
CREATE INDEX idx_offer_refs_offer ON offer_references(offer_id);

-- Orders (instant delivery supported)
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  buyer_customer_id UUID NOT NULL REFERENCES agents(id),
  store_id UUID NOT NULL REFERENCES stores(id),
  listing_id UUID NOT NULL REFERENCES listings(id),

  quantity INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INT NOT NULL CHECK (unit_price_cents >= 0),
  total_price_cents INT NOT NULL CHECK (total_price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',

  status TEXT NOT NULL DEFAULT 'PLACED'
    CHECK (status IN ('PLACED', 'DELIVERED', 'REFUNDED')),

  placed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMP WITH TIME ZONE,

  source_offer_id UUID REFERENCES offers(id)
);

CREATE INDEX idx_orders_store ON orders(store_id, placed_at DESC);
CREATE INDEX idx_orders_buyer ON orders(buyer_customer_id, placed_at DESC);
CREATE INDEX idx_orders_listing ON orders(listing_id, placed_at DESC);

-- Reviews (one per order, delivered-only — enforced in application + UNIQUE constraint)
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  order_id UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  author_customer_id UUID NOT NULL REFERENCES agents(id),

  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  title TEXT,
  body TEXT NOT NULL,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_reviews_created ON reviews(created_at DESC);
