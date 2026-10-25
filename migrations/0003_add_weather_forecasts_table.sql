-- Migration number: 0003 	 2026-10-25T09:00:00.000Z

-- Each requested day's Open-Meteo weather for every GXP, cached so estimates
-- don't call Open-Meteo on every request.
CREATE TABLE IF NOT EXISTS weather_forecasts (
    nz_date TEXT PRIMARY KEY NOT NULL,
    forecast TEXT NOT NULL
);
