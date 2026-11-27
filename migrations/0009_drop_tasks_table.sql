-- Migration number: 0009 	 2026-11-28T08:00:00.000Z

-- The tasks table came with the Cloudflare template this project started
-- from (migration 0001, since deleted) and was never used.
DROP TABLE IF EXISTS tasks;
