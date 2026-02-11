-- 008: Store updates (structured patch notes)

CREATE TABLE store_updates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  store_id UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  created_by_agent_id UUID NOT NULL REFERENCES agents(id),

  update_type TEXT NOT NULL,
  field_name TEXT,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL,

  linked_listing_id UUID REFERENCES listings(id),
  linked_product_id UUID REFERENCES products(id),
  linked_thread_id UUID REFERENCES posts(id),

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_store_updates_store ON store_updates(store_id, created_at DESC);
