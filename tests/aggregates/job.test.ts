import { createExecutionContext, createScheduledController, env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWeatherArchiveJob } from "../../src/aggregates/archive";
import { runAggregateJob } from "../../src/aggregates/job";
import { archivedWeatherKey, energyKey, tenMinuteKey } from "../../src/aggregates/store";
import worker from "../../src/index";
import { ROOFTOP, round } from "../../src/production/estimate";
import { runProductionJob } from "../../src/production/job";
import { nzDate } from "../../src/production/weather";

// 2pm on Monday 26 October in NZ. ERA5 is five days behind, so the archive
// is asked for days up to the 20th.
const NOW = Date.parse("2026-10-26T01:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const ISLINGTON_LAT = -43.5;
// Islington under 1000 W/m² of overcast at 25 °C all day, as in the
// production job's tests.
const ISL_MW = 49.414;

const ARCHIVE = "archive-api.open-meteo.com";
const SATELLITE = "satellite-api.open-meteo.com";
const FORECAST = "api.open-meteo.com";

const nearIslington = (lat: string, long: string) =>
	Math.abs(Number(lat) - ISLINGTON_LAT) < 0.15 && Math.abs(Number(long) - 172.5) < 0.15;

// Every `stepSeconds` of the NZ dates from `from` to `to`, as Unix seconds.
function nzTimes(from: string, to: string, stepSeconds: number): number[] {
	const times: number[] = [];
	for (let time = Date.parse(`${from}T00:00:00Z`) - DAY_MS; time < Date.parse(`${to}T00:00:00Z`) + DAY_MS; time += stepSeconds * 1000) {
		const date = nzDate(new Date(time));
		if (date >= from && date <= to) times.push(time / 1000);
	}
	return times;
}

// Overcast light: all diffuse, none direct.
function sky(time: number[], irradiance: (number | null)[]) {
	return {
		time,
		shortwave_radiation_instant: irradiance,
		direct_normal_irradiance_instant: irradiance.map((value) => (value === null ? null : 0)),
		diffuse_radiation_instant: irradiance,
	};
}

// Open-Meteo's ERA5 archive (hourly, NZ days), satellite archive (10-minute,
// UTC days) and forecast (15-minute, for the production job): Islington gets
// 1000 W/m² at 25 °C, everywhere else none at 12 °C. ERA5 has nothing after
// `era5Until`.
function mockOpenMeteo({ era5Until = "2026-10-21" } = {}) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const from = url.searchParams.get("start_date")!;
		const to = url.searchParams.get("end_date")!;
		const lats = url.searchParams.get("latitude")?.split(",") ?? [];
		const longs = url.searchParams.get("longitude")?.split(",") ?? [];

		if (url.hostname === SATELLITE) {
			const start = Date.parse(`${from}T00:00:00Z`) / 1000;
			const days = (Date.parse(`${to}T00:00:00Z`) / 1000 - start) / 86400 + 1;
			const times = Array.from({ length: days * 144 }, (_, i) => start + i * 600);
			const arrived = (time: number) => time * 1000 <= Date.now() - 30 * 60 * 1000;
			return Response.json(
				lats.map((lat, i) => ({
					hourly: sky(times, times.map((t) => (!arrived(t) ? null : nearIslington(lat, longs[i]) ? 1000 : 0))),
				})),
			);
		}
		const hourly = url.hostname === ARCHIVE;
		if (!hourly && url.hostname !== FORECAST) return new Response("Not found", { status: 404 });
		const times = nzTimes(from, to, hourly ? 3600 : 900);
		const value = (time: number, sunny: number, dark: number, lat: string, long: string) =>
			hourly && nzDate(new Date(time * 1000)) > era5Until ? null : nearIslington(lat, long) ? sunny : dark;
		return Response.json(
			lats.map((lat, i) => {
				const series = {
					...sky(times, times.map((t) => value(t, 1000, 0, lat, longs[i]))),
					temperature_2m: times.map((t) => value(t, 25, 12, lat, longs[i])),
				};
				return hourly ? { hourly: series } : { minutely_15: series };
			}),
		);
	});
}

