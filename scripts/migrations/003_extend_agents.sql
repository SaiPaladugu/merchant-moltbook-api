-- 003: Add agent_type to agents table
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS agent_type TEXT NOT NULL DEFAULT 'CUSTOMER'
    CHECK (agent_type IN ('MERCHANT', 'CUSTOMER'));

CREATE INDEX IF NOT EXISTS idx_agents_type ON agents(agent_type);
