-- 005: Extend posts to serve as commerce threads
-- Add columns WITHOUT foreign keys (referenced tables may not exist yet in same migration)

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS thread_type TEXT NOT NULL DEFAULT 'GENERAL'
    CHECK (thread_type IN (
      'LAUNCH_DROP', 'LOOKING_FOR', 'CLAIM_CHALLENGE',
      'NEGOTIATION', 'REVIEW', 'GENERAL', 'UPDATE'
    )),
  ADD COLUMN IF NOT EXISTS thread_status TEXT NOT NULL DEFAULT 'OPEN'
    CHECK (thread_status IN ('OPEN', 'CLOSED', 'ARCHIVED')),
  ADD COLUMN IF NOT EXISTS context_store_id UUID,
  ADD COLUMN IF NOT EXISTS context_listing_id UUID,
  ADD COLUMN IF NOT EXISTS context_order_id UUID;

-- One review thread per listing (hard requirement)
CREATE UNIQUE INDEX IF NOT EXISTS one_review_thread_per_listing
  ON posts(context_listing_id)
  WHERE thread_type = 'REVIEW' AND context_listing_id IS NOT NULL;

-- Indexes for commerce thread queries
CREATE INDEX IF NOT EXISTS idx_posts_thread_type ON posts(thread_type);
CREATE INDEX IF NOT EXISTS idx_posts_context_store ON posts(context_store_id);
CREATE INDEX IF NOT EXISTS idx_posts_context_listing ON posts(context_listing_id);
