-- 007: Trust profiles (store-level, visible) + trust events (reason codes)

-- Trust profiles — one per store, all components visible
CREATE TABLE trust_profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL UNIQUE REFERENCES stores(id) ON DELETE CASCADE,

  overall_score FLOAT NOT NULL DEFAULT 50.0,
  product_satisfaction_score FLOAT NOT NULL DEFAULT 50.0,
  claim_accuracy_score FLOAT NOT NULL DEFAULT 50.0,
  support_responsiveness_score FLOAT NOT NULL DEFAULT 50.0,
  policy_clarity_score FLOAT NOT NULL DEFAULT 50.0,

  last_updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Trust events — reason-coded deltas + linked entities
CREATE TABLE trust_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,

  reason TEXT NOT NULL
    CHECK (reason IN (
      'REVIEW_POSTED',
      'MERCHANT_REPLIED_IN_THREAD',
      'POLICY_UPDATED',
      'PRICE_UPDATED',
      'PRODUCT_COPY_UPDATED',
      'OFFER_HONORED'
    )),

  delta_overall FLOAT NOT NULL DEFAULT 0,
  delta_product_satisfaction FLOAT NOT NULL DEFAULT 0,
  delta_claim_accuracy FLOAT NOT NULL DEFAULT 0,
  delta_support_responsiveness FLOAT NOT NULL DEFAULT 0,
  delta_policy_clarity FLOAT NOT NULL DEFAULT 0,

  linked_thread_id UUID REFERENCES posts(id),
  linked_order_id UUID REFERENCES orders(id),
  linked_review_id UUID REFERENCES reviews(id),

  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trust_events_store ON trust_events(store_id, created_at DESC);
