import { productionEstimate, weatherLocation } from "../production/job";
import {
	blendWeather,
	CACHE_FORMAT,
	cachedWeather,
	type Forecast,
	nzDate,
	type SatelliteDay,
	weatherIsFinal,
	weatherTakenAtPoints,
} from "../production/weather";
import { CapacityHistory } from "./capacities";
import { dailyEnergy } from "./energy";
import { hash, modelFingerprint } from "./model";
import { addDays } from "./periods";
import { archivedWeatherKey, EnergyStore, sumPeriods, tenMinuteKey } from "./store";

// Caps a run's work, so recalculating every day after the model changes
// (over 4,000 since July 2015) is spread over about seven hours of runs,
// newest days first. A day takes about 60 ms, mostly reading its weather.
const MAX_DAYS_PER_RUN = 100;
// Days the production job has cached that are indexed per run, the first
// time this runs.
const MAX_CACHED_DAYS_PER_RUN = 20;

const JSON_METADATA = { httpMetadata: { contentType: "application/json" } };

export interface StoredWeather {
	forecast: Forecast;
	satellite: SatelliteDay | null;
}

// Estimates every day up to yesterday that has weather and hasn't been
// estimated, or was estimated with a different model, capacities or weather
// than it has now, newest first. Each day's 10-minute estimate is stored in
// R2 with its energy added to its month's file of days, and the weeks, months
// and years it's in are summed again from them.
export async function runAggregateJob(env: Env, now = new Date()): Promise<string[]> {
	const db = env.DB;
	const today = nzDate(now);
	const model = await modelFingerprint();
	await indexCachedWeather(db, today);

	// Read before the capacities, so a change landing in between is picked
	// up next run rather than missed.
	const capacityFingerprint = await db
		.prepare("SELECT fingerprint FROM capacity_job_runs ORDER BY id DESC LIMIT 1")
		.first<string>("fingerprint");
	const checked = await db.prepare("SELECT value FROM aggregate_state WHERE key = 'capacity'").first<string>("value");
	let history: CapacityHistory | null = null;
	if (capacityFingerprint && capacityFingerprint !== checked) {
		history = await CapacityHistory.load(db);
		await markChangedCapacities(db, history);
		await db
			.prepare("INSERT OR REPLACE INTO aggregate_state (key, value) VALUES ('capacity', ?)")
			.bind(capacityFingerprint)
			.run();
	}

	const { results: due } = await db
		.prepare(
			`SELECT nz_date AS date, weather FROM production_days
			WHERE weather IS NOT NULL AND nz_date < ?1
				AND (model IS NOT ?2 OR capacity IS NULL OR estimated_weather IS NOT weather)
			ORDER BY nz_date DESC LIMIT ?3`,
		)
		.bind(today, model, MAX_DAYS_PER_RUN)
		.all<{ date: string; weather: string }>();
	if (due.length === 0) return [];
	history ??= await CapacityHistory.load(db);

	const store = new EnergyStore(env.DATASET);
	const updates: D1PreparedStatement[] = [];
	const estimated: string[] = [];
	const failures: string[] = [];
	for (const { date, weather: source } of due) {
		try {
			const stored = await storedWeather(env, source, date);
			if (!stored) {
				// e.g. an older format: the archive job fetches it again.
				updates.push(db.prepare("UPDATE production_days SET weather = NULL WHERE nz_date = ?").bind(date));
				continue;
			}
			const capacity = history.on(date);
			if (!capacity) throw new Error("no solar capacity");
			const locations = capacity.gxps.map(weatherLocation);
			// A GXP the weather wasn't fetched for (the capacity data didn't
			// have it yet) is left out until it's fetched again.
			const covered = { ...capacity, gxps: capacity.gxps.filter((gxp) => gxp.gxp in stored.forecast.locations) };
			const weather = blendWeather(stored.forecast, stored.satellite, covered.gxps.map(weatherLocation));
			const estimate = productionEstimate(date, covered, weather, null, now);
			await env.DATASET.put(tenMinuteKey(date), JSON.stringify(estimate), JSON_METADATA);
			const energy = dailyEnergy(estimate);
			await store.upsert("daily", date.slice(0, 7), energy);

			updates.push(
				db
					.prepare(
						`UPDATE production_days SET model = ?, capacity = ?, estimated_weather = ?, weather_points_current = ?,
							energy_mwh = ?, estimated_at = ? WHERE nz_date = ?`,
					)
					.bind(
						model,
						await hash(capacity),
						source,
						weatherTakenAtPoints(stored.forecast, stored.satellite, locations) ? 1 : 0,
						energy.totalMwh,
						now.toISOString(),
						date,
					),
			);
			estimated.push(date);
		} catch (error) {
			failures.push(`${date}: ${(error as Error).message}`);
		}
	}

	await sumPeriods(store, estimated);
	// Files first: if writing them fails, the days are still due next run.
	await store.flush();
	if (updates.length > 0) await db.batch(updates);

	console.log(JSON.stringify({ message: "Aggregate job finished", estimated, failures }));
	if (failures.length > 0) throw new Error(`Couldn't estimate ${failures.join("; ")}`);
	return estimated;
}

