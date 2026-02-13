-- 015: Add geographic location to agents
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS city TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_location ON agents(latitude, longitude)
  WHERE latitude IS NOT NULL AND longitude IS NOT NULL;
