import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCapacityJob } from "../../src/capacity/job";

// Trimmed from a real EMI download, CRLF line endings included.
const emiCsv = [
	"Installed distributed generation trends",
	"",
	"From www.emi.ea.govt.nz provided by the Electricity Authority (New Zealand)",
	"Run at: 20261024214857",
	"",
	"Parameters",
	"Date range,01 Sep 2013 - 30 Sep 2026",
	"Region type,Root NSP",
	"Market segment,All ICPs",
	"Capacity,All combined",
	"Fuel type,Solar (all)",
	"",
	"Month end,Region ID,Region name,Capacity,Fuel type,ICP count,ICP uptake rate (%),Total capacity installed (MW),Avg. capacity installed (kW),ICP count - new installations,Avg. capacity - new installations (kW)",
	"30/06/2026,ISL0661ORONGN,ISL0661ORONGN,All combined,Solar (All),6582,4.33934,46.532,7.070,143,7.673",
	"30/06/2026,WAI0331HEDLGN,WAI0331HEDLGN,All combined,Solar (All),14,1.22485,0.073,5.224,1,5.000",
	"31/07/2026,ISL0661ORONGN,ISL0661ORONGN,All combined,Solar (All),6714,4.41801,207.662,30.930,144,1119.643",
	"31/07/2026,WAI0331HEDLGN,WAI0331HEDLGN,All combined,Solar (All),15,1.31464,0.083,5.543,1,10.000",
	"31/08/2026,ISL0661ORONGN,ISL0661ORONGN,All combined,Solar (All),6838,4.48758,208.725,30.524,128,7.891",
	"31/08/2026,WAI0331HEDLGN,WAI0331HEDLGN,All combined,Solar (All),75,2.38701,0.456,6.086,4,8.500",
	"30/09/2026,ISL0661ORONGN,ISL0661ORONGN,All combined,Solar (All),6958,4.55402,209.694,30.137,112,7.759",
	"30/09/2026,WAI0331HEDLGN,WAI0331HEDLGN,All combined,Solar (All),75,2.39006,0.456,6.086,0,",
	"",
].join("\r\n");

const substations = [
	{ long: 172.5, lat: -43.5, siteId: "ISL", description: "Islington", type: "ACSTN", gridZone: 11, island: "south" },
	{ long: 177.0, lat: -38.0, siteId: "WAI", description: "Waiotahe", type: "ACSTN", gridZone: 5, island: "north" },
];

const generators = [
	{
		site: "KPS",
		name: "Kōwhai Park",
		units: [
			{ name: "Kōwhai Park", unitCode: "KPS0", node: "ISL0661 KPS0", capacity: 150, fuel: "Solar", fuelCode: "SOL", commissioned: "2026-08-13T02:00:00.000Z" },
		],
	},
	{
		site: "COL",
		name: "Coleridge",
		units: [
			{ name: "Coleridge", unitCode: "COL0", node: "COL0661 COL0", capacity: 39, fuel: "Hydro", fuelCode: "HYD", commissioned: "1914-12-31T12:00:00.000Z" },
		],
	},
];

function mockSources(csv = emiCsv, generatorList: unknown[] = generators, substationList = substations) {
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.startsWith("https://www.emi.ea.govt.nz/")) return new Response(csv);
		if (url.endsWith("/v1/substations")) return Response.json(substationList);
		if (url.endsWith("/v1/generators")) return Response.json(generatorList);
		return new Response("Not found", { status: 404 });
	});
}

const now = new Date("2026-10-24T18:00:00Z");

