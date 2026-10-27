import { weatherLocation } from "../production/job";
import { fetchArchiveWeather, nzDate } from "../production/weather";
import { CapacityHistory } from "./capacities";
import { addDays, datesBetween } from "./periods";
import { archivedWeatherKey } from "./store";

// Himawari-8's first full NZ day of readings.
export const ARCHIVE_START = "2015-07-03";
// ERA5 is about five days behind.
const ARCHIVE_LAG_DAYS = 6;
// Open-Meteo counts each location's fortnight as one call, so a run's fetch
// costs about 430 calls (fewer in earlier years, with fewer and smaller
// GXPs), whatever the length up to this.
const DAYS_PER_FETCH = 14;
// A day the archive couldn't give (a gap in ERA5) is asked for again after
// this long, rather than every run.
const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const JSON_METADATA = { httpMetadata: { contentType: "application/json" } };

// Fetches weather from Open-Meteo's archive for up to a fortnight of days the
// aggregate job can't estimate: those with no weather, newest first, back to
// when the satellite starts (or the capacity data, if later); then days whose
// weather was taken where a GXP's isn't any more. Each day's is stored in R2,
// and the aggregate job estimates it on its next run.
export async function runWeatherArchiveJob(env: Env, now = new Date()): Promise<string[]> {
	const db = env.DB;
	const history = await CapacityHistory.load(db);
	const firstMonthEnd = history.firstMonthEnd;
	if (!firstMonthEnd) return [];
	const first = [ARCHIVE_START, firstMonthEnd].sort()[1];
	const last = addDays(nzDate(now), -ARCHIVE_LAG_DAYS);
	if (first > last) return [];

	const { results } = await db
		.prepare(
			`SELECT nz_date AS date, weather, weather_points_current AS pointsCurrent, weather_unavailable_at AS unavailableAt
			FROM production_days WHERE nz_date BETWEEN ?1 AND ?2`,
		)
		.bind(first, last)
		.all<{ date: string; weather: string | null; pointsCurrent: number; unavailableAt: string | null }>();
	// Days the production job cached that the aggregate job hasn't indexed yet.
	const { results: cached } = await db
		.prepare(
			"SELECT nz_date AS date FROM weather_forecasts WHERE nz_date BETWEEN ?1 AND ?2 AND nz_date NOT IN (SELECT nz_date FROM production_days)",
		)
		.bind(first, last)
		.all<{ date: string }>();
	const days = new Map(results.map((day) => [day.date, day]));
	const unindexed = new Set(cached.map(({ date }) => date));
	const tried = (date: string) => {
		const unavailableAt = days.get(date)?.unavailableAt;
		return unavailableAt != null && now.getTime() - Date.parse(unavailableAt) < RETRY_AFTER_MS;
	};
	const missing = datesBetween(first, last).filter((date) => !days.get(date)?.weather && !unindexed.has(date) && !tried(date));
	const moved = results.filter((day) => day.weather && !day.pointsCurrent && !tried(day.date)).map((day) => day.date);
	const wanted = (missing.length > 0 ? missing : moved).sort().reverse();
	if (wanted.length === 0) return [];

	const window = wanted.filter((date) => date > addDays(wanted[0], -DAYS_PER_FETCH)).reverse();
	const requests = window.flatMap((date) => {
		const capacity = history.on(date);
		return capacity ? [{ date, locations: capacity.gxps.map(weatherLocation) }] : [];
	});
	const fetched = requests.length > 0 ? await fetchArchiveWeather(requests, now) : [];
	for (const day of fetched) {
		await env.DATASET.put(
			archivedWeatherKey(day.date),
			JSON.stringify({ forecast: day.forecast, satellite: day.satellite }),
			JSON_METADATA,
		);
	}

	const fetchedAt = now.toISOString();
	const stored = new Set(fetched.map((day) => day.date));
	await db.batch(
		window.map((date) =>
			stored.has(date)
				? db
						.prepare(
							`INSERT INTO production_days (nz_date, weather) VALUES (?1, ?2)
							ON CONFLICT (nz_date) DO UPDATE SET weather = excluded.weather, weather_points_current = 1,
								weather_unavailable_at = NULL`,
						)
						.bind(date, `r2 ${fetchedAt}`)
				: db
						.prepare(
							`INSERT INTO production_days (nz_date, weather_unavailable_at) VALUES (?1, ?2)
							ON CONFLICT (nz_date) DO UPDATE SET weather_unavailable_at = excluded.weather_unavailable_at`,
						)
						.bind(date, fetchedAt),
		),
	);

	const archived = [...stored];
	console.log(
		JSON.stringify({ message: "Weather archive job finished", archived, unavailable: window.filter((date) => !stored.has(date)) }),
	);
	return archived;
}
