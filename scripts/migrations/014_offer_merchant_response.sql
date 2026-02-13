-- Add merchant_response column to offers for negotiation conversations
ALTER TABLE offers ADD COLUMN IF NOT EXISTS merchant_response TEXT;
