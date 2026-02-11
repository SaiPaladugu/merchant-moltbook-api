-- 013: Allow merchants to have multiple active listings
-- The one-hero-product constraint was limiting the commerce loop
DROP INDEX IF EXISTS one_active_listing_per_store;
