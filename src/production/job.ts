import { capacityAt, type CapacityMonth } from "./capacity";
import { dashboardReadings, type HttpRequest, socketHttp } from "./dashboard";
import { estimateProduction, type MeteredFarm, round } from "./estimate";
import { gxpWeatherPoints, POPULATION_SOURCE } from "./locations";
import { latestRanuiReading, RANUI, ranuiFarm, ranuiReadingsOn, storeRanuiReadings } from "./ranui";
import { ARCHIVE_MODEL, type DayWeather, getWeather, nzDate, previousDate, type WeatherLocation } from "./weather";

// No GXP had solar by the date, or the capacity job hasn't run yet.
export class NoCapacityError extends Error {}

// Where a day's estimate is kept in R2: one file per NZ date.
export function estimateKey(date: string): string {
	return `solar-production/${date}.json`;
}

// Estimates yesterday and today, replacing each one's file in R2. Today's has
// live values as at `now`. Yesterday's is redone through the day after, so it
// picks up the satellite's last readings and the forecast fetched once it was
// over; from then on its weather comes from D1 (see getWeather) and costs
// Open-Meteo nothing. Days before that are left as they are for good.
// Rānui's latest readings are stored first, from its dashboard at
// RANUI_DASHBOARD if set.
export async function runProductionJob(
	env: Env,
	now = new Date(),
	dashboard: HttpRequest | null = env.RANUI_DASHBOARD ? socketHttp(env.RANUI_DASHBOARD) : null,
): Promise<string[]> {
	const today = nzDate(now);
	const stored: string[] = [];
	const failures: string[] = [];
	// The dashboard being down only leaves gaps for the farm array to fill.
	let dashboardFailure: string | null = null;
	if (dashboard) {
		try {
			await storeDashboardReadings(env.DB, dashboard, now);
		} catch (error) {
			dashboardFailure = `Couldn't read ${RANUI.name}'s dashboard: ${(error as Error).message}`;
		}
	}
	// Each day is stored on its own, so one failing doesn't hold up the other.
	for (const date of [previousDate(today), today]) {
		try {
			const estimate = await estimateDay(env.DB, date, now);
			await env.DATASET.put(estimateKey(date), JSON.stringify(estimate), {
				httpMetadata: { contentType: "application/json" },
			});
			stored.push(date);
		} catch (error) {
			failures.push(`${date}: ${(error as Error).message}`);
		}
	}

	console.log(JSON.stringify({ message: "Production job finished", stored, failures, dashboardFailure }));
	const errors = [failures.length > 0 ? `Couldn't estimate ${failures.join("; ")}` : null, dashboardFailure];
	if (errors.some(Boolean)) throw new Error(errors.filter(Boolean).join(". "));
	return stored;
}

// Stores Rānui's readings since the latest stored, from the dashboard's
// shortest chart going back that far: the last hour's every run, unless the
// job or the dashboard has been down. Returns how many it read.
export async function storeDashboardReadings(db: D1Database, dashboard: HttpRequest, now: Date): Promise<number> {
	const readings = await dashboardReadings(dashboard, await latestRanuiReading(db), now);
	await storeRanuiReadings(db, readings);
	return readings.length;
}

// Every GXP's distributed solar output through an NZ date, and at `now` if
// it's today.
export async function estimateDay(db: D1Database, date: string, now: Date) {
	// Each GXP's recent month-end snapshots: its capacity on the date is the
	// latest plus growth since at its recent rate (see production/capacity.ts).
	const { results: months } = await db
		.prepare(
			`SELECT c.gxp, g.name, g.lat, g.long, c.month_end AS monthEnd,
				round(sum(c.distributed_mw), 3) AS distributedMw, round(sum(c.step_mw), 3) AS stepMw
			FROM solar_capacity c JOIN gxps g ON g.site_id = c.gxp
			WHERE c.month_end <= ?1 AND c.month_end > date(?1, '-14 months')
			GROUP BY c.gxp, c.month_end
			ORDER BY c.gxp, c.month_end`,
		)
		.bind(date)
		.all<GxpCapacityMonth>();
	// Every farm-sized step a GXP has had is modelled as a farm.
	const { results: farms } = await db
		.prepare("SELECT gxp, round(sum(step_mw), 3) AS farmMw FROM solar_capacity WHERE month_end <= ? GROUP BY gxp")
		.bind(date)
		.all<{ gxp: string; farmMw: number }>();
	const capacity = gxpCapacities(months, new Map(farms.map((farm) => [farm.gxp, farm.farmMw])), date);

	const weather = await getWeather(db, capacity.gxps.map(weatherLocation), date, now);
	const ranui = ranuiFarm(date, await ranuiReadingsOn(db, date));
	return productionEstimate(date, capacity, weather, date === nzDate(now) ? now : null, now, ranui ? [ranui] : []);
}

