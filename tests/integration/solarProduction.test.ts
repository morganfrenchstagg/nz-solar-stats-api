import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import gxpLocations from "../../src/production/gxpLocations.json";

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

// Islington's points: its substation and where Christchurch's people are around it.
const nearIslington = (lat: string, long: string) =>
	Math.abs(Number(lat) - ISLINGTON_LAT) < 0.15 && Math.abs(Number(long) - 172.5) < 0.15;

// The forecast gives Islington 1000 W/m² at 25 °C all day, all of it diffuse
// so every roof gets the same whatever the sun's position, and everywhere
// else none. Like Open-Meteo, it only has about three months back (to `from`)
// to two weeks ahead; `nulls` mimics it sending a day with every value
// missing. The satellite reads `satellite` W/m² at Islington, with readings
// arriving half an hour after they're taken.
function mockOpenMeteo({ nulls = false, status = 200, satellite = 1000, satelliteStatus = 200, from = "2026-07-24" } = {}) {
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
					hourly: sky(
						times,
						times.map((t) => (!arrived(t) ? null : nearIslington(lat, longs[i]) ? satellite : 0)),
					),
				})),
			);
		}
		if (url.hostname !== FORECAST) return new Response("Not found", { status: 404 });
		if (status !== 200) return Response.json({ error: true, reason: "Too many requests" }, { status });
		if (date < from || date > "2026-11-09") {
			return Response.json(
				{ error: true, reason: `Parameter 'start_date' is out of allowed range from ${from} to 2026-11-09` },
				{ status: 400 },
			);
		}

		const times = dayTimes(date, 900);
		return Response.json(
			lats.map((lat, i) => {
				const sunny = nearIslington(lat, longs[i]);
				return {
					minutely_15: {
						...sky(times, times.map(() => (nulls ? null : sunny ? 1000 : 0))),
						temperature_2m: times.map(() => (nulls ? null : sunny ? 25 : 12)),
					},
				};
			}),
		);
	});
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
			// Capacity is flat from August to September, so it isn't grown.
			env.DB.prepare(
				`INSERT INTO solar_capacity (nsp, gxp, month_end, icp_count, installed_mw, dispatched_mw) VALUES
				('ISL0661ORONGN', 'ISL', '2026-08-31', 6838, 209.694, 160.12),
				('ISL0661ORONGN', 'ISL', '2026-09-30', 6958, 209.694, 160.12),
				('ISL0331ORONGN', 'ISL', '2026-08-31', 800, 9.213, 0),
				('ISL0331ORONGN', 'ISL', '2026-09-30', 800, 9.213, 0),
				('ASB0661EASHGN', 'ASB', '2026-08-31', 966, 73.055, 48.281),
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
			attribution: `Weather data by Open-Meteo.com (CC BY 4.0); satellite data from JMA/JAXA Himawari; population from ${gxpLocations.source}`,
			// 58.787 MW of rooftops under 1000 W/m² of overcast at 25 °C
			total: { distributedMw: 83.561, productionMw: 49.414 },
		});
		expect(result.profileTimes).toHaveLength(144);
		expect(result.total.profileMw).toEqual(Array(144).fill(49.414));
		expect(result.gxps.map((gxp: any) => [gxp.gxp, gxp.distributedMw, gxp.productionMw])).toEqual([
			["ISL", 58.787, 49.414],
			["ASB", 24.774, 0],
		]);
		// A panel tilted 20° sees 97.6% of an overcast sky.
		expect(result.gxps[0]).toMatchObject({ irradianceWm2: 975.9, temperatureC: 25 });
	});

	it("asks Open-Meteo for today's NZ forecast of direct and diffuse sunlight at each GXP's population centre", async () => {
		const fetch = mockOpenMeteo();
		await getProduction();

		const url = new URL(String(fetch.mock.calls[0][0]));
		expect(Object.fromEntries(url.searchParams)).toMatchObject({
			latitude: [gxpLocations.gxps.ISL.centre[0], gxpLocations.gxps.ASB.centre[0]].map((lat) => lat.toFixed(4)).join(","),
			minutely_15: "shortwave_radiation_instant,direct_normal_irradiance_instant,diffuse_radiation_instant,temperature_2m",
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
		// Half an hour after the last reading, a quarter of the way back: 1000 × (0.5 + 0.5 × 0.25) = 625 W/m²
		// of overcast, of which a panel tilted 20° gets 97.6%.
		expect(isl.irradianceWm2).toBe(609.9);
		expect(at("15:30")).toBe(49.414); // two hours on, the forecast's own
	});

	it("reads the satellite at each GXP's five most-populated pixels when it's 5 MW or more", async () => {
		const fetch = mockOpenMeteo();
		await getProduction();

		const latitudes = new URL(String(callsTo(fetch, SATELLITE)[0][0])).searchParams.get("latitude")!.split(",");
		expect(latitudes).toEqual(
			[...gxpLocations.gxps.ISL.pixels, ...gxpLocations.gxps.ASB.pixels].map(([lat]) => lat.toFixed(4)),
		);
	});

	it("falls back to the forecast when the satellite fails", async () => {
		mockOpenMeteo({ satellite: 500, satelliteStatus: 500 });
		const { status, result } = await getProduction();

		expect(status).toBe(200);
		expect(result).toMatchObject({ observedUntil: null, total: { productionMw: 49.414 } });
	});

	it("treats /today the same as no date", async () => {
		mockOpenMeteo();
		const { result } = await getProduction("/today");
		expect(result).toMatchObject({ date: "2026-10-26", total: { productionMw: 49.414 } });
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
		expect(result.total.profileMw).toEqual(Array(144).fill(49.414));
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

	it("refetches a past day's weather once a GXP's points have moved", async () => {
		const fetch = mockOpenMeteo();
		await getProduction("/2026-10-20");
		// As if gxpLocations.json had been rebuilt with Islington somewhere else.
		await env.DB.batch([
			env.DB.prepare("UPDATE weather_forecasts SET forecast = json_set(forecast, '$.points.ISL', '-43.5000,172.5000')"),
			env.DB.prepare("UPDATE satellite_irradiance SET data = json_set(data, '$.pixels.ISL', '-43.5000,172.5000,1')"),
		]);
		await getProduction("/2026-10-20");
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([2, 2]);

		// Taken in the right places again, it's kept for good.
		await getProduction("/2026-10-20");
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([2, 2]);
	});

	it("refetches weather cached before it recorded where it was taken", async () => {
		const fetch = mockOpenMeteo();
		await getProduction("/2026-10-20");
		await env.DB.batch([
			env.DB.prepare("UPDATE weather_forecasts SET forecast = json_remove(forecast, '$.points')"),
			env.DB.prepare("UPDATE satellite_irradiance SET data = json_remove(data, '$.pixels')"),
		]);
		await getProduction("/2026-10-20");
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([2, 2]);
	});

	it("keeps a day's forecast from a GXP's old points once Open-Meteo no longer has the day", async () => {
		mockOpenMeteo();
		const before = await getProduction("/2026-10-20");
		await env.DB.prepare("UPDATE weather_forecasts SET forecast = json_set(forecast, '$.points.ISL', '-43.5000,172.5000')").run();

		vi.restoreAllMocks();
		const fetch = mockOpenMeteo({ from: "2026-10-21" });
		const { status, result } = await getProduction("/2026-10-20");

		expect(status).toBe(200);
		expect(callsTo(fetch, FORECAST)).toHaveLength(1);
		expect(result.total.profileMw).toEqual(before.result.total.profileMw);
	});

	it("uses satellite readings from a GXP's old pixels when a refetch fails, if they cover every GXP", async () => {
		mockOpenMeteo({ satellite: 500 });
		await getProduction();
		await env.DB.prepare("UPDATE satellite_irradiance SET data = json_set(data, '$.pixels.ISL', '-43.5000,172.5000,1')").run();
		vi.restoreAllMocks();
		mockOpenMeteo({ satelliteStatus: 500 });
		expect((await getProduction()).result.observedUntil).toBe("2026-10-26T00:30:00.000Z");

		// Without Islington's readings there's nothing to fall back to but the forecast.
		await env.DB.prepare("UPDATE satellite_irradiance SET data = json_remove(data, '$.locations.ISL')").run();
		const { status, result } = await getProduction();
		expect(status).toBe(200);
		expect(result).toMatchObject({ observedUntil: null, total: { productionMw: 49.414 } });
	});

	it("fetches a day cached in an older format again, and never falls back to it", async () => {
		const fetch = mockOpenMeteo();
		await getProduction("/2026-10-20");
		const stripFormat = env.DB.prepare("UPDATE weather_forecasts SET forecast = json_remove(forecast, '$.format')");
		await stripFormat.run();
		expect((await getProduction("/2026-10-20")).status).toBe(200);
		expect(callsTo(fetch, FORECAST)).toHaveLength(2);

		// Once Open-Meteo no longer has the day, an old copy can't stand in.
		await stripFormat.run();
		vi.restoreAllMocks();
		mockOpenMeteo({ from: "2026-10-21" });
		expect((await getProduction("/2026-10-20")).status).toBe(404);
	});

	it("forecasts a future day without the satellite, refreshing every three hours", async () => {
		const fetch = mockOpenMeteo();
		const { result } = await getProduction("/2026-10-30");
		expect(result).toMatchObject({ date: "2026-10-30", capacityMonthEnd: "2026-09-30", observedUntil: null, total: { productionMw: null } });

		vi.setSystemTime(NOW + 181 * MINUTE);
		await getProduction("/2026-10-30");
		expect([callsTo(fetch, FORECAST).length, callsTo(fetch, SATELLITE).length]).toEqual([2, 0]);
	});

	it("builds on the last month-end snapshot before the date", async () => {
		mockOpenMeteo();
		const { result } = await getProduction("/2026-09-15");

		expect(result.capacityMonthEnd).toBe("2026-08-31");
		expect(result.gxps.map((gxp: any) => [gxp.gxp, gxp.distributedMw])).toEqual([
			["ISL", 58.787],
			["ASB", 24.774],
		]);
	});

	it("grows each GXP's capacity since its last snapshot at its recent rate", async () => {
		// Islington grew 2 MW from August to September.
		await env.DB.prepare(
			"UPDATE solar_capacity SET installed_mw = 207.694 WHERE nsp = 'ISL0661ORONGN' AND month_end = '2026-08-31'",
		).run();
		mockOpenMeteo();
		const { result } = await getProduction();
		const isl = result.gxps.find((gxp: any) => gxp.gxp === "ISL");

		expect(isl.growthMwPerMonth).toBe(2);
		// 26 days after the 30 September snapshot.
		expect(isl.distributedMw).toBe(Math.round((58.787 + 2 * (26 / (365.25 / 12))) * 1000) / 1000);
		expect(result.gxps.find((gxp: any) => gxp.gxp === "ASB")).toMatchObject({ distributedMw: 24.774, growthMwPerMonth: 0 });
	});

	it("models a GXP's farm-sized steps as a farm", async () => {
		await env.DB.prepare(
			"UPDATE solar_capacity SET step_mw = 10 WHERE nsp = 'ISL0331ORONGN' AND month_end = '2026-08-31'",
		).run();
		mockOpenMeteo();
		const { result } = await getProduction();

		expect(result.total).toMatchObject({ distributedMw: 83.561, farmMw: 10 });
		// 48.787 MW of rooftops and a 10 MW farm, which puts out more per MW.
		expect(result.gxps[0]).toMatchObject({ gxp: "ISL", distributedMw: 58.787, farmMw: 10, productionMw: 50.748 });
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