function callsTo(fetch: ReturnType<typeof mockOpenMeteo>, hostname: string) {
	return fetch.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.hostname === hostname);
}

async function stored<T = any>(key: string): Promise<T | undefined> {
	return (await env.DATASET.get(key))?.json<T>();
}

async function days() {
	const { results } = await env.DB.prepare("SELECT * FROM production_days ORDER BY nz_date").all<any>();
	return results;
}

// Runs the archive job until it's fetched every day it can.
async function archiveAll() {
	while ((await runWeatherArchiveJob(env, new Date())).length > 0);
}

// Runs the aggregate job until there's nothing left to estimate.
async function aggregateAll() {
	while ((await runAggregateJob(env, new Date())).length > 0);
}

const rooftop = { ...ROOFTOP };

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	// D1 and R2 state are shared between tests, so start each one from the same data.
	const { objects } = await env.DATASET.list();
	if (objects.length > 0) await env.DATASET.delete(objects.map((object) => object.key));
	await env.DB.batch([
		env.DB.prepare("DELETE FROM gxps"),
		env.DB.prepare("DELETE FROM solar_capacity"),
		env.DB.prepare("DELETE FROM capacity_job_runs"),
		env.DB.prepare("DELETE FROM weather_forecasts"),
		env.DB.prepare("DELETE FROM satellite_irradiance"),
		env.DB.prepare("DELETE FROM production_days"),
		env.DB.prepare("DELETE FROM aggregate_state"),
		env.DB.prepare(
			`INSERT INTO gxps (site_id, name, type, island, lat, long) VALUES
			('ISL', 'Islington', 'ACSTN', 'south', ${ISLINGTON_LAT}, 172.5),
			('ASB', 'Ashburton', 'ACSTN', 'south', -43.9, 171.8)`,
		),
		// Capacity is flat from August to September, so it isn't grown.
		env.DB.prepare(
			`INSERT INTO solar_capacity (nsp, gxp, month_end, icp_count, installed_mw, dispatched_mw) VALUES
			('ISL0661ORONGN', 'ISL', '2026-08-31', 6838, 209.694, 160.12),
			('ISL0661ORONGN', 'ISL', '2026-09-30', 6958, 209.694, 160.12),
			('ISL0331ORONGN', 'ISL', '2026-08-31', 800, 9.213, 0),
			('ISL0331ORONGN', 'ISL', '2026-09-30', 800, 9.213, 0),
			('ASB0661EASHGN', 'ASB', '2026-08-31', 966, 73.055, 48.281),
			('ASB0661EASHGN', 'ASB', '2026-09-30', 966, 73.055, 48.281)`,
		),
		env.DB.prepare(
			"INSERT INTO capacity_job_runs (ran_at, latest_month_end, fingerprint, changed) VALUES ('2026-10-25T18:00:00Z', '2026-09-30', 'first', 1)",
		),
	]);
});
afterEach(() => {
	Object.assign(ROOFTOP, rooftop);
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("runWeatherArchiveJob", () => {
	it("fetches the newest fortnight ERA5 has, from the archive, for every GXP at once", async () => {
		const fetch = mockOpenMeteo();
		expect(await runWeatherArchiveJob(env, new Date())).toEqual([
			"2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13",
			"2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20",
		]);

		const [archive] = callsTo(fetch, ARCHIVE);
		expect(Object.fromEntries(archive.searchParams)).toMatchObject({
			hourly: "shortwave_radiation_instant,direct_normal_irradiance_instant,diffuse_radiation_instant,temperature_2m",
			models: "era5_seamless",
			timezone: "Pacific/Auckland",
			start_date: "2026-10-07",
			end_date: "2026-10-20",
		});
		expect(archive.searchParams.get("latitude")!.split(",")).toHaveLength(2);
		// The satellite serves UTC days, which start during the NZ day before.
		const [satellite] = callsTo(fetch, SATELLITE);
		expect([satellite.searchParams.get("start_date"), satellite.searchParams.get("end_date")]).toEqual(["2026-10-06", "2026-10-20"]);
		expect(callsTo(fetch, FORECAST)).toHaveLength(0);

		const weather = await stored(archivedWeatherKey("2026-10-20"));
		expect(weather.forecast).toMatchObject({ date: "2026-10-20", model: "era5_seamless" });
		expect(weather.forecast.times).toHaveLength(24);
		expect(weather.satellite.times).toHaveLength(144);
		expect((await days()).map((day: any) => [day.nz_date, day.weather])[0]).toEqual(["2026-10-07", "r2 2026-10-26T01:00:00.000Z"]);
	});

	it("works back a fortnight a run to the first capacity snapshot, then stops", async () => {
		const fetch = mockOpenMeteo();
		await runWeatherArchiveJob(env, new Date());
		expect((await runWeatherArchiveJob(env, new Date()))[0]).toBe("2026-09-23");
		expect((await runWeatherArchiveJob(env, new Date()))[0]).toBe("2026-09-09");
		expect(await runWeatherArchiveJob(env, new Date())).toEqual(
			["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"],
		);
		expect(await runWeatherArchiveJob(env, new Date())).toEqual([]);
		expect(callsTo(fetch, ARCHIVE)).toHaveLength(4);
	});

	it("leaves out days ERA5 doesn't have yet, and asks for them again a week later", async () => {
		mockOpenMeteo({ era5Until: "2026-10-18" });
		expect((await runWeatherArchiveJob(env, new Date())).at(-1)).toBe("2026-10-18");
		expect(await stored(archivedWeatherKey("2026-10-19"))).toBeUndefined();

		// Not on the next run, which carries on back.
		expect((await runWeatherArchiveJob(env, new Date())).at(-1)).toBe("2026-10-06");
		vi.setSystemTime(NOW + 7 * DAY_MS);
		vi.restoreAllMocks();
		const fetch = mockOpenMeteo({ era5Until: "2026-10-30" });
		const archived = await runWeatherArchiveJob(env, new Date());
		expect(archived).toContain("2026-10-19");
		expect(callsTo(fetch, ARCHIVE)[0].searchParams.get("end_date")).toBe("2026-10-27");
	});

	it("fails without storing anything when the archive sends no weather at all", async () => {
		mockOpenMeteo({ era5Until: "2026-01-01" });
		await expect(runWeatherArchiveJob(env, new Date())).rejects.toThrow("Open-Meteo sent no ERA5 weather from 2026-10-07 to 2026-10-20");
		expect(await days()).toEqual([]);
	});

	it("leaves days the production job has cached to it", async () => {
		mockOpenMeteo();
		vi.setSystemTime(Date.parse("2026-10-20T12:00:00+13:00"));
		await runProductionJob(env, new Date());
		vi.setSystemTime(NOW);

		// Not indexed yet, but the aggregate job will.
		expect(await runWeatherArchiveJob(env, new Date())).not.toContain("2026-10-19");
	});
});

describe("runAggregateJob", () => {
	it("estimates each archived day every 10 minutes, as the production job would, and adds it up", async () => {
		mockOpenMeteo();
		await runWeatherArchiveJob(env, new Date());
		const estimated = await runAggregateJob(env, new Date());
		expect(estimated).toHaveLength(14);
		expect(estimated[0]).toBe("2026-10-20");

		const day = await stored(tenMinuteKey("2026-10-20"));
		expect(day).toMatchObject({
			time: "2026-10-26T01:00:00.000Z",
			date: "2026-10-20",
			capacityMonthEnd: "2026-09-30",
			attribution: expect.stringContaining("with temperatures from Copernicus ERA5"),
			total: { distributedMw: 83.561, productionMw: null },
		});
		expect(day.total.profileMw).toEqual(Array(144).fill(ISL_MW));

		const october = await stored(energyKey("daily", "2026-10"));
		expect(october.data).toHaveLength(14);
		expect(october.data[13]).toEqual({
			from: "2026-10-20",
			to: "2026-10-20",
			days: 1,
			totalMwh: round(ISL_MW * 24),
			gxps: { ISL: round(ISL_MW * 24), ASB: 0 },
		});
		// 7–11, 12–18 and 19–20 October.
		const weekly = await stored(energyKey("weekly", "2026"));
		expect(weekly.data.map((week: any) => [week.from, week.to, week.days])).toEqual([
			["2026-10-05", "2026-10-11", 5],
			["2026-10-12", "2026-10-18", 7],
			["2026-10-19", "2026-10-25", 2],
		]);
		expect((await stored(energyKey("monthly", "2026"))).data).toEqual([
			{ from: "2026-10-01", to: "2026-10-31", days: 14, totalMwh: round(ISL_MW * 24 * 14), gxps: { ISL: round(ISL_MW * 24 * 14), ASB: 0 } },
		]);
		expect((await stored(energyKey("annual", "all"))).data).toEqual([
			{ from: "2026-01-01", to: "2026-12-31", days: 14, totalMwh: round(ISL_MW * 24 * 14), gxps: { ISL: round(ISL_MW * 24 * 14), ASB: 0 } },
		]);

		// Nothing's changed, so nothing's done again.
		expect(await runAggregateJob(env, new Date())).toEqual([]);
	});

	it("gives the day daylight saving starts its 23 hours", async () => {
		mockOpenMeteo();
		await archiveAll();
		await aggregateAll();

		expect((await stored(tenMinuteKey("2026-09-27"))).profileTimes).toHaveLength(138);
		const september = await stored(energyKey("daily", "2026-09"));
		expect(september.data.find((day: any) => day.from === "2026-09-27").gxps.ISL).toBe(round(ISL_MW * 23));
		expect((await stored(energyKey("monthly", "2026"))).data.map((month: any) => [month.from, month.days])).toEqual([
			["2026-08-01", 1],
			["2026-09-01", 30],
			["2026-10-01", 20],
		]);
	});

	it("estimates at most 100 days a run, newest first", async () => {
		// From 31 May, 143 days to the 20th.
		await env.DB.prepare(
			`INSERT INTO solar_capacity (nsp, gxp, month_end, icp_count, installed_mw, dispatched_mw) VALUES
			('ISL0661ORONGN', 'ISL', '2026-05-31', 6838, 209.694, 160.12)`,
		).run();
		mockOpenMeteo();
		await archiveAll();
		const first = await runAggregateJob(env, new Date());
		expect([first.length, first[0], first.at(-1)]).toEqual([100, "2026-10-20", "2026-07-13"]);
		expect(await runAggregateJob(env, new Date())).toHaveLength(43);
	});

	it("estimates yesterday from the production job's weather, again whenever it's refreshed", async () => {
		// Just after midnight, when the last of yesterday's satellite readings
		// (Islington's sun never sets here) haven't arrived.
		const midnight = Date.parse("2026-10-26T00:10:00+13:00");
		vi.setSystemTime(midnight);
		mockOpenMeteo();
		await runProductionJob(env, new Date());
		expect(await runAggregateJob(env, new Date())).toEqual(["2026-10-25"]);
		const yesterday = await stored(tenMinuteKey("2026-10-25"));
		expect(yesterday.total.profileMw).toEqual(Array(144).fill(ISL_MW));
		expect(yesterday.attribution).not.toContain("ERA5");
		expect(await runAggregateJob(env, new Date())).toEqual([]);

		// The production job refreshes yesterday's satellite an hour later.
		vi.setSystemTime(midnight + 60 * 60 * 1000);
		await runProductionJob(env, new Date());
		expect(await runAggregateJob(env, new Date())).toEqual(["2026-10-25"]);
		// Today is never added up.
		expect(await env.DATASET.head(tenMinuteKey("2026-10-26"))).toBeNull();
	});

	it("estimates every day again, newest first, once the model changes", async () => {
		mockOpenMeteo();
		await runWeatherArchiveJob(env, new Date());
		await runAggregateJob(env, new Date());

		ROOFTOP.efficiency = 0.9;
		vi.setSystemTime(NOW + 10 * 60 * 1000);
		expect(await runAggregateJob(env, new Date())).toHaveLength(14);
		const day = await stored(tenMinuteKey("2026-10-07"));
		expect(day.time).toBe("2026-10-26T01:10:00.000Z");
		expect(day.total.profileMw[0]).toBeGreaterThan(ISL_MW);
		expect((await stored(energyKey("annual", "all"))).data[0].totalMwh).toBeGreaterThan(ISL_MW * 24 * 14);
	});

	it("estimates again the days whose capacities change", async () => {
		mockOpenMeteo();
		await archiveAll();
		await aggregateAll();

		// EMI revised September's snapshot: days from 30 September are built on it.
		await env.DB.batch([
			env.DB.prepare("UPDATE solar_capacity SET installed_mw = 219.694 WHERE nsp = 'ISL0661ORONGN' AND month_end = '2026-09-30'"),
			env.DB.prepare(
				"INSERT INTO capacity_job_runs (ran_at, latest_month_end, fingerprint, changed) VALUES ('2026-10-26T18:00:00Z', '2026-09-30', 'second', 1)",
			),
		]);
		expect((await runAggregateJob(env, new Date())).sort()).toEqual(
			Array.from({ length: 21 }, (_, i) => new Date(Date.parse("2026-09-30") + i * DAY_MS).toISOString().slice(0, 10)),
		);
		expect((await stored(tenMinuteKey("2026-10-20"))).total.distributedMw).toBeGreaterThan(83.561);
		expect((await stored(tenMinuteKey("2026-09-29"))).total.distributedMw).toBe(83.561);
	});

	it("fetches a day's weather again once a GXP's points have moved, and estimates it again", async () => {
		mockOpenMeteo();
		await archiveAll();
		await aggregateAll();

		// As if the weather had been taken somewhere else.
		const key = archivedWeatherKey("2026-10-20");
		const weather = await stored(key);
		weather.forecast.points.ISL = "-43.0000,172.0000";
		await env.DATASET.put(key, JSON.stringify(weather));
		await env.DB.prepare("UPDATE production_days SET estimated_weather = 'old' WHERE nz_date = '2026-10-20'").run();
		await runAggregateJob(env, new Date());
		expect((await days()).find((day: any) => day.nz_date === "2026-10-20").weather_points_current).toBe(0);

		vi.setSystemTime(NOW + 60 * 60 * 1000);
		expect(await runWeatherArchiveJob(env, new Date())).toEqual(["2026-10-20"]);
		expect(await runAggregateJob(env, new Date())).toEqual(["2026-10-20"]);
		expect((await days()).find((day: any) => day.nz_date === "2026-10-20").weather_points_current).toBe(1);
	});

	it("runs five minutes after the production job from its cron trigger", async () => {
		mockOpenMeteo();
		await runProductionJob(env, new Date());
		const controller = createScheduledController({ cron: "5,15,25,35,45,55 * * * *", scheduledTime: NOW + 5 * 60 * 1000 });
		await worker.scheduled(controller, env, createExecutionContext());
		expect(await stored(tenMinuteKey("2026-10-25"))).toMatchObject({ time: "2026-10-26T01:05:00.000Z" });
	});

	it("fetches archived weather from its own cron trigger", async () => {
		mockOpenMeteo();
		const controller = createScheduledController({ cron: "35 10,14 * * *", scheduledTime: NOW });
		await worker.scheduled(controller, env, createExecutionContext());
		expect(await env.DATASET.head(archivedWeatherKey("2026-10-20"))).not.toBeNull();
	});
});
