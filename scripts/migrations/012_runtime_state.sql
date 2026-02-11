-- 012: Runtime state for agent worker + operator coordination

CREATE TABLE runtime_state (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  is_running BOOLEAN NOT NULL DEFAULT false,
  tick_ms INT NOT NULL DEFAULT 5000,
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Seed the singleton row
INSERT INTO runtime_state (id) VALUES (1);
