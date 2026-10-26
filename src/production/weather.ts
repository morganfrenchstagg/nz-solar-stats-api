import { averagePixels, blendIrradiance, type WeatherPoints } from "./blend";
import { PANEL_AZIMUTH_DEGREES, PANEL_TILT_DEGREES } from "./estimate";

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_SATELLITE_URL = "https://satellite-api.open-meteo.com/v1/archive";
// Every location (and satellite pixel) counts against Open-Meteo's 10,000
// free calls a day. The forecast for all GXPs is refreshed at most every three
// hours (125 × 8 calls), and the satellite's ~345 pixels at most hourly while
// the sun's up (about 345 × 14), so a day of steady use stays near 6,000. A
// day that's over doesn't change, so its weather is kept for good, unless a
// GXP's points have moved since (see gxpWeatherPoints).
const MAX_FORECAST_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_SATELLITE_AGE_MS = 60 * 60 * 1000;
// Himawari readings arrive about half an hour after they're taken.
const SATELLITE_DELAY_MS = 60 * 60 * 1000;
// Keeps request URLs to a sensible length.
const LOCATIONS_PER_REQUEST = 100;

// Open-Meteo only has weather from about three months ago to two weeks ahead.
export class WeatherUnavailableError extends Error {}
// Open-Meteo failed, or sent weather with gaps. Worth retrying, never caching:
// a past day's weather is kept for good.
export class WeatherFetchError extends Error {}

// A GXP and the points its weather is taken at (see gxpWeatherPoints).
export interface WeatherLocation extends WeatherPoints {
	id: string;
}

// A day's 15-minute weather at each location.
export interface DayWeather {
	date: string; // NZ date, YYYY-MM-DD
	fetchedAt: string;
	times: number[]; // epoch milliseconds
	locations: Record<string, { irradianceWm2: number[]; temperatureC: number[] }>;
	// Irradiance up to here is from the satellite, after it the forecast.
	observedUntil: number | null;
}

// Where each location's weather was taken (see forecastPoint and
// satellitePixels), so a cached day is refetched once a GXP's points move.
type TakenAt = Record<string, string>;

type Forecast = Omit<DayWeather, "observedUntil"> & { points: TakenAt };

// Each location's satellite irradiance, averaged over its pixels, every 10 minutes.
interface SatelliteDay {
	date: string;
	fetchedAt: string;
	times: number[];
	locations: Record<string, (number | null)[]>;
	pixels: TakenAt;
}

interface OpenMeteoForecast {
	minutely_15: {
		time: number[];
		global_tilted_irradiance_instant: (number | null)[];
		temperature_2m: (number | null)[];
	};
}

