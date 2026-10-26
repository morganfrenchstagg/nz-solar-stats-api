import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ISLINGTON_LAT = -43.5;
// 2pm on Monday 26 October in NZ.
const NOW = Date.parse("2026-10-26T01:00:00Z");
const MINUTE = 60 * 1000;

const FORECAST = "api.open-meteo.com";
const SATELLITE = "satellite-api.open-meteo.com";

// Every step of an NZ day (in daylight saving, like every date tested here).
function dayTimes(date: string, stepSeconds: number): number[] {
	const midnight = Date.parse(`${date}T00:00:00+13:00`) / 1000;
	return Array.from({ length: 86400 / stepSeconds }, (_, i) => midnight + i * stepSeconds);
}

// Islington's pixels, its own and those around it.
const nearIslington = (lat: string, long: string) =>
	Math.abs(Number(lat) - ISLINGTON_LAT) < 0.06 && Math.abs(Number(long) - 172.5) < 0.07;

// The forecast gives Islington full sun at 25 °C all day, and everywhere else
// none. Like Open-Meteo, it only has about three months back to two weeks
// ahead; `nulls` mimics it sending a day with every value missing. The
// satellite reads `satellite` W/m² at Islington, with readings arriving half
// an hour after they're taken.
function mockOpenMeteo({ nulls = false, status = 200, satellite = 1000, satelliteStatus = 200 } = {}) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input instanceof Request ? input.url : input));
		const date = url.searchParams.get("start_date")!;
		const lats = url.searchParams.get("latitude")?.split(",") ?? [];
		const longs = url.searchParams.get("longitude")?.split(",") ?? [];

		if (url.hostname === SATELLITE) {
			if (satelliteStatus !== 200) return new Response("Server error", { status: satelliteStatus });
			const times = dayTimes(date, 600);
			const arrived = (time: number) => time * 1000 <= Date.now() - 30 * MINUTE;
			return Response.json(
				lats.map((lat, i) => ({
					hourly: {
						time: times,
						global_tilted_irradiance_instant: times.map((t) =>
							!arrived(t) ? null : nearIslington(lat, longs[i]) ? satellite : 0,
						),
					},
				})),
			);
		}
		if (url.hostname !== FORECAST) return new Response("Not found", { status: 404 });
		if (status !== 200) return Response.json({ error: true, reason: "Too many requests" }, { status });
		if (date < "2026-07-24" || date > "2026-11-09") {
			return Response.json(
				{ error: true, reason: "Parameter 'start_date' is out of allowed range from 2026-07-24 to 2026-11-09" },
				{ status: 400 },
			);
		}

		const times = dayTimes(date, 900);
		return Response.json(
			lats.map((lat, i) => {
				const sunny = nearIslington(lat, longs[i]);
				return {
					minutely_15: {
						time: times,
						global_tilted_irradiance_instant: times.map(() => (nulls ? null : sunny ? 1000 : 0)),
						temperature_2m: times.map(() => (nulls ? null : sunny ? 25 : 12)),
					},
				};
			}),
		);
	});
}

function callsTo(fetch: ReturnType<typeof mockOpenMeteo>, hostname: string) {
	return fetch.mock.calls.filter(([input]) => new URL(String(input)).hostname === hostname);
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
			env.DB.prepare("DELETE FROM satellite_irradiance"),
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
			attribution: "Weather data by Open-Meteo.com (CC BY 4.0); satellite data from JMA/JAXA Himawari",
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

	it("reuses today's forecast for three hours and its satellite readings for one", async () => {
		const fetch = mockOpenMeteo();
		await getProduction();
		vi.setSystemTime(NOW + 30 * MINUTE);
		await getProduction();
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([1, 1]);

		vi.setSystemTime(NOW + 61 * MINUTE);
		await getProduction();
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([1, 2]);

		vi.setSystemTime(NOW + 181 * MINUTE);
		await getProduction();
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([2, 3]);
	});

	it("uses satellite readings for what has already happened, fading into the forecast", async () => {
		// The satellite sees half the forecast's sun; its readings to 1:30pm have arrived.
		mockOpenMeteo({ satellite: 500 });
		const { result } = await getProduction();
		const isl = result.gxps[0];
		const at = (clock: string) => isl.profileMw[result.profileTimes.indexOf(new Date(`2026-10-26T${clock}:00+13:00`).toISOString())];

		expect(result.observedUntil).toBe("2026-10-26T00:30:00.000Z");
		expect(at("13:30")).toBe(at("09:00"));
		expect(at("13:30")).toBeLessThan(at("18:00"));
		// Half an hour after the last reading, a quarter of the way back: 1000 × (0.5 + 0.5 × 0.25).
		expect(isl.irradianceWm2).toBe(625);
		expect(at("15:30")).toBe(51.526); // two hours on, the forecast's own
	});

	it("averages five satellite pixels for GXPs of 5 MW or more", async () => {
		const fetch = mockOpenMeteo();
		await getProduction();

		const latitudes = new URL(String(callsTo(fetch, SATELLITE)[0][0])).searchParams.get("latitude")!.split(",");
		expect(latitudes).toEqual(["-43.5000", "-43.4500", "-43.5500", "-43.5000", "-43.5000", "-43.9000", "-43.8500", "-43.9500", "-43.9000", "-43.9000"]);
	});

	it("falls back to the forecast when the satellite fails", async () => {
		mockOpenMeteo({ satellite: 500, satelliteStatus: 500 });
		const { status, result } = await getProduction();

		expect(status).toBe(200);
		expect(result).toMatchObject({ observedUntil: null, total: { productionMw: 51.526 } });
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

	it("keeps a past day's weather once the day is over, all from the satellite", async () => {
		const fetch = mockOpenMeteo();
		await getProduction("/2026-10-20");
		vi.setSystemTime(NOW + 5 * 60 * MINUTE);
		const { result } = await getProduction("/2026-10-20");

		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([1, 1]);
		expect(result).toMatchObject({
			date: "2026-10-20",
			observedUntil: "2026-10-20T10:50:00.000Z",
			total: { productionMw: null },
		});
	});

	it("forecasts a future day without the satellite, refreshing every three hours", async () => {
		const fetch = mockOpenMeteo();
		const { result } = await getProduction("/2026-10-30");
		expect(result).toMatchObject({ date: "2026-10-30", capacityMonthEnd: "2026-09-30", observedUntil: null, total: { productionMw: null } });

		vi.setSystemTime(NOW + 181 * MINUTE);
		await getProduction("/2026-10-30");
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([2, 0]);
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
