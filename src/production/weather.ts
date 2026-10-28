import { averagePixels, blendIrradiance, resample, stepsThrough, type WeatherPoints } from "./blend";

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const OPEN_METEO_SATELLITE_URL = "https://satellite-api.open-meteo.com/v1/archive";
const OPEN_METEO_ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";
// Days too long ago for the forecast take their temperature (and sunlight
// where the satellite has none) from ERA5-Land's 0.1° grid, filled in from
// ERA5's 0.25° grid, hourly. It's about five days behind.
export const ARCHIVE_MODEL = "era5_seamless";
// Every location (and satellite pixel) counts against Open-Meteo's 10,000
// free calls a day. The forecast for all GXPs is refreshed at most every three
// hours (125 × 8 calls), and the satellite's ~310 pixels at most every half
// hour from 10am to 4pm, when most of the day's sunlight falls, and hourly
// otherwise while the sun's up (about 310 × 25 on December's long days), so a
// day of the production job stays under 9,000. Himawari readings usually
// reach Open-Meteo half an hour after they're taken, but some days hours
// after, so the pixels are only refetched once one of them has newer
// readings (see hasNewerReadings). A day that's over doesn't change, so its
// weather is kept for good, unless a GXP's points have moved since (see
// gxpWeatherPoints).
const MAX_FORECAST_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_SATELLITE_AGE_MS = 60 * 60 * 1000;
const MIDDAY_SATELLITE_AGE_MS = 30 * 60 * 1000;
// NZ hours, 10am up to 4pm.
const MIDDAY = { from: 10, to: 16 };
// Keeps request URLs to a sensible length.
const LOCATIONS_PER_REQUEST = 100;
// Bumped when what's cached changes shape, so older copies are fetched again.
export const CACHE_FORMAT = 2;
// Sunlight on flat ground, straight from the sun and from the rest of the sky.
// Three variables and the temperature still count as one Open-Meteo call.
const COMPONENTS = ["ghiWm2", "dniWm2", "dhiWm2"] as const;
const OPEN_METEO_VARIABLES = {
	ghiWm2: "shortwave_radiation_instant",
	dniWm2: "direct_normal_irradiance_instant",
	dhiWm2: "diffuse_radiation_instant",
} as const;

// Open-Meteo only has weather from about three months ago to two weeks ahead.
export class WeatherUnavailableError extends Error {}
// Open-Meteo failed, or sent weather with gaps. Worth retrying, never caching:
// a past day's weather is kept for good.
export class WeatherFetchError extends Error {}

// A GXP and the points its weather is taken at (see gxpWeatherPoints).
export interface WeatherLocation extends WeatherPoints {
	id: string;
}

type Component = (typeof COMPONENTS)[number];

// A location's weather at each step: sunlight in each component and the air
// temperature, at a point whose sun position the tilt maths uses.
export interface LocationWeather extends Record<Component, number[]> {
	lat: number;
	long: number;
	temperatureC: number[];
}

// A day's weather at each location, every 10 minutes (see STEP_MS).
export interface DayWeather {
	date: string; // NZ date, YYYY-MM-DD
	fetchedAt: string;
	times: number[]; // epoch milliseconds
	locations: Record<string, LocationWeather>;
	// Irradiance up to here is from the satellite, after it the forecast.
	observedUntil: number | null;
	// The Open-Meteo model the forecast part is from, if not the forecast API's.
	model?: string;
}

// Where each location's weather was taken (see forecastPoint and
// satellitePixels), so a cached day is refetched once a GXP's points move.
type TakenAt = Record<string, string>;

// Open-Meteo's 15-minute forecast, as cached, or for days long past ERA5's
// hourly reanalysis (`model`).
export type Forecast = Omit<DayWeather, "observedUntil"> & { format: number; points: TakenAt };

// Each location's satellite irradiance, averaged over its pixels, every 10 minutes.
export interface SatelliteDay {
	format: number;
	date: string;
	fetchedAt: string;
	times: number[];
	locations: Record<string, Record<Component, (number | null)[]>>;
	pixels: TakenAt;
}

type OpenMeteoSeries = { time: number[] } & Record<string, (number | null)[]>;