// A day's weather from where its index says it's kept, unless it's in an
// older format.
export async function storedWeather(env: Env, source: string, date: string): Promise<StoredWeather | null> {
	const stored = source.startsWith("d1 ")
		? await cachedWeather(env.DB, date)
		: await (await env.DATASET.get(archivedWeatherKey(date)))?.json<StoredWeather>();
	if (!stored || stored.forecast.format !== CACHE_FORMAT) return null;
	return stored.satellite?.format === CACHE_FORMAT ? stored : { ...stored, satellite: null };
}

// Indexes the weather the production job has cached for days before today:
// yesterday's, which it's still refreshing, and the day before's, which it
// may have only just finished, plus any day it cached before this first ran.
// A day before yesterday is only used once its weather is final; one whose
// weather never was is left to the archive job.
async function indexCachedWeather(db: D1Database, today: string): Promise<void> {
	const yesterday = addDays(today, -1);
	const { results } = await db
		.prepare(
			`SELECT nz_date AS date FROM weather_forecasts
			WHERE nz_date < ?1 AND (nz_date >= ?2 OR nz_date NOT IN (SELECT nz_date FROM production_days))
			ORDER BY nz_date DESC LIMIT ?3`,
		)
		.bind(today, addDays(today, -2), MAX_CACHED_DAYS_PER_RUN)
		.all<{ date: string }>();

	const upserts: D1PreparedStatement[] = [];
	for (const { date } of results) {
		const cached = await cachedWeather(db, date);
		const usable = cached && (date === yesterday || weatherIsFinal(cached.forecast, cached.satellite));
		const weather = usable ? `d1 ${cached.forecast.fetchedAt} ${cached.satellite?.fetchedAt ?? "-"}` : null;
		// Weather from the archive stands: it was only fetched because the
		// cached weather wasn't final, or was taken where a GXP's isn't now.
		upserts.push(
			db
				.prepare(
					`INSERT INTO production_days (nz_date, weather) VALUES (?1, ?2)
					ON CONFLICT (nz_date) DO UPDATE SET weather = excluded.weather
					WHERE weather IS NULL OR weather LIKE 'd1 %'`,
				)
				.bind(date, weather),
		);
	}
	if (upserts.length > 0) await db.batch(upserts);
}

// Once the capacity data has changed, the days whose capacities have are
// estimated again. A new EMI month end usually changes the days since the
// one before it, which were grown from that.
async function markChangedCapacities(db: D1Database, history: CapacityHistory): Promise<void> {
	const { results } = await db
		.prepare("SELECT nz_date AS date, capacity FROM production_days WHERE capacity IS NOT NULL")
		.all<{ date: string; capacity: string }>();
	const changed: string[] = [];
	for (const { date, capacity } of results) {
		if ((await hash(history.on(date))) !== capacity) changed.push(date);
	}
	if (changed.length > 0) {
		await db
			.prepare("UPDATE production_days SET capacity = NULL WHERE nz_date IN (SELECT value FROM json_each(?))")
			.bind(JSON.stringify(changed))
			.run();
	}
}
