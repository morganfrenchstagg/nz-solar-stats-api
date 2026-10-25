import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOutputs, parseSearch, parseSystem, PvOutput, PvOutputError } from "../../scripts/pvoutput.ts";

// Examples from https://pvoutput.org/help/api_specification.html
describe("parseSearch", () => {
	it("reads each system", () => {
		const body = [
			"Albany Creek Enphase,9990,4035,N,181,Today,78641,Longi 370,Enphase IQ7+,NaN,-27.345529,152.968403",
			"Albion Enphase,6660,4010,EW,164,Today,79034,Longi 370,Enphase IQ7+,12,-27.428026,153.045205",
		].join("\n");

		expect(parseSearch(body)).toEqual([
			{ systemId: "78641", name: "Albany Creek Enphase", sizeW: 9990, orientation: "N", outputs: 181, lastOutput: "Today", distanceKm: null, lat: -27.345529, long: 152.968403 },
			{ systemId: "79034", name: "Albion Enphase", sizeW: 6660, orientation: "EW", outputs: 164, lastOutput: "Today", distanceKm: 12, lat: -27.428026, long: 153.045205 },
		]);
	});

	it("copes with commas in names", () => {
		const [system] = parseSearch("Smith, Riccarton,5200,8041,NW,90,2 days ago,123456,REC,Fronius,4,-43.53,172.59");
		expect(system).toMatchObject({ name: "Smith, Riccarton", sizeW: 5200, orientation: "NW", systemId: "123456", distanceKm: 4 });
	});
});

describe("parseSystem", () => {
	it("reads the system's size, inverter and orientation", () => {
		expect(
			parseSystem("PVOutput Demo,3200,2162,10,320,Enertech,1,5000,Fronius,N,20.0,No,20120228,-33.868135,151.133423,5;;0"),
		).toEqual({
			name: "PVOutput Demo",
			sizeW: 3200,
			inverterW: 5000,
			orientation: "N",
			tiltDegrees: 20,
			shade: "No",
			lat: -33.868135,
			long: 151.133423,
		});
	});

	it("treats NaN as unknown", () => {
		const system = parseSystem("Shed,4000,8041,10,400,REC,1,NaN,Fronius,NE,NaN,Low,,-43.5,172.6,5");
		expect(system).toMatchObject({ inverterW: null, tiltDegrees: null, orientation: "NE" });
	});
});

describe("parseOutputs", () => {
	it("reads each day's generation", () => {
		expect(
			parseOutputs("20210218,479,0.213,0,0,1500,11:10,Showers,NaN,NaN,NaN,NaN,NaN,NaN;20210217,NaN,NaN,0,0,0,,,NaN,NaN;"),
		).toEqual([
			{ date: "2021-02-18", generatedWh: 479 },
			{ date: "2021-02-17", generatedWh: null },
		]);
	});
});

describe("PvOutput", () => {
	afterEach(() => vi.restoreAllMocks());

	it("asks for other systems with sid1 but its own without", async () => {
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async () => new Response("20261001,1000,0.2,0,0,500,12:00,Fine;"));
		const client = new PvOutput("key", "111");

		await client.outputs("111", "2026-10-01", "2026-10-01");
		await client.outputs("222", "2026-10-01", "2026-10-01");

		const urls = fetch.mock.calls.map(([input]) => new URL(String(input)));
		expect(urls[0].searchParams.has("sid1")).toBe(false);
		expect(urls[1].searchParams.get("sid1")).toBe("222");
		expect(fetch.mock.calls[0][1]?.headers).toMatchObject({ "X-Pvoutput-Apikey": "key", "X-Pvoutput-SystemId": "111" });
	});

	it("splits long ranges into 50-day requests", async () => {
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(""));
		await new PvOutput("key", "111").outputs("111", "2026-08-01", "2026-10-25");

		const ranges = fetch.mock.calls.map(([input]) => {
			const params = new URL(String(input)).searchParams;
			return [params.get("df"), params.get("dt")];
		});
		expect(ranges).toEqual([
			["20260801", "20260919"],
			["20260920", "20261025"],
		]);
	});

	it("recognises a refusal for want of Donation mode", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Forbidden 403: Donation Mode", { status: 403 }));
		const error = await new PvOutput("key", "111").system("222").catch((e) => e);

		expect(error).toBeInstanceOf(PvOutputError);
		expect(error.needsDonationMode).toBe(true);
	});
});