interface OpenMeteoForecast {
	minutely_15: OpenMeteoSeries;
}

interface OpenMeteoSatellite {
	hourly: OpenMeteoSeries;
}

interface OpenMeteoArchive {
	hourly: OpenMeteoSeries;
}

const NZ_DATE = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" });

export function nzDate(instant: Date): string {
	return NZ_DATE.format(instant);
}

function nzHour(instant: Date): number {
	const parts = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", hourCycle: "h23" })
		.formatToParts(instant);
	return Number(parts.find((part) => part.type === "hour")!.value);
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
	return blendWeather(forecast, satellite, locations);
}

// A day's weather at each location every 10 minutes, from its forecast and
// satellite readings however they were got.
export function blendWeather(
	forecast: Forecast,
	satellite: SatelliteDay | null,
	locations: WeatherLocation[],
): DayWeather {
	const times = stepsThrough(forecast.times);
	const onSteps = (values: number[]) => resample(forecast.times, values, times);

	let observedUntil: number | null = null;
	const blended = Object.fromEntries(
		locations.map(({ id }) => {
			const cached = forecast.locations[id];
			const location: LocationWeather = {
				lat: cached.lat,
				long: cached.long,
				temperatureC: onSteps(cached.temperatureC),
				ghiWm2: onSteps(cached.ghiWm2),
				dniWm2: onSteps(cached.dniWm2),
				dhiWm2: onSteps(cached.dhiWm2),
			};
			const readings = satellite?.locations[id];
			if (!readings) return [id, location];
			for (const component of COMPONENTS) {
				const blend = blendIrradiance(satellite.times, readings[component], times, location[component]);
				location[component] = blend.irradianceWm2;
				if (blend.observedUntil !== null) observedUntil = Math.max(observedUntil ?? 0, blend.observedUntil);
			}
			return [id, location];
		}),
	);
	return {
		date: forecast.date,
		fetchedAt: forecast.fetchedAt,
		times,
		locations: blended,
		observedUntil,
		...(forecast.model && { model: forecast.model }),
	};
}

// A day's weather as the production job last cached it in D1, if it's in the
// current format.
export async function cachedWeather(
	db: D1Database,
	date: string,
): Promise<{ forecast: Forecast; satellite: SatelliteDay | null } | null> {
	const [forecast, satellite] = await Promise.all([
		db.prepare("SELECT forecast FROM weather_forecasts WHERE nz_date = ?").bind(date).first<string>("forecast"),
		db.prepare("SELECT data FROM satellite_irradiance WHERE nz_date = ?").bind(date).first<string>("data"),
	]);
	const cached = current<Forecast>(forecast);
	return cached ? { forecast: cached, satellite: current<SatelliteDay>(satellite) } : null;
}

// Whether a past day's weather can't change any more: the forecast was
// fetched after the day was over, and the satellite once its readings ran
// past the day's last sunlight.
export function weatherIsFinal(forecast: Forecast, satellite: SatelliteDay | null): boolean {
	const sunlit = sunlitTimes(forecast);
	if (nzDate(new Date(forecast.fetchedAt)) <= forecast.date) return false;
	if (sunlit.length === 0) return true;
	return satellite !== null && satelliteIsFinal(satellite, sunlit);
}

// Whether a day's satellite readings run past its last sunlight, however
// long after it they arrived.
function satelliteIsFinal(satellite: SatelliteDay, sunlit: number[]): boolean {
	const newest = newestReading(satellite);
	return newest !== null && newest > sunlit[sunlit.length - 1];
}

// When a day's newest satellite reading was taken, if it has any.
function newestReading({ times, locations }: SatelliteDay): number | null {
	const readings = Object.values(locations);
	for (let i = times.length - 1; i >= 0; i--) {
		if (readings.some((location) => location.ghiWm2[i] !== null)) return times[i];
	}
	return null;
}

// Whether a day's weather was taken where each location's is taken now (see
// gxpWeatherPoints), and has all of them.
export function weatherTakenAtPoints(
	forecast: Forecast,
	satellite: SatelliteDay | null,
	locations: WeatherLocation[],
): boolean {
	return (
		takenAt(forecast.points, locations, forecastPoint) &&
		(satellite === null || takenAt(satellite.pixels, locations, satellitePixels))
	);
}