describe("runCapacityJob", () => {
	beforeEach(async () => {
		mockSources();
		// D1 state is shared between tests, so start each one empty.
		await env.DB.batch(
			["gxps", "solar_capacity", "dispatched_solar_steps", "capacity_job_runs"].map((table) =>
				env.DB.prepare(`DELETE FROM ${table}`),
			),
		);
	});
	afterEach(() => vi.restoreAllMocks());

	it("stores each GXP's solar with dispatched farms separated out", async () => {
		const result = await runCapacityJob(env, now);

		expect(result).toMatchObject({ latestMonthEnd: "2026-09-30", changed: true, farmsNotInEmi: [] });
		const { results } = await env.DB.prepare(
			"SELECT month_end, installed_mw, dispatched_mw, distributed_mw FROM solar_capacity WHERE gxp = 'ISL' ORDER BY month_end",
		).all();
		expect(results).toEqual([
			{ month_end: "2026-06-30", installed_mw: 46.532, dispatched_mw: 0, distributed_mw: 46.532 },
			// 161.13 MW added, less 132 new ICPs at June's 7.673 kW average
			{ month_end: "2026-07-31", installed_mw: 207.662, dispatched_mw: 160.117, distributed_mw: 47.545 },
			{ month_end: "2026-08-31", installed_mw: 208.725, dispatched_mw: 160.117, distributed_mw: 48.608 },
			{ month_end: "2026-09-30", installed_mw: 209.694, dispatched_mw: 160.117, distributed_mw: 49.577 },
		]);
		const steps = await env.DB.prepare("SELECT node, nsp, month_end FROM dispatched_solar_steps").all();
		expect(steps.results).toEqual([
			{ node: "ISL0661 KPS0", nsp: "ISL0661ORONGN", month_end: "2026-07-31" },
		]);
		const gxps = await env.DB.prepare("SELECT site_id, name FROM gxps ORDER BY site_id").all();
		expect(gxps.results).toEqual([
			{ site_id: "ISL", name: "Islington" },
			{ site_id: "WAI", name: "Waiotahe" },
		]);
	});

	it("keeps farm-sized steps that aren't dispatched apart from steady growth", async () => {
		// With a solar farm elsewhere in the generators list instead of Kōwhai
		// Park, its step is distributed solar.
		mockSources(emiCsv, [
			...generators.filter((generator) => generator.site !== "KPS"),
			{
				site: "HTR",
				name: "Te Herenga o Te Rā",
				units: [{ name: "Te Herenga o Te Rā", unitCode: "HTR0", node: "WAI0331 HTR0", capacity: 34, fuel: "Solar", fuelCode: "SOL", commissioned: "2024-12-17T06:20:00.000Z" }],
			},
		]);
		await runCapacityJob(env, now);

		const { results } = await env.DB.prepare(
			"SELECT month_end, dispatched_mw, step_mw FROM solar_capacity WHERE nsp = 'ISL0661ORONGN' ORDER BY month_end",
		).all();
		expect(results).toEqual([
			{ month_end: "2026-06-30", dispatched_mw: 0, step_mw: 0 },
			{ month_end: "2026-07-31", dispatched_mw: 0, step_mw: 160.117 },
			{ month_end: "2026-08-31", dispatched_mw: 0, step_mw: 0 },
			{ month_end: "2026-09-30", dispatched_mw: 0, step_mw: 0 },
		]);
	});

	it("follows a grid-connected farm's capacity when the registry moves it", async () => {
		// Tauhei, commissioned in May 2026 at Waihou 110 kV, turned up in the
		// registry at Waihou's 33 kV NSP and Piako that month. Piako's step was
		// half local generation; the registry moved the other half to Waihou in
		// October.
		const csv = [
			...emiCsv.split("\r\n").slice(0, 13),
			"31/03/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),315,4.71134,2.712,8.609,5,9.048",
			"31/03/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),269,3.85111,4.098,15.233,5,9.040",
			"30/04/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),316,4.71360,2.727,8.631,1,9.990",
			"30/04/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),276,3.95529,4.171,15.112,7,8.869",
			"31/05/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),332,4.94121,20.709,62.376,16,568.534",
			"31/05/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),281,4.01888,8.562,30.470,5,878.196",
			"30/09/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),360,5.35834,21.229,58.969,10,21.443",
			"30/09/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),303,4.33677,8.840,29.175,9,16.776",
			"31/10/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),367,5.46254,12.418,33.837,8,11.149",
			"31/10/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),308,4.40834,17.789,57.756,4,12.273",
			"",
		].join("\r\n");
		const tauhei = {
			site: "TAH",
			name: "Tauhei",
			location: { lat: -37.5802, long: 175.7122 },
			units: [{ name: "Tauhei", unitCode: "TAH0", node: "WHU1101 TAH0", capacity: 150, fuel: "Solar", fuelCode: "SOL", commissioned: "2026-05-01T01:15:00.000Z" }],
		};
		mockSources(csv, [tauhei], [
			{ long: 175.5608, lat: -37.6507, siteId: "PAO", description: "Piako", type: "ACSTN", gridZone: 4, island: "north" },
			{ long: 175.6832, lat: -37.5692, siteId: "WHU", description: "Waihou", type: "ACSTN", gridZone: 4, island: "north" },
		]);
		const result = await runCapacityJob(env, new Date("2026-11-22T18:00:00Z"));

		expect(result.farmsNotInEmi).toEqual([]);
		const steps = await env.DB.prepare(
			"SELECT nsp, month_end, round(mw, 1) AS mw FROM dispatched_solar_steps ORDER BY month_end, nsp",
		).all();
		expect(steps.results).toEqual([
			{ nsp: "PAO1101POCOGN", month_end: "2026-05-31", mw: 8.9 },
			{ nsp: "WHU0331POCOGN", month_end: "2026-05-31", mw: 4.3 },
			{ nsp: "PAO1101POCOGN", month_end: "2026-10-31", mw: -8.9 },
			{ nsp: "WHU0331POCOGN", month_end: "2026-10-31", mw: 8.9 },
		]);
		const capacity = await env.DB.prepare(
			"SELECT gxp, month_end, round(distributed_mw, 1) AS distributed, round(step_mw, 1) AS step FROM solar_capacity WHERE month_end >= '2026-05-31' ORDER BY gxp, month_end",
		).all();
		// Piako keeps the local farm from May, and nothing jumps in October.
		expect(capacity.results).toEqual([
			{ gxp: "PAO", month_end: "2026-05-31", distributed: 11.8, step: 8.9 },
			{ gxp: "PAO", month_end: "2026-09-30", distributed: 12.3, step: 0 },
			{ gxp: "PAO", month_end: "2026-10-31", distributed: 12.4, step: 0 },
			{ gxp: "WHU", month_end: "2026-05-31", distributed: 4.2, step: 0 },
			{ gxp: "WHU", month_end: "2026-09-30", distributed: 4.5, step: 0 },
			{ gxp: "WHU", month_end: "2026-10-31", distributed: 4.5, step: 0 },
		]);
	});

	it("stops modelling a farm as one once it leaves the registry", async () => {
		const csv = [
			...emiCsv.split("\r\n").slice(0, 13),
			"30/06/2025,CBG0111WAIPGN,CBG0111WAIPGN,All combined,Solar (All),749,3.38270,5.009,6.688,7,20.114",
			"31/07/2025,CBG0111WAIPGN,CBG0111WAIPGN,All combined,Solar (All),756,3.41372,14.244,18.841,8,1154.765",
			"31/03/2026,CBG0111WAIPGN,CBG0111WAIPGN,All combined,Solar (All),815,3.65859,14.748,18.096,7,13.000",
			"30/04/2026,CBG0111WAIPGN,CBG0111WAIPGN,All combined,Solar (All),820,3.68002,5.626,6.861,5,7.802",
			"",
		].join("\r\n");
		mockSources(csv, generators, [
			{ long: 175.47, lat: -37.88, siteId: "CBG", description: "Cambridge", type: "ACSTN", gridZone: 4, island: "north" },
		]);
		await runCapacityJob(env, now);

		const capacity = await env.DB.prepare(
			"SELECT month_end, round(step_mw, 1) AS step FROM solar_capacity ORDER BY month_end",
		).all();
		expect(capacity.results).toEqual([
			{ month_end: "2025-06-30", step: 0 },
			{ month_end: "2025-07-31", step: 9.1 },
			{ month_end: "2026-03-31", step: 0 },
			{ month_end: "2026-04-30", step: -9.1 },
		]);
	});

	it("only rewrites the tables when the source data has changed", async () => {
		await runCapacityJob(env, now);
		expect((await runCapacityJob(env, now)).changed).toBe(false);

		mockSources(emiCsv.replace("209.694", "210.000"));
		expect((await runCapacityJob(env, now)).changed).toBe(true);

		const runs = await env.DB.prepare("SELECT changed FROM capacity_job_runs ORDER BY id").all();
		expect(runs.results.map((run) => run.changed)).toEqual([1, 0, 1]);
	});

	it("keeps the existing data when EMI returns no rows", async () => {
		await runCapacityJob(env, now);
		mockSources(emiCsv.split("\r\n").slice(0, 13).join("\r\n"));

		await expect(runCapacityJob(env, now)).rejects.toThrow("Refusing to update");
		const count = await env.DB.prepare("SELECT count(*) AS rows FROM solar_capacity").first("rows");
		expect(count).toBe(8);
	});
});