interface OpenMeteoSatellite {
	hourly: { time: number[]; global_tilted_irradiance_instant: (number | null)[] };
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

// The day's weather, with satellite irradiance for whatever has already
// happened and the forecast for the rest.
export async function getWeather(
	db: D1Database,
	locations: WeatherLocation[],
	date: string,
	now: Date,
): Promise<DayWeather> {
	const forecast = await getForecast(db, locations, date, now);
	const satellite = await getSatellite(db, locations, date, now, forecast);
	if (!satellite) return { ...forecast, observedUntil: null };

	let observedUntil: number | null = null;
	const blended = Object.fromEntries(
		locations.map(({ id }) => {
			const { irradianceWm2, temperatureC } = forecast.locations[id];
			const blend = blendIrradiance(satellite.times, satellite.locations[id], forecast.times, irradianceWm2);
			if (blend.observedUntil !== null) observedUntil = Math.max(observedUntil ?? 0, blend.observedUntil);
			return [id, { irradianceWm2: blend.irradianceWm2, temperatureC }];
		}),
	);
	return { ...forecast, locations: blended, observedUntil };
}

async function getForecast(
	db: D1Database,
	locations: WeatherLocation[],
	date: string,
	now: Date,
): Promise<Forecast> {
	const cached = await db
		.prepare("SELECT forecast FROM weather_forecasts WHERE nz_date = ?")
		.bind(date)
		.first<string>("forecast");
	const previous: Forecast | null = cached ? JSON.parse(cached) : null;
	if (previous && takenAt(previous.points, locations, forecastPoint)) {
		const fetchedAt = new Date(previous.fetchedAt);
		// A forecast fetched after its day was over is final.
		const fresh = nzDate(fetchedAt) > date || now.getTime() - fetchedAt.getTime() < MAX_FORECAST_AGE_MS;
		if (fresh) return previous;
	}

	let forecast: Forecast;
	try {
		forecast = await fetchForecast(locations, date, now);
	} catch (error) {
		// Open-Meteo no longer has a day whose GXP points have moved since it
		// was cached: their weather from where they used to be beats none.
		if (error instanceof WeatherUnavailableError && previous && hasEvery(previous.locations, locations)) {
			return previous;
		}
		throw error;
	}
	await db
		.prepare("INSERT OR REPLACE INTO weather_forecasts (nz_date, forecast) VALUES (?, ?)")
		.bind(date, JSON.stringify(forecast))
		.run();
	return forecast;
}

// The satellite irradiance so far, or null if none of the day's sunlight has
// happened yet. The forecast still gives an estimate without it, so a failure
// falls back to an older copy, or to nothing.
async function getSatellite(
	db: D1Database,
	locations: WeatherLocation[],
	date: string,
	now: Date,
	forecast: Forecast,
): Promise<SatelliteDay | null> {
	const sunlit = forecast.times.filter((_, i) =>
		Object.values(forecast.locations).some((location) => location.irradianceWm2[i] > 0),
	);
	if (sunlit.length === 0 || now.getTime() < sunlit[0]) return null;

	const cached = await db
		.prepare("SELECT data FROM satellite_irradiance WHERE nz_date = ?")
		.bind(date)
		.first<string>("data");
	const previous: SatelliteDay | null = cached ? JSON.parse(cached) : null;
	if (previous && takenAt(previous.pixels, locations, satellitePixels)) {
		const fetchedAt = Date.parse(previous.fetchedAt);
		// Fetched after the day's last sunlight had arrived, it's final.
		const final = fetchedAt >= sunlit[sunlit.length - 1] + SATELLITE_DELAY_MS;
		if (final || now.getTime() - fetchedAt < MAX_SATELLITE_AGE_MS) return previous;
	}

	try {
		const satellite = await fetchSatellite(locations, date, now);
		await db
			.prepare("INSERT OR REPLACE INTO satellite_irradiance (nz_date, data) VALUES (?, ?)")
			.bind(date, JSON.stringify(satellite))
			.run();
		return satellite;
	} catch (error) {
		console.warn(`No satellite irradiance for ${date}: ${(error as Error).message}`);
		// Even from pixels a GXP has since moved from, as long as it has them all.
		return previous && hasEvery(previous.locations, locations) ? previous : null;
	}
}

async function fetchForecast(locations: WeatherLocation[], date: string, now: Date): Promise<Forecast> {
	const forecasts: OpenMeteoForecast[] = [];
	for (const batch of batches(locations)) {
		const res = await fetch(
			`${OPEN_METEO_FORECAST_URL}?${new URLSearchParams({
				...coordinates(batch.map((location) => location.forecast)),
				minutely_15: "global_tilted_irradiance_instant,temperature_2m",
				...sharedParams(date),
			})}`,
		);
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
		forecasts.push(...(Array.isArray(body) ? body : [body]));
	}
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
			locations.map((location, i) => [
				location.id,
				{
					irradianceWm2: forecasts[i].minutely_15.global_tilted_irradiance_instant as number[],
					temperatureC: forecasts[i].minutely_15.temperature_2m as number[],
				},
			]),
		),
		points: Object.fromEntries(locations.map((location) => [location.id, forecastPoint(location)])),
	};
}

