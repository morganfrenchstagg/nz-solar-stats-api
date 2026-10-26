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

	it("takes a grid-connected farm's steps at nearby NSPs out of distributed solar", async () => {
		// Tauhei, commissioned in May 2026 at Waihou 110 kV, also turned up in the
		// registry at Piako and Waihou's 33 kV NSP that month.
		const csv = [
			...emiCsv.split("\r\n").slice(0, 13),
			"31/03/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),315,4.71134,2.712,8.609,5,9.048",
			"31/03/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),269,3.85111,4.098,15.233,5,9.040",
			"30/04/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),316,4.71360,2.727,8.631,1,9.990",
			"30/04/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),276,3.95529,4.171,15.112,7,8.869",
			"31/05/2026,PAO1101POCOGN,PAO1101POCOGN,All combined,Solar (All),332,4.94121,20.709,62.376,16,568.534",
			"31/05/2026,WHU0331POCOGN,WHU0331POCOGN,All combined,Solar (All),281,4.01888,8.562,30.470,5,878.196",
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
		const result = await runCapacityJob(env, now);

		expect(result.farmsNotInEmi).toEqual([]);
		const steps = await env.DB.prepare("SELECT nsp, month_end, round(mw, 1) AS mw FROM dispatched_solar_steps ORDER BY nsp").all();
		expect(steps.results).toEqual([
			{ nsp: "PAO1101POCOGN", month_end: "2026-05-31", mw: 17.8 },
			{ nsp: "WHU0331POCOGN", month_end: "2026-05-31", mw: 4.3 },
		]);
		const may = await env.DB.prepare(
			"SELECT gxp, round(distributed_mw, 3) AS distributed, step_mw FROM solar_capacity WHERE month_end = '2026-05-31' ORDER BY gxp",
		).all();
		// What's left is April's rooftops plus May's new ones.
		expect(may.results).toEqual([
			{ gxp: "PAO", distributed: 2.879, step_mw: 0 },
			{ gxp: "WHU", distributed: 4.216, step_mw: 0 },
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
