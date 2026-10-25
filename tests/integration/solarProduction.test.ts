import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ISLINGTON_LAT = -43.5;
// 2pm on Monday 26 October in NZ.
const NOW = Date.parse("2026-10-26T01:00:00Z");
const MINUTE = 60 * 1000;

// Islington gets full sun at 25 °C all day; everywhere else is dark. Like
// Open-Meteo, only about three months back and two weeks ahead are available.
// `nulls` mimics Open-Meteo sending a day with every value missing.
function mockOpenMeteo({ nulls = false, status = 200 } = {}) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		if (url.hostname !== "api.open-meteo.com") return new Response("Not found", { status: 404 });
		if (status !== 200) return Response.json({ error: true, reason: "Too many requests" }, { status });
		const date = url.searchParams.get("start_date")!;
		if (date < "2026-07-24" || date > "2026-11-09") {
			return Response.json(
				{ error: true, reason: "Parameter 'start_date' is out of allowed range from 2026-07-24 to 2026-11-09" },
				{ status: 400 },
			);
		}

		const times = Array.from({ length: 96 }, (_, index) => 1_792_000_000 + index * 900);
		const forecasts = url.searchParams
			.get("latitude")!
			.split(",")
			.map((lat) => {
				const sunny = Number(lat) === ISLINGTON_LAT;
				return {
					minutely_15: {
						time: times,
						global_tilted_irradiance_instant: times.map(() => (nulls ? null : sunny ? 1000 : 0)),
						temperature_2m: times.map(() => (nulls ? null : sunny ? 25 : 12)),
					},
				};
			});
		return Response.json(forecasts);
	});
}

async function getProduction(path = "") {
	const response = await SELF.fetch(`http://local.test/solar-production${path}`);
	const body = await response.json<{ result: any; errors?: { message: string }[] }>();
	return { status: response.status, result: body.result, errors: body.errors };
}

