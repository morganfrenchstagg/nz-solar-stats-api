-- Migration number: 0002 	 2026-10-24T09:00:00.000Z

-- GXPs from the electricitymap substations list.
CREATE TABLE IF NOT EXISTS gxps (
    site_id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    island TEXT NOT NULL,
    lat REAL NOT NULL,
    long REAL NOT NULL
);

-- Installed solar per EMI root NSP at each month end. dispatched_mw is the part of
-- installed_mw that belongs to solar farms the System Operator dispatches, which
-- public generation data already counts.
CREATE TABLE IF NOT EXISTS solar_capacity (
    nsp TEXT NOT NULL,
    gxp TEXT NOT NULL,
    month_end TEXT NOT NULL,
    icp_count INTEGER NOT NULL,
    installed_mw REAL NOT NULL,
    dispatched_mw REAL NOT NULL,
    distributed_mw REAL GENERATED ALWAYS AS (round(installed_mw - dispatched_mw, 3)) VIRTUAL,
    PRIMARY KEY (nsp, month_end)
);
CREATE INDEX IF NOT EXISTS solar_capacity_gxp_month_end ON solar_capacity (gxp, month_end);

-- The EMI capacity steps attributed to each dispatched solar farm.
CREATE TABLE IF NOT EXISTS dispatched_solar_steps (
    node TEXT NOT NULL,
    name TEXT NOT NULL,
    nsp TEXT NOT NULL,
    month_end TEXT NOT NULL,
    mw REAL NOT NULL,
    PRIMARY KEY (node, month_end)
);

CREATE TABLE IF NOT EXISTS capacity_job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at TEXT NOT NULL,
    latest_month_end TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    changed INTEGER NOT NULL
);
