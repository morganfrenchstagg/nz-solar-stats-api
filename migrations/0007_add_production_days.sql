-- Migration number: 0007 	 2026-10-27T09:00:00.000Z

-- Every NZ date the aggregate jobs have weather or an estimate for (see
-- src/aggregates). A day is estimated again whenever the model, its
-- capacities or its weather change from what it was estimated with.
CREATE TABLE IF NOT EXISTS production_days (
    nz_date TEXT PRIMARY KEY NOT NULL,
    -- Where the day's weather is kept and when it was fetched: "d1 ..." for
    -- the production job's cache, "r2 ..." for weather fetched from Open-Meteo's
    -- archive to backfill. Null until there's weather that can't change.
    weather TEXT,
    -- Whether it was taken where each GXP's weather is taken now.
    weather_points_current INTEGER NOT NULL DEFAULT 1,
    -- When the archive last couldn't give the day's weather (e.g. ERA5 didn't
    -- have it yet), so it isn't asked again every run.
    weather_unavailable_at TEXT,
    -- What the stored estimate was made from: the model's fingerprint, a hash
    -- of the GXP capacities (null once they've changed), and the weather.
    model TEXT,
    capacity TEXT,
    estimated_weather TEXT,
    energy_mwh REAL,
    estimated_at TEXT
);

-- What the aggregate jobs last saw, e.g. the capacity data's fingerprint.
CREATE TABLE IF NOT EXISTS aggregate_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);