function sunlitTimes(forecast: Forecast): number[] {
	return forecast.times.filter((_, i) => Object.values(forecast.locations).some((location) => location.ghiWm2[i] > 0));
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
	const previous = current<Forecast>(cached);
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
	const sunlit = sunlitTimes(forecast);
	if (sunlit.length === 0 || now.getTime() < sunlit[0]) return null;

	const cached = await db
		.prepare("SELECT data FROM satellite_irradiance WHERE nz_date = ?")
		.bind(date)
		.first<string>("data");
	const previous = current<SatelliteDay>(cached);
	if (previous && takenAt(previous.pixels, locations, satellitePixels)) {
		if (satelliteIsFinal(previous, sunlit)) return previous;
		const hour = nzHour(now);
		const maxAge = hour >= MIDDAY.from && hour < MIDDAY.to ? MIDDAY_SATELLITE_AGE_MS : MAX_SATELLITE_AGE_MS;
		if (now.getTime() - Date.parse(previous.fetchedAt) < maxAge) return previous;
		// Until Open-Meteo has something newer it's asked again every run, so
		// readings that arrive late are picked up within 10 minutes.
		if (!(await hasNewerReadings(previous, locations, date, now))) return previous;
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
				minutely_15: [...Object.values(OPEN_METEO_VARIABLES), "temperature_2m"].join(","),
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
		[...Object.values(OPEN_METEO_VARIABLES), "temperature_2m"].some((variable) => forecast[variable].includes(null)),
	);
	if (hasGaps) {
		throw new WeatherFetchError(`Open-Meteo sent weather with gaps for ${date}; try again later`);
	}

	return {
		format: CACHE_FORMAT,
		date,
		fetchedAt: now.toISOString(),
		times: forecasts[0].minutely_15.time.map((seconds) => seconds * 1000),
		locations: Object.fromEntries(
			locations.map((location, i) => {
				const series = forecasts[i].minutely_15;
				const weather: LocationWeather = {
					lat: location.forecast.lat,
					long: location.forecast.long,
					temperatureC: series.temperature_2m as number[],
					ghiWm2: series[OPEN_METEO_VARIABLES.ghiWm2] as number[],
					dniWm2: series[OPEN_METEO_VARIABLES.dniWm2] as number[],
					dhiWm2: series[OPEN_METEO_VARIABLES.dhiWm2] as number[],
				};
				return [location.id, weather];
			}),
		),
		points: Object.fromEntries(locations.map((location) => [location.id, forecastPoint(location)])),
	};
}