// A month-end snapshot of a GXP's capacity, and where the GXP is.
export interface GxpCapacityMonth extends CapacityMonth {
	gxp: string;
	name: string;
	lat: number;
	long: number;
}

export interface GxpCapacities {
	capacityMonthEnd: string;
	gxps: { gxp: string; name: string; lat: number; long: number; distributedMw: number; farmMw: number; growthMwPerMonth: number }[];
}

// Each GXP with solar's capacity on a date, largest first, from its snapshots
// in the 14 months to the date (by GXP, then month end), and all the
// farm-sized steps it's had by then.
export function gxpCapacities(months: GxpCapacityMonth[], farmMw: Map<string, number>, date: string): GxpCapacities {
	const capacityMonthEnd = months.reduce((latest, month) => (month.monthEnd > latest ? month.monthEnd : latest), "");
	const histories = new Map<string, GxpCapacityMonth[]>();
	for (const month of months) histories.set(month.gxp, [...(histories.get(month.gxp) ?? []), month]);
	const gxps = [...histories.values()]
		// A GXP missing from the latest snapshot has left EMI's data.
		.filter((history) => history[history.length - 1].monthEnd === capacityMonthEnd)
		.map((history) => {
			const { gxp, name, lat, long } = history[0];
			const estimate = capacityAt(history, date)!;
			return {
				gxp,
				name,
				lat,
				long,
				distributedMw: round(estimate.capacityMw),
				farmMw: round(Math.min(farmMw.get(gxp) ?? 0, estimate.capacityMw)),
				growthMwPerMonth: round(estimate.growthMwPerMonth),
			};
		})
		.filter((gxp) => gxp.distributedMw > 0)
		.sort((a, b) => b.distributedMw - a.distributedMw);
	if (gxps.length === 0) {
		throw new NoCapacityError(`No solar capacity as at ${date}`);
	}
	return { capacityMonthEnd, gxps };
}

// Where a GXP's weather is taken.
export function weatherLocation({ gxp, lat, long, distributedMw }: GxpCapacities["gxps"][number]): WeatherLocation {
	return { id: gxp, ...gxpWeatherPoints(gxp, { lat, long }, distributedMw) };
}

// The estimate as stored and served: each GXP's output through the day, and
// at `at` if given (today's, as at now), with the readings of any metered
// farms in place of modelling them.
export function productionEstimate(
	date: string,
	{ capacityMonthEnd, gxps }: GxpCapacities,
	weather: DayWeather,
	at: Date | null,
	now: Date,
	meteredFarms: MeteredFarm[] = [],
) {
	const estimates = estimateProduction(
		gxps.map(({ gxp, name, distributedMw, farmMw }) => ({ gxp, name, distributedMw, farmMw })),
		weather,
		at,
		meteredFarms,
	);
	const sum = (values: number[]) => round(values.reduce((total, value) => total + value, 0));
	const temperatures = weather.model === ARCHIVE_MODEL ? ", with temperatures from Copernicus ERA5" : "";

	return {
		time: now.toISOString(),
		date,
		capacityMonthEnd,
		weatherFetchedAt: weather.fetchedAt,
		observedUntil: weather.observedUntil === null ? null : new Date(weather.observedUntil).toISOString(),
		attribution: `Weather data by Open-Meteo.com (CC BY 4.0)${temperatures}; satellite data from JMA/JAXA Himawari; population from ${POPULATION_SOURCE}`,
		profileTimes: weather.times.map((time) => new Date(time).toISOString()),
		// Farms whose own readings are used where there are any.
		meteredFarms: meteredFarms
			.filter((farm) => farm.readings.length > 0)
			.map((farm) => ({
				gxp: farm.gxp,
				capacityMw: farm.capacityMw,
				readingsFrom: new Date(farm.readings[0].time).toISOString(),
				readingsUntil: new Date(farm.readings[farm.readings.length - 1].time).toISOString(),
			})),
		total: {
			distributedMw: sum(estimates.map((estimate) => estimate.distributedMw)),
			farmMw: sum(estimates.map((estimate) => estimate.farmMw)),
			productionMw: at ? sum(estimates.map((estimate) => estimate.productionMw ?? 0)) : null,
			profileMw: weather.times.map((_, index) => sum(estimates.map((estimate) => estimate.profileMw[index]))),
		},
		gxps: estimates.map((estimate, i) => ({ ...estimate, growthMwPerMonth: gxps[i].growthMwPerMonth })),
	};
}

export type ProductionEstimate = ReturnType<typeof productionEstimate>;
