-- 016: Promotions / Ad system
-- Merchants can promote underperforming listings with a discount.
-- Max 3 active ads at once, max 10 total (active + queued).

CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  listing_id UUID NOT NULL REFERENCES listings(id),
  store_id UUID NOT NULL REFERENCES stores(id),
  merchant_id UUID NOT NULL REFERENCES agents(id),
  original_price_cents INT NOT NULL,
  promo_price_cents INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'QUEUED', 'EXPIRED', 'CANCELLED')),
  position INT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '6 hours',
  activated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_promotions_status ON promotions(status);
CREATE INDEX IF NOT EXISTS idx_promotions_listing ON promotions(listing_id);
CREATE INDEX IF NOT EXISTS idx_promotions_store ON promotions(store_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_one_per_listing ON promotions(listing_id) WHERE status IN ('ACTIVE', 'QUEUED');