// Weather for days long past, to backfill estimates: ERA5 for the forecast's
// part, and the satellite archive. Each day has its own locations (GXPs come
// and go, and grow into more pixels), but they're fetched together, so a
// fortnight costs Open-Meteo what a day would (it counts a location's two
// weeks as one call). Days ERA5 doesn't have yet, or has gaps in, are left
// out; a day the satellite has no readings for gets ERA5's sunlight.
export async function fetchArchiveWeather(
	days: { date: string; locations: WeatherLocation[] }[],
	now: Date,
): Promise<{ date: string; forecast: Forecast; satellite: SatelliteDay | null }[]> {
	const from = days[0].date;
	const to = days[days.length - 1].date;
	const all = days.flatMap((day) => day.locations);
	// A GXP's forecast point doesn't change with its size, unlike its pixels.
	const centres = [...new Map(all.map((location) => [location.id, location])).values()];
	const series: OpenMeteoSeries[] = [];
	for (const batch of batches(centres)) {
		const res = await fetch(
			`${OPEN_METEO_ARCHIVE_URL}?${new URLSearchParams({
				...coordinates(batch.map((location) => location.forecast)),
				hourly: [...Object.values(OPEN_METEO_VARIABLES), "temperature_2m"].join(","),
				models: ARCHIVE_MODEL,
				...sharedParams(from, to),
			})}`,
		);
		if (!res.ok) throw new WeatherFetchError(`Open-Meteo archive request failed (${res.status}): ${await res.text()}`);
		const body = await res.json<OpenMeteoArchive | OpenMeteoArchive[]>();
		series.push(...(Array.isArray(body) ? body : [body]).map(({ hourly }) => hourly));
	}
	const variables = [...Object.values(OPEN_METEO_VARIABLES), "temperature_2m"];
	// Like the forecast, the archive might send every value as null and be fine later.
	if (series.every((location) => variables.every((variable) => location[variable].every((value) => value === null)))) {
		throw new WeatherFetchError(`Open-Meteo sent no ERA5 weather from ${from} to ${to}; try again later`);
	}
	const seriesAt = new Map(centres.map((location, i) => [location.id, series[i]]));
	const times = series[0].time.map((seconds) => seconds * 1000);
	const dates = times.map((time) => nzDate(new Date(time)));

	const readings = await fetchSatelliteReadings(all, previousDate(from), to);
	if ([...readings.pixels.values()].every((pixel) => pixel[OPEN_METEO_VARIABLES.ghiWm2].every((value) => value === null))) {
		throw new WeatherFetchError(`Open-Meteo sent no satellite readings from ${from} to ${to}; try again later`);
	}

	return days.flatMap(({ date, locations }) => {
		const onDay = dates.map((day) => day === date);
		const ofDay = <T>(values: T[]) => values.filter((_, i) => onDay[i]);
		const hasGaps = locations.some((location) =>
			variables.some((variable) => ofDay(seriesAt.get(location.id)![variable]).includes(null)),
		);
		if (hasGaps) return [];

		const forecast: Forecast = {
			format: CACHE_FORMAT,
			date,
			fetchedAt: now.toISOString(),
			model: ARCHIVE_MODEL,
			times: ofDay(times),
			locations: Object.fromEntries(
				locations.map((location) => {
					const hourly = seriesAt.get(location.id)!;
					const weather: LocationWeather = {
						lat: location.forecast.lat,
						long: location.forecast.long,
						temperatureC: ofDay(hourly.temperature_2m) as number[],
						ghiWm2: ofDay(hourly[OPEN_METEO_VARIABLES.ghiWm2]) as number[],
						dniWm2: ofDay(hourly[OPEN_METEO_VARIABLES.dniWm2]) as number[],
						dhiWm2: ofDay(hourly[OPEN_METEO_VARIABLES.dhiWm2]) as number[],
					};
					return [location.id, weather];
				}),
			),
			points: Object.fromEntries(locations.map((location) => [location.id, forecastPoint(location)])),
		};
		let satellite: SatelliteDay | null = null;
		try {
			satellite = satelliteDay(readings, locations, date, now);
		} catch (error) {
			if (!(error instanceof WeatherFetchError)) throw error;
		}
		return [{ date, forecast, satellite }];
	});
}

// Himawari-9 irradiance every 10 minutes on a ~5 km grid, averaged over each
// location's pixels by their weights. Readings not taken yet come back as
// null.
async function fetchSatellite(locations: WeatherLocation[], date: string, now: Date): Promise<SatelliteDay> {
	// The archive takes no date after today's in UTC, which until midday in NZ
	// is still yesterday, so it's asked for the UTC days the NZ day spans and
	// cut down to it.
	const readings = await fetchSatelliteReadings(
		locations,
		previousDate(date),
		[date, now.toISOString().slice(0, 10)].sort()[0],
	);
	return satelliteDay(readings, locations, date, now);
}

// Whether Open-Meteo has readings of a day newer than a cached copy's newest,
// going by the largest GXP's most-populated pixel: one call, where refetching
// every pixel is ~310. If it can't tell, it's taken to have none.
async function hasNewerReadings(
	cached: SatelliteDay,
	locations: WeatherLocation[],
	date: string,
	now: Date,
): Promise<boolean> {
	const probe = { ...locations[0], pixels: locations[0].pixels.slice(0, 1) };
	try {
		const latest = newestReading(await fetchSatellite([probe], date, now));
		const newest = newestReading(cached);
		return latest !== null && (newest === null || latest > newest);
	} catch (error) {
		console.warn(`Couldn't check for new satellite irradiance for ${date}: ${(error as Error).message}`);
		return false;
	}
}

