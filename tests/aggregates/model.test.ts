import { afterEach, describe, expect, it } from "vitest";
import { modelFingerprint, referenceDay } from "../../src/aggregates/model";
import { FARM, ROOFTOP } from "../../src/production/estimate";

const rooftop = { ...ROOFTOP };
const farm = { ...FARM };

afterEach(() => {
	Object.assign(ROOFTOP, rooftop);
	Object.assign(FARM, farm);
});

describe("modelFingerprint", () => {
	it("is the same every time the model is", async () => {
		expect(await modelFingerprint()).toBe(await modelFingerprint());
	});

	it("changes with the rooftop model", async () => {
		const before = await modelFingerprint();
		ROOFTOP.efficiency = 0.86;
		expect(await modelFingerprint()).not.toBe(before);
	});

	it("changes with the farm model", async () => {
		const before = await modelFingerprint();
		FARM.tiltDeg = 30;
		expect(await modelFingerprint()).not.toBe(before);
	});
});

describe("referenceDay", () => {
	it("is a day with rooftops and a farm, in sun and cloud, from the satellite and the forecast", () => {
		const { locations, estimate, energy } = referenceDay();

		// Islington is big enough for five pixels, Blenheim isn't.
		expect(locations.map((location) => [location.id, location.pixels.length])).toEqual([
			["ISL", 5],
			["BLN", 1],
		]);
		expect(estimate.gxps.map((gxp) => [gxp.gxp, gxp.farmMw])).toEqual([
			["ISL", 5],
			["BLN", 0],
		]);
		// The satellite's last reading was at 5:50pm; the forecast bridges after it.
		expect(estimate.observedUntil).toBe("2026-01-15T04:50:00.000Z");
		expect(estimate.total.profileMw).toHaveLength(144);
		expect(energy.totalMwh).toBeGreaterThan(0);
	});
});
