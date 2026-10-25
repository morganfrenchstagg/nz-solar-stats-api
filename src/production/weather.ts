import { PANEL_AZIMUTH_DEGREES, PANEL_TILT_DEGREES } from "./estimate";

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
// Every location counts against Open-Meteo's 10,000 free calls a day, so a
// forecast for all GXPs is refreshed at most hourly (about 125 × 24 calls).
// A day that's over doesn't change, so its weather is kept for good.
const MAX_FORECAST_AGE_MS = 60 * 60 * 1000;

// Open-Meteo only has weather from about three months ago to two weeks ahead.
export class WeatherUnavailableError extends Error {}
// Open-Meteo failed, or sent weather with gaps. Worth retrying, never caching:
// a past day's weather is kept for good.
export class WeatherFetchError extends Error {}

export interface WeatherLocation {
	id: string;
	lat: number;
	long: number;
}

// A day's 15-minute weather at each location.
export interface DayWeather {
	date: string; // NZ date, YYYY-MM-DD
	fetchedAt: string;
	times: number[]; // epoch milliseconds
	locations: Record<string, { irradianceWm2: number[]; temperatureC: number[] }>;
}

interface OpenMeteoForecast {
	minutely_15: {
		time: number[];
		global_tilted_irradiance_instant: (number | null)[];
		temperature_2m: (number | null)[];
	};
}

export function nzDate(instant: Date): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(instant);
}

// The calendar day before a YYYY-MM-DD date.
export function previousDate(date: string): string {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() - 1);
	return day.toISOString().slice(0, 10);
}

export async function getWeather(
	db: D1Database,
	locations: WeatherLocation[],
	date: string,
	now: Date,
): Promise<DayWeather> {
	const cached = await db
		.prepare("SELECT forecast FROM weather_forecasts WHERE nz_date = ?")
		.bind(date)
		.first<string>("forecast");
	if (cached) {
		const weather: DayWeather = JSON.parse(cached);
		if (isFresh(weather, now) && locations.every((location) => location.id in weather.locations)) {
			return weather;
		}
	}

	const weather = await fetchWeather(locations, date, now);
	await db
		.prepare("INSERT OR REPLACE INTO weather_forecasts (nz_date, forecast) VALUES (?, ?)")
		.bind(date, JSON.stringify(weather))
		.run();
	return weather;
}

function isFresh(weather: DayWeather, now: Date): boolean {
	const fetchedAt = new Date(weather.fetchedAt);
	// Weather fetched after its day was over is final.
	if (nzDate(fetchedAt) > weather.date) return true;
	return now.getTime() - fetchedAt.getTime() < MAX_FORECAST_AGE_MS;
}

async function fetchWeather(
	locations: WeatherLocation[],
	date: string,
	now: Date,
): Promise<DayWeather> {
	const params = new URLSearchParams({
		latitude: locations.map((location) => location.lat.toFixed(4)).join(","),
		longitude: locations.map((location) => location.long.toFixed(4)).join(","),
		minutely_15: "global_tilted_irradiance_instant,temperature_2m",
		tilt: String(PANEL_TILT_DEGREES),
		azimuth: String(PANEL_AZIMUTH_DEGREES),
		// The NZ day, with times returned as UTC instants so DST can't shift them.
		timezone: "Pacific/Auckland",
		start_date: date,
		end_date: date,
		timeformat: "unixtime",
	});
	const res = await fetch(`${OPEN_METEO_FORECAST_URL}?${params}`);
	if (res.status === 400) {
		// e.g. "Parameter 'start_date' is out of allowed range from 2026-07-24 to 2026-11-09"
		const { reason } = await res.json<{ reason: string }>();
		throw new WeatherUnavailableError(`Open-Meteo has no weather for ${date}: ${reason}`);
	}
	if (!res.ok) {
		throw new WeatherFetchError(`Open-Meteo request failed (${res.status}): ${await res.text()}`);
	}
	// A single location comes back as an object rather than an array.
	const body = await res.json<OpenMeteoForecast | OpenMeteoForecast[]>();
	const forecasts = Array.isArray(body) ? body : [body];
	// Open-Meteo has been seen sending every value as null for a past day.
	const hasGaps = forecasts.some(({ minutely_15: forecast }) =>
		[...forecast.global_tilted_irradiance_instant, ...forecast.temperature_2m].includes(null),
	);
	if (hasGaps) {
		throw new WeatherFetchError(`Open-Meteo sent weather with gaps for ${date}; try again later`);
	}

	return {
		date,
		fetchedAt: now.toISOString(),
		times: forecasts[0].minutely_15.time.map((seconds) => seconds * 1000),
		locations: Object.fromEntries(
			locations.map((location, index) => {
				const forecast = forecasts[index].minutely_15;
				return [
					location.id,
					{
						irradianceWm2: forecast.global_tilted_irradiance_instant as number[],
						temperatureC: forecast.temperature_2m as number[],
					},
				];
			}),
		),
	};
}
