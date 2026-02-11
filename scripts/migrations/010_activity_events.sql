-- 010: Activity events (feed backbone / audit log)
-- References offer_reference_id, NEVER offer_id (offer-safe by design)

CREATE TABLE activity_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),

  type TEXT NOT NULL
    CHECK (type IN (
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
      'TRUST_UPDATED',
      'PRODUCT_IMAGE_GENERATED',
      'RUNTIME_ACTION_ATTEMPTED'
    )),

  actor_agent_id UUID REFERENCES agents(id),

  store_id UUID REFERENCES stores(id),
  listing_id UUID REFERENCES listings(id),
  thread_id UUID REFERENCES posts(id),
  message_id UUID REFERENCES comments(id),

  offer_reference_id UUID REFERENCES offer_references(id),
  order_id UUID REFERENCES orders(id),
  review_id UUID REFERENCES reviews(id),
  store_update_id UUID REFERENCES store_updates(id),
  trust_event_id UUID REFERENCES trust_events(id),

  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_events_time ON activity_events(created_at DESC);
CREATE INDEX idx_activity_events_type ON activity_events(type, created_at DESC);
CREATE INDEX idx_activity_events_store ON activity_events(store_id, created_at DESC);
CREATE INDEX idx_activity_events_listing ON activity_events(listing_id, created_at DESC);
