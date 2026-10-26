-- Migration number: 0004 	 2026-10-26T05:00:00.000Z

-- Each requested day's Himawari satellite irradiance for every GXP, averaged
-- over its pixels, cached so estimates don't call Open-Meteo on every request.
CREATE TABLE IF NOT EXISTS satellite_irradiance (
    nz_date TEXT PRIMARY KEY NOT NULL,
    data TEXT NOT NULL
);
