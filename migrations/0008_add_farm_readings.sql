-- Migration number: 0008 	 2026-11-22T08:00:00.000Z

-- Metered output of farms too small to be dispatched, which the model uses
-- in place of its farm array whenever there are readings (see
-- src/production/ranui.ts). Times are Unix milliseconds.
CREATE TABLE IF NOT EXISTS farm_readings (
    farm TEXT NOT NULL,
    time INTEGER NOT NULL,
    mw REAL NOT NULL,
    PRIMARY KEY (farm, time)
);

-- How many readings a day had, and the latest, when they were last stored
-- and when it was last estimated: a day is estimated again once they differ.
ALTER TABLE production_days ADD COLUMN metered TEXT;
ALTER TABLE production_days ADD COLUMN estimated_metered TEXT;
