import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modelFingerprint } from "../../src/aggregates/model";
import { energyKey } from "../../src/aggregates/store";

// 2pm on Monday 26 October in NZ.
const NOW = Date.parse("2026-10-26T01:00:00Z");

async function getEnergy(path: string) {
	const response = await SELF.fetch(`http://local.test/solar-energy${path}`);
	const body = await response.json<{ success: boolean; result: any; errors?: { message: string }[] }>();
	return { status: response.status, body, cacheControl: response.headers.get("Cache-Control") };
}

const day = (from: string, gxps: Record<string, number>) => ({
	from,
	to: from,
	days: 1,
	totalMwh: Object.values(gxps).reduce((total, mwh) => total + mwh, 0),
	gxps,
});

describe("GET /solar-energy/...", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		const { objects } = await env.DATASET.list();
		if (objects.length > 0) await env.DATASET.delete(objects.map((object) => object.key));
		// Ashburton had no solar on the 1st.
		await env.DATASET.put(
			energyKey("daily", "2026-10"),
			JSON.stringify({ data: [day("2026-10-01", { ISL: 100 }), day("2026-10-02", { ISL: 120, ASB: 200 })] }),
		);
		await env.DATASET.put(
			energyKey("annual", "all"),
			JSON.stringify({ data: [{ ...day("2026-01-01", { ISL: 220, ASB: 200 }), to: "2026-12-31", days: 2 }] }),
		);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("serves a month's days as a series per GXP, the most energy first", async () => {
		const { status, body } = await getEnergy("/daily/2026-10");

		expect(status).toBe(200);
		expect(body.result).toEqual({
			series: ["ISL", "ASB"],
			data: [
				{ from: "2026-10-01", to: "2026-10-01", days: 1, totalMwh: 100, mwh: [100, 0] },
				{ from: "2026-10-02", to: "2026-10-02", days: 1, totalMwh: 320, mwh: [120, 200] },
			],
		});
	});

	it("serves every year", async () => {
		const { body } = await getEnergy("/annual");
		expect(body.result.data).toEqual([{ from: "2026-01-01", to: "2026-12-31", days: 2, totalMwh: 420, mwh: [220, 200] }]);
	});

	it.each(["/weekly/2025", "/monthly/2025", "/daily/2015-01"])("returns 404 for %s, which has nothing estimated", async (path) => {
		const { status, body } = await getEnergy(path);
		expect(status).toBe(404);
		expect(body.errors![0].message).toMatch(/^No (weekly|monthly|daily) energy for (2025|2015-01)$/);
	});

	it.each(["/daily/2026-13", "/daily/2026", "/monthly/26", "/weekly/2026-10"])("rejects %s", async (path) => {
		expect((await getEnergy(path)).status).toBe(400);
	});

	it.each(["/daily/2026-10", "/weekly/2026", "/monthly/2026", "/annual"])(
		"caches %s, which has yesterday in it, for an hour and then until the aggregate job's next run",
		async (path) => {
			await env.DATASET.put(energyKey("weekly", "2026"), JSON.stringify({ data: [] }));
			await env.DATASET.put(energyKey("monthly", "2026"), JSON.stringify({ data: [] }));
			// Its 02:05 UTC run, allowed two minutes.
			expect((await getEnergy(path)).cacheControl).toBe("public, max-age=4020");
		},
	);

	it.each(["/daily/2026-09", "/weekly/2025", "/monthly/2025"])(
		"caches %s, which ended before yesterday, until the weather archive job could change it",
		async (path) => {
			await env.DATASET.put(energyKey("daily", "2026-09"), JSON.stringify({ data: [] }));
			await env.DATASET.put(energyKey("weekly", "2025"), JSON.stringify({ data: [] }));
			await env.DATASET.put(energyKey("monthly", "2025"), JSON.stringify({ data: [] }));
			// Its 10:35 UTC run, allowing for the aggregate job's run after.
			expect((await getEnergy(path)).cacheControl).toBe("public, max-age=35700");
		},
	);

	it("keeps a month live until yesterday's left it", async () => {
		// Just after midnight on 1 November in NZ: October's last day is yet to
		// be estimated.
		vi.setSystemTime(Date.parse("2026-10-31T11:02:00Z"));
		// To the aggregate job's 12:05 UTC run, allowed two minutes.
		expect((await getEnergy("/daily/2026-10")).cacheControl).toBe("public, max-age=3900");
		// A day later, it waits for the archive job's 14:35 UTC run.
		vi.setSystemTime(Date.parse("2026-11-01T11:02:00Z"));
		expect((await getEnergy("/daily/2026-10")).cacheControl).toBe("public, max-age=13980");
	});

	it("doesn't cache a period with nothing estimated, or a bad one", async () => {
		expect((await getEnergy("/weekly/2025")).cacheControl).toBe("no-store");
		expect((await getEnergy("/daily/2026-13")).cacheControl).toBe("no-store");
	});
});

describe("GET /solar-energy", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		const model = await modelFingerprint();
		await env.DB.batch([
			env.DB.prepare("DELETE FROM production_days"),
			env.DB.prepare("DELETE FROM solar_capacity"),
			env.DB.prepare(
				`INSERT INTO solar_capacity (nsp, gxp, month_end, icp_count, installed_mw, dispatched_mw) VALUES
				('ISL0661ORONGN', 'ISL', '2026-09-30', 6958, 209.694, 160.12)`,
			),
			// Two days estimated, one of them since with new weather; one waiting
			// to be estimated; and one the archive didn't have.
			env.DB.prepare(
				`INSERT INTO production_days (nz_date, weather, model, capacity, estimated_weather) VALUES
				('2026-10-23', 'r2 a', ?1, 'c', 'r2 a'),
				('2026-10-24', 'r2 b', ?1, 'c', 'r2 a'),
				('2026-10-25', 'd1 a', NULL, NULL, NULL),
				('2026-10-22', NULL, NULL, NULL, NULL)`,
			).bind(model),
		]);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("says how far the backfill has got", async () => {
		const { status, body, cacheControl } = await getEnergy("");

		expect(status).toBe(200);
		// Until the aggregate job's 01:05 UTC run, allowed two minutes.
		expect(cacheControl).toBe("public, max-age=420");
		expect(body.result).toEqual({
			backfillFrom: "2026-09-30",
			estimatedFrom: "2026-10-23",
			estimatedTo: "2026-10-24",
			estimatedDays: 2,
			// 30 September to 25 October, less the three days with weather.
			awaitingWeatherDays: 23,
			recalculatingDays: 2,
		});
	});
});
