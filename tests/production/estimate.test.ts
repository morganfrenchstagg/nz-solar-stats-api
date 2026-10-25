import { describe, expect, it } from "vitest";
import { estimateOutputMw, estimateProduction } from "../../src/production/estimate";

describe("estimateOutputMw", () => {
	it("is zero in the dark", () => {
		expect(estimateOutputMw(10, 0, 15)).toBe(0);
	});

	it("allows for panel oversizing, losses and cell heating in full sun", () => {
		// 1.2 DC:AC × 0.83 efficiency × (1 − 0.4% × 30 °C of cell heating)
		expect(estimateOutputMw(10, 1000, 25)).toBeCloseTo(8.7648, 4);
	});

	it("produces less on a hot day", () => {
		expect(estimateOutputMw(10, 800, 30)).toBeLessThan(estimateOutputMw(10, 800, 10));
	});

	it("never exceeds the inverters' rating", () => {
		expect(estimateOutputMw(10, 1400, 0)).toBe(10);
	});
});

describe("estimateProduction", () => {
	const weather = {
		date: "2026-10-25",
		fetchedAt: "2026-10-24T23:00:00.000Z",
		times: [0, 900_000, 1_800_000],
		locations: { ISL: { irradianceWm2: [0, 1000, 0], temperatureC: [25, 25, 25] } },
	};
	const gxps = [{ gxp: "ISL", name: "Islington", distributedMw: 10 }];

	it("interpolates the forecast to now and estimates every interval", () => {
		const [isl] = estimateProduction(gxps, weather, new Date(450_000));

		expect(isl).toEqual({
			gxp: "ISL",
			name: "Islington",
			distributedMw: 10,
			irradianceWm2: 500,
			temperatureC: 25,
			productionMw: Math.round(estimateOutputMw(10, 500, 25) * 1000) / 1000,
			profileMw: [0, 8.765, 0],
		});
	});

	it("uses the nearest forecast outside the day", () => {
		expect(estimateProduction(gxps, weather, new Date(-1))[0].productionMw).toBe(0);
	});

	it("leaves out the live values for a whole day", () => {
		expect(estimateProduction(gxps, weather, null)).toEqual([
			{
				gxp: "ISL",
				name: "Islington",
				distributedMw: 10,
				productionMw: null,
				irradianceWm2: null,
				temperatureC: null,
				profileMw: [0, 8.765, 0],
			},
		]);
	});
});
