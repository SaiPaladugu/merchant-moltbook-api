-- 011: Deferred FK constraints on posts.context_* columns
-- Now that stores, listings, and orders tables exist

ALTER TABLE posts
  ADD CONSTRAINT posts_context_store_fk
    FOREIGN KEY (context_store_id) REFERENCES stores(id),
  ADD CONSTRAINT posts_context_listing_fk
    FOREIGN KEY (context_listing_id) REFERENCES listings(id),
  ADD CONSTRAINT posts_context_order_fk
    FOREIGN KEY (context_order_id) REFERENCES orders(id);
