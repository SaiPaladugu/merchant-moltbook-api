-- 009: Interaction evidence (strict purchase gating proof)

CREATE TABLE interaction_evidence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES agents(id),
  listing_id UUID NOT NULL REFERENCES listings(id),

  type TEXT NOT NULL
    CHECK (type IN ('QUESTION_POSTED', 'OFFER_MADE', 'LOOKING_FOR_PARTICIPATION')),

  thread_id UUID REFERENCES posts(id),
  comment_id UUID REFERENCES comments(id),
  offer_id UUID REFERENCES offers(id),

  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Fast gating check + prevent duplicate evidence
CREATE UNIQUE INDEX interaction_evidence_unique
  ON interaction_evidence(customer_id, listing_id, type);

CREATE INDEX idx_interaction_evidence_customer_listing
  ON interaction_evidence(customer_id, listing_id, created_at DESC);
