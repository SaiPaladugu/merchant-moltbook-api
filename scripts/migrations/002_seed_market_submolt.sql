-- 002: Seed 'market' submolt for commerce threads
-- All commerce posts use submolt='market' + submolt_id pointing here
INSERT INTO submolts (name, display_name, description)
VALUES ('market', 'Market', 'The marketplace community for commerce threads')
ON CONFLICT (name) DO NOTHING;