describe("GET /solar-production[/{date}]", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		// D1 state is shared between tests, so start each one from the same data.
		await env.DB.batch([
			env.DB.prepare("DELETE FROM gxps"),
			env.DB.prepare("DELETE FROM solar_capacity"),
			env.DB.prepare("DELETE FROM weather_forecasts"),
			env.DB.prepare(
				`INSERT INTO gxps (site_id, name, type, island, lat, long) VALUES
				('ISL', 'Islington', 'ACSTN', 'south', ${ISLINGTON_LAT}, 172.5),
				('ASB', 'Ashburton', 'ACSTN', 'south', -43.9, 171.8),
				('WAI', 'Waiotahe', 'ACSTN', 'north', -38.0, 177.0)`,
			),
			// WAI's solar is all a dispatched farm, so it has nothing to estimate.
			env.DB.prepare(
				`INSERT INTO solar_capacity (nsp, gxp, month_end, icp_count, installed_mw, dispatched_mw) VALUES
				('ISL0661ORONGN', 'ISL', '2026-08-31', 6838, 208.725, 160.12),
				('ISL0661ORONGN', 'ISL', '2026-09-30', 6958, 209.694, 160.12),
				('ISL0331ORONGN', 'ISL', '2026-09-30', 800, 9.213, 0),
				('ASB0661EASHGN', 'ASB', '2026-09-30', 966, 73.055, 48.281),
				('WAI0331HEDLGN', 'WAI', '2026-09-30', 1, 5, 5)`,
			),
		]);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("estimates each GXP's output now and through today", async () => {
		mockOpenMeteo();
		const { status, result } = await getProduction();

		expect(status).toBe(200);
		expect(result).toMatchObject({
			date: "2026-10-26",
			capacityMonthEnd: "2026-09-30",
			attribution: "Weather data by Open-Meteo.com (CC BY 4.0)",
			// 58.787 MW × 1.2 DC:AC × 0.83 × 0.88 for cell heating
			total: { distributedMw: 83.561, productionMw: 51.526 },
		});
		expect(result.profileTimes).toHaveLength(96);
		expect(result.total.profileMw).toEqual(Array(96).fill(51.526));
		expect(result.gxps.map((gxp: any) => [gxp.gxp, gxp.distributedMw, gxp.productionMw])).toEqual([
			["ISL", 58.787, 51.526],
			["ASB", 24.774, 0],
		]);
		expect(result.gxps[0]).toMatchObject({ irradianceWm2: 1000, temperatureC: 25 });
	});

	it("asks Open-Meteo for today's NZ forecast on a north-facing tilted panel", async () => {
		const fetch = mockOpenMeteo();
		await getProduction();

		const url = new URL(String(fetch.mock.calls[0][0]));
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			latitude: "-43.5000,-43.9000",
			minutely_15: "global_tilted_irradiance_instant,temperature_2m",
			tilt: "20",
			azimuth: "180",
			start_date: "2026-10-26",
			end_date: "2026-10-26",
			timeformat: "unixtime",
		});
	});

	it("reuses today's forecast for an hour", async () => {
		const fetch = mockOpenMeteo();
		await getProduction();
		vi.setSystemTime(NOW + 30 * MINUTE);
		await getProduction();
		expect(fetch).toHaveBeenCalledTimes(1);

		vi.setSystemTime(NOW + 61 * MINUTE);
		await getProduction();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("treats /today the same as no date", async () => {
		mockOpenMeteo();
		const { result } = await getProduction("/today");
		expect(result).toMatchObject({ date: "2026-10-26", total: { productionMw: 51.526 } });
	});

	it("estimates the whole of yesterday, with no live values", async () => {
		const fetch = mockOpenMeteo();
		const { status, result } = await getProduction("/yesterday");

		expect(status).toBe(200);
		expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("start_date")).toBe("2026-10-25");
		expect(result).toMatchObject({
			date: "2026-10-25",
			total: { distributedMw: 83.561, productionMw: null },
		});
		expect(result.total.profileMw).toEqual(Array(96).fill(51.526));
		expect(result.gxps[0]).toMatchObject({
			gxp: "ISL",
			productionMw: null,
			irradianceWm2: null,
			temperatureC: null,
		});
	});

	it("keeps a past day's weather once the day is over", async () => {
		const fetch = mockOpenMeteo();
		await getProduction("/2026-10-20");
		vi.setSystemTime(NOW + 5 * 60 * MINUTE);
		const { result } = await getProduction("/2026-10-20");

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ date: "2026-10-20", total: { productionMw: null } });
	});

	it("forecasts a future day, refreshing it hourly", async () => {
		const fetch = mockOpenMeteo();
		const { result } = await getProduction("/2026-10-30");
		expect(result).toMatchObject({ date: "2026-10-30", capacityMonthEnd: "2026-09-30", total: { productionMw: null } });

		vi.setSystemTime(NOW + 61 * MINUTE);
		await getProduction("/2026-10-30");
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("uses the capacity as at the last month end before the date", async () => {
		mockOpenMeteo();
		const { result } = await getProduction("/2026-09-15");

		expect(result.capacityMonthEnd).toBe("2026-08-31");
		expect(result.gxps.map((gxp: any) => [gxp.gxp, gxp.distributedMw])).toEqual([["ISL", 48.605]]);
	});

	it("returns 404 with Open-Meteo's range for a date it has no weather for", async () => {
		mockOpenMeteo();
		const { status, errors } = await getProduction("/2026-12-25");

		expect(status).toBe(404);
		expect(errors![0].message).toBe(
			"Open-Meteo has no weather for 2026-12-25: Parameter 'start_date' is out of allowed range from 2026-07-24 to 2026-11-09",
		);
	});

	it("returns 502 without caching when Open-Meteo sends weather with gaps", async () => {
		mockOpenMeteo({ nulls: true });
		const { status, errors } = await getProduction("/2026-10-20");
		expect(status).toBe(502);
		expect(errors![0].message).toBe("Open-Meteo sent weather with gaps for 2026-10-20; try again later");

		// The day is over, so a cached copy would never be refetched.
		vi.restoreAllMocks();
		mockOpenMeteo();
		const retry = await getProduction("/2026-10-20");
		expect(retry.status).toBe(200);
		expect(retry.result.total.profileMw[0]).toBeGreaterThan(0);
	});

	it("returns 502 when Open-Meteo fails", async () => {
		mockOpenMeteo({ status: 429 });
		const { status } = await getProduction();
		expect(status).toBe(502);
	});

	it("returns 404 for a date before any capacity data", async () => {
		const fetch = mockOpenMeteo();
		const { status } = await getProduction("/2020-01-01");

		expect(status).toBe(404);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["/tomorrow", "/26-10-2026", "/2026-13-01"])("rejects %s as a date", async (path) => {
		const { status } = await getProduction(path);
		expect(status).toBe(400);
	});

	it("returns 404 before the capacity job has run", async () => {
		await env.DB.prepare("DELETE FROM solar_capacity").run();
		const { status } = await getProduction();
		expect(status).toBe(404);
	});
});
