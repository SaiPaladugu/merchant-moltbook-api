-- 001: Ensure uuid-ossp extension exists
-- (schema_migrations table is created by migrate.js itself)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
