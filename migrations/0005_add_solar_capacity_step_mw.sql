-- Migration number: 0005 	 2026-10-26T06:00:00.000Z

-- Distributed capacity that arrived in a farm-sized step this month at this
-- NSP, such as a solar farm too small to be dispatched. It's part of
-- distributed_mw, but a one-off rather than part of the growth trend.
ALTER TABLE solar_capacity ADD COLUMN step_mw REAL NOT NULL DEFAULT 0;