// Himawari-9 irradiance on the model's panel, every 10 minutes on a ~5 km
// grid, averaged over each location's pixels by their weights. Readings not
// taken yet come back as null.
async function fetchSatellite(locations: WeatherLocation[], date: string, now: Date): Promise<SatelliteDay> {
	const pixels = locations.flatMap((location) => location.pixels.map((pixel) => ({ ...pixel, id: location.id })));
	const readings: OpenMeteoSatellite[] = [];
	for (const batch of batches(pixels)) {
		const res = await fetch(
			`${OPEN_METEO_SATELLITE_URL}?${new URLSearchParams({
				...coordinates(batch),
				hourly: "global_tilted_irradiance_instant",
				temporal_resolution: "native",
				models: "jma_jaxa_himawari",
				...sharedParams(date),
			})}`,
		);
		if (!res.ok) throw new WeatherFetchError(`Open-Meteo satellite request failed (${res.status}): ${await res.text()}`);
		const body = await res.json<OpenMeteoSatellite | OpenMeteoSatellite[]>();
		readings.push(...(Array.isArray(body) ? body : [body]));
	}
	if (readings.every(({ hourly }) => hourly.global_tilted_irradiance_instant.every((value) => value === null))) {
		throw new WeatherFetchError("every reading was empty");
	}

	return {
		date,
		fetchedAt: now.toISOString(),
		times: readings[0].hourly.time.map((seconds) => seconds * 1000),
		locations: Object.fromEntries(
			locations.map(({ id }) => {
				const own = pixels.map((pixel, i) => [pixel, readings[i]] as const).filter(([pixel]) => pixel.id === id);
				return [
					id,
					averagePixels(
						own.map(([, { hourly }]) => hourly.global_tilted_irradiance_instant),
						own.map(([pixel]) => pixel.weight),
					),
				];
			}),
		),
		pixels: Object.fromEntries(locations.map((location) => [location.id, satellitePixels(location)])),
	};
}

// Where a location's forecast and satellite readings are taken, as sent to
// Open-Meteo, with each pixel's weight in the average.
function forecastPoint({ forecast }: WeatherLocation): string {
	return `${forecast.lat.toFixed(4)},${forecast.long.toFixed(4)}`;
}

function satellitePixels({ pixels }: WeatherLocation): string {
	return pixels.map((pixel) => `${pixel.lat.toFixed(4)},${pixel.long.toFixed(4)},${pixel.weight}`).join(";");
}

// Whether a cached day has every location's weather, taken where it's wanted now.
// Days cached before points were recorded have none, so they're refetched once.
function takenAt(
	cached: TakenAt | undefined,
	locations: WeatherLocation[],
	where: (location: WeatherLocation) => string,
): boolean {
	return cached !== undefined && locations.every((location) => cached[location.id] === where(location));
}

function hasEvery(cached: Record<string, unknown>, locations: WeatherLocation[]): boolean {
	return locations.every((location) => location.id in cached);
}

function coordinates(points: { lat: number; long: number }[]) {
	return {
		latitude: points.map((point) => point.lat.toFixed(4)).join(","),
		longitude: points.map((point) => point.long.toFixed(4)).join(","),
	};
}

function sharedParams(date: string) {
	return {
		tilt: String(PANEL_TILT_DEGREES),
		azimuth: String(PANEL_AZIMUTH_DEGREES),
		// The NZ day, with times returned as UTC instants so DST can't shift them.
		timezone: "Pacific/Auckland",
		start_date: date,
		end_date: date,
		timeformat: "unixtime",
	};
}

function batches<T>(items: T[]): T[][] {
	const result: T[][] = [];
	for (let start = 0; start < items.length; start += LOCATIONS_PER_REQUEST) {
		result.push(items.slice(start, start + LOCATIONS_PER_REQUEST));
	}
	return result;
}