// Each of the locations' pixels' readings over whole UTC days, by where it is.
interface SatelliteReadings {
	times: number[];
	dates: string[]; // each time's NZ date
	pixels: Map<string, OpenMeteoSeries>;
}

async function fetchSatelliteReadings(
	locations: WeatherLocation[],
	from: string,
	to: string,
): Promise<SatelliteReadings> {
	// Neighbouring GXPs' people can share a pixel, which is only asked for once.
	const pixels = [
		...new Map(locations.flatMap((location) => location.pixels.map((pixel) => [point(pixel), pixel] as const))).values(),
	];
	const readings: OpenMeteoSatellite[] = [];
	for (const batch of batches(pixels)) {
		const res = await fetch(
			`${OPEN_METEO_SATELLITE_URL}?${new URLSearchParams({
				...coordinates(batch),
				hourly: Object.values(OPEN_METEO_VARIABLES).join(","),
				temporal_resolution: "native",
				models: "jma_jaxa_himawari",
				start_date: from,
				end_date: to,
				timeformat: "unixtime",
			})}`,
		);
		if (!res.ok) throw new WeatherFetchError(`Open-Meteo satellite request failed (${res.status}): ${await res.text()}`);
		const body = await res.json<OpenMeteoSatellite | OpenMeteoSatellite[]>();
		readings.push(...(Array.isArray(body) ? body : [body]));
	}
	const times = readings[0].hourly.time.map((seconds) => seconds * 1000);
	return {
		times,
		dates: times.map((time) => nzDate(new Date(time))),
		pixels: new Map(pixels.map((pixel, i) => [point(pixel), readings[i].hourly])),
	};
}

// An NZ day's readings, averaged over each location's pixels.
function satelliteDay(
	readings: SatelliteReadings,
	locations: WeatherLocation[],
	date: string,
	now: Date,
): SatelliteDay {
	const onDay = readings.dates.map((day) => day === date);
	const ofDay = <T>(values: T[]) => values.filter((_, i) => onDay[i]);
	const pixelsOf = (location: WeatherLocation) => location.pixels.map((pixel) => readings.pixels.get(point(pixel))!);
	const empty = locations.every((location) =>
		pixelsOf(location).every((pixel) => ofDay(pixel[OPEN_METEO_VARIABLES.ghiWm2]).every((value) => value === null)),
	);
	if (empty) throw new WeatherFetchError("every reading was empty");

	return {
		format: CACHE_FORMAT,
		date,
		fetchedAt: now.toISOString(),
		times: ofDay(readings.times),
		locations: Object.fromEntries(
			locations.map((location) => {
				const average = (component: Component) =>
					averagePixels(
						pixelsOf(location).map((pixel) => ofDay(pixel[OPEN_METEO_VARIABLES[component]])),
						location.pixels.map((pixel) => pixel.weight),
					);
				return [location.id, { ghiWm2: average("ghiWm2"), dniWm2: average("dniWm2"), dhiWm2: average("dhiWm2") }];
			}),
		),
		pixels: Object.fromEntries(locations.map((location) => [location.id, satellitePixels(location)])),
	};
}

// Where a location's forecast and satellite readings are taken, as sent to
// Open-Meteo, with each pixel's weight in the average.
function forecastPoint({ forecast }: WeatherLocation): string {
	return point(forecast);
}

function satellitePixels({ pixels }: WeatherLocation): string {
	return pixels.map((pixel) => `${point(pixel)},${pixel.weight}`).join(";");
}

function point({ lat, long }: { lat: number; long: number }): string {
	return `${lat.toFixed(4)},${long.toFixed(4)}`;
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

// A cached day, unless it's in an older format, which can't be used at all.
function current<T extends { format?: number }>(cached: string | null): T | null {
	const parsed: T | null = cached ? JSON.parse(cached) : null;
	return parsed?.format === CACHE_FORMAT ? parsed : null;
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

function sharedParams(from: string, to = from) {
	return {
		// NZ days, with times returned as UTC instants so DST can't shift them.
		timezone: "Pacific/Auckland",
		start_date: from,
		end_date: to,
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
