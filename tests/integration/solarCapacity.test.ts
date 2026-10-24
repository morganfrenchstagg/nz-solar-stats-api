import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

describe("Solar capacity API", () => {
	beforeEach(async () => {
		// D1 state is shared between tests, so start each one from the same data.
		await env.DB.batch([
			env.DB.prepare("DELETE FROM gxps"),
			env.DB.prepare("DELETE FROM solar_capacity"),
			env.DB.prepare("DELETE FROM dispatched_solar_steps"),
			env.DB.prepare(
				`INSERT INTO gxps (site_id, name, type, island, lat, long) VALUES
				('ISL', 'Islington', 'ACSTN', 'south', -43.5, 172.5),
				('ASB', 'Ashburton', 'ACSTN', 'south', -43.9, 171.8)`,
			),
			env.DB.prepare(
				`INSERT INTO solar_capacity (nsp, gxp, month_end, icp_count, installed_mw, dispatched_mw) VALUES
				('ISL0661ORONGN', 'ISL', '2026-06-30', 6582, 46.532, 0),
				('ISL0331ORONGN', 'ISL', '2026-06-30', 728, 8.499, 0),
				('ISL0661ORONGN', 'ISL', '2026-07-31', 6714, 207.662, 160.12),
				('ISL0331ORONGN', 'ISL', '2026-07-31', 760, 8.783, 0),
				('ASB0661EASHGN', 'ASB', '2026-07-31', 924, 72.288, 54.651)`,
			),
			env.DB.prepare(
				`INSERT INTO dispatched_solar_steps (node, name, nsp, month_end, mw) VALUES
				('ISL0661 KPS0', 'Kōwhai Park', 'ISL0661ORONGN', '2026-07-31', 160.12),
				('ASB0661 LAU0', 'Lauriston', 'ASB0661EASHGN', '2024-11-30', 48.281)`,
			),
		]);
	});

	describe("GET /solar-capacity", () => {
		it("returns every GXP at the latest month, summing their NSPs", async () => {
			const response = await SELF.fetch("http://local.test/solar-capacity");
			const body = await response.json<{ success: boolean; result: any }>();

			expect(response.status).toBe(200);
			expect(body.result).toEqual({
				monthEnd: "2026-07-31",
				total: { icpCount: 8398, installedMw: 288.733, dispatchedMw: 214.771, distributedMw: 73.962 },
				gxps: [
					{ gxp: "ISL", name: "Islington", icpCount: 7474, installedMw: 216.445, dispatchedMw: 160.12, distributedMw: 56.325 },
					{ gxp: "ASB", name: "Ashburton", icpCount: 924, installedMw: 72.288, dispatchedMw: 54.651, distributedMw: 17.637 },
				],
			});
		});

		it("returns an earlier month when asked", async () => {
			const response = await SELF.fetch("http://local.test/solar-capacity?month=2026-06");
			const body = await response.json<{ success: boolean; result: any }>();

			expect(response.status).toBe(200);
			expect(body.result.monthEnd).toBe("2026-06-30");
			expect(body.result.gxps).toEqual([
				{ gxp: "ISL", name: "Islington", icpCount: 7310, installedMw: 55.031, dispatchedMw: 0, distributedMw: 55.031 },
			]);
		});

		it("returns 404 for a month with no data", async () => {
			const response = await SELF.fetch("http://local.test/solar-capacity?month=2030-01");
			expect(response.status).toBe(404);
		});

		it("returns 400 for a malformed month", async () => {
			const response = await SELF.fetch("http://local.test/solar-capacity?month=July");
			expect(response.status).toBe(400);
		});
	});

	describe("GET /solar-capacity/{gxp}", () => {
		it("returns the GXP's monthly history and dispatched farms", async () => {
			const response = await SELF.fetch("http://local.test/solar-capacity/isl");
			const body = await response.json<{ success: boolean; result: any }>();

			expect(response.status).toBe(200);
			expect(body.result).toEqual({
				gxp: "ISL",
				name: "Islington",
				months: [
					{ monthEnd: "2026-06-30", icpCount: 7310, installedMw: 55.031, dispatchedMw: 0, distributedMw: 55.031 },
					{ monthEnd: "2026-07-31", icpCount: 7474, installedMw: 216.445, dispatchedMw: 160.12, distributedMw: 56.325 },
				],
				dispatchedSteps: [
					{ node: "ISL0661 KPS0", name: "Kōwhai Park", nsp: "ISL0661ORONGN", monthEnd: "2026-07-31", mw: 160.12 },
				],
			});
		});

		it("returns 404 for a GXP with no solar data", async () => {
			const response = await SELF.fetch("http://local.test/solar-capacity/XYZ");
			expect(response.status).toBe(404);
		});
	});
});
