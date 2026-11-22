import { describe, expect, it } from "vitest";
import {
	arrayOutputMw,
	estimateOutputMw,
	estimateProduction,
	FARM,
	ROOF_FACINGS,
	ROOFTOP,
} from "../../src/production/estimate";
import { planeOfArrayWm2, sunAt } from "../../src/production/solar";

// Noon at Islington in late October, under a clear sky and an overcast one.
const sun = sunAt(Date.parse("2026-10-26T00:30:00Z"), -43.5, 172.5);
const clear = { ghiWm2: 950, dniWm2: 900, dhiWm2: 950 - 900 * Math.sin((sun.elevationDeg * Math.PI) / 180) };
const overcast = { ghiWm2: 300, dniWm2: 0, dhiWm2: 300 };
const MINUTE = 60 * 1000;

describe("arrayOutputMw", () => {
	it("is zero in the dark", () => {
		expect(arrayOutputMw(10, 0, 15, ROOFTOP)).toBe(0);
	});

	it("allows for panel oversizing, losses and cell heating in full sun", () => {
		// 1.15 DC:AC × 0.85 efficiency × (1 − 0.4% × 30 °C of cell heating)
		expect(arrayOutputMw(10, 1000, 25, ROOFTOP)).toBeCloseTo(8.602, 4);
	});

	it("converts dim light less efficiently", () => {
		// Both with cells at 25 °C, so only the light differs.
		const ratio = arrayOutputMw(10, 80, 22.6, ROOFTOP) / arrayOutputMw(10, 800, 1, ROOFTOP);
		expect(ratio).toBeCloseTo((0.1 * (1 + 0.08 * Math.log(0.08))) / (1 + 0.08 * Math.log(0.8)), 6);
	});

	it("produces less on a hot day", () => {
		expect(arrayOutputMw(10, 800, 30, ROOFTOP)).toBeLessThan(arrayOutputMw(10, 800, 10, ROOFTOP));
	});

	it("never exceeds the inverters' rating", () => {
		expect(arrayOutputMw(10, 1400, 0, FARM)).toBe(10);
	});
});

describe("estimateOutputMw", () => {
	it("models rooftops as a mix of the ways roofs face", () => {
		const mix = ROOF_FACINGS.reduce(
			(total, facing) => total + arrayOutputMw(10 * facing.share, planeOfArrayWm2(clear, sun, facing), 20, ROOFTOP),
			0,
		);
		expect(estimateOutputMw({ rooftopMw: 10, farmMw: 0 }, clear, sun, 20)).toBeCloseTo(mix, 10);
		// Off-north roofs catch less of the midday sun.
		const allNorth = arrayOutputMw(10, planeOfArrayWm2(clear, sun, ROOF_FACINGS[0]), 20, ROOFTOP);
		expect(mix).toBeLessThan(allNorth);
	});

	it("gives every roof the same light under overcast skies", () => {
		const irradiance = planeOfArrayWm2(overcast, sun, ROOF_FACINGS[0]);
		expect(estimateOutputMw({ rooftopMw: 10, farmMw: 0 }, overcast, sun, 15)).toBeCloseTo(
			arrayOutputMw(10, irradiance, 15, ROOFTOP),
			10,
		);
	});

	it("models farm-sized capacity as a farm", () => {
		const farm = arrayOutputMw(5, planeOfArrayWm2(clear, sun, FARM), 20, FARM);
		const rooftops = estimateOutputMw({ rooftopMw: 10, farmMw: 0 }, clear, sun, 20);
		expect(estimateOutputMw({ rooftopMw: 10, farmMw: 5 }, clear, sun, 20)).toBeCloseTo(rooftops + farm, 10);
		// A farm puts out more per MW than the average roof.
		expect(farm / 5).toBeGreaterThan(rooftops / 10);
	});
});

describe("estimateProduction", () => {
	// Overcast at noon, dark either side.
	const weather = {
		date: "2026-10-26",
		fetchedAt: "2026-10-25T23:00:00.000Z",
		times: [Date.parse("2026-10-26T00:15:00Z"), Date.parse("2026-10-26T00:30:00Z"), Date.parse("2026-10-26T00:45:00Z")],
		locations: {
			ISL: { lat: -43.5, long: 172.5, ghiWm2: [0, 300, 0], dniWm2: [0, 0, 0], dhiWm2: [0, 300, 0], temperatureC: [15, 15, 15] },
		},
	};
	const gxps = [{ gxp: "ISL", name: "Islington", distributedMw: 10, farmMw: 0 }];
	const noonMw = Math.round(estimateOutputMw({ rooftopMw: 10, farmMw: 0 }, overcast, sun, 15) * 1000) / 1000;

	it("interpolates the weather to now and estimates every interval", () => {
		const [isl] = estimateProduction(gxps, weather, new Date(Date.parse("2026-10-26T00:22:30Z")));

		expect(isl).toMatchObject({ gxp: "ISL", name: "Islington", distributedMw: 10, farmMw: 0, temperatureC: 15, profileMw: [0, noonMw, 0] });
		// Halfway to noon: 150 W/m² of overcast, onto the average roof.
		expect(isl.irradianceWm2).toBeCloseTo(planeOfArrayWm2({ ghiWm2: 150, dniWm2: 0, dhiWm2: 150 }, sun, ROOF_FACINGS[0]), 1);
		expect(isl.productionMw).toBeGreaterThan(0);
		expect(isl.productionMw).toBeLessThan(noonMw / 2);
	});

	it("uses the nearest weather outside the day", () => {
		expect(estimateProduction(gxps, weather, new Date(0))[0].productionMw).toBe(0);
	});

	it("leaves out the live values for a whole day", () => {
		expect(estimateProduction(gxps, weather, null)).toEqual([
			{ ...gxps[0], productionMw: null, irradianceWm2: null, temperatureC: null, profileMw: [0, noonMw, 0] },
		]);
	});

	describe("with a metered farm", () => {
		// 4 MW of rooftops and 6 MW of farms, 5 MW of them metered.
		const withFarms = [{ gxp: "ISL", name: "Islington", distributedMw: 10, farmMw: 6 }];
		const [first, noon, last] = weather.times;
		const reading = (time: number, mw: number) => ({ time, mw });
		const farm = (readings: { time: number; mw: number }[]) => ({ gxp: "ISL", capacityMw: 5, exportLimitMw: 4.5, readings });
		const modelled = (capacity: { rooftopMw: number; farmMw: number }) => estimateOutputMw(capacity, overcast, sun, 15);
		const rest = modelled({ rooftopMw: 4, farmMw: 1 });

		it("uses the readings within five minutes of each step in place of the farm", () => {
			const readings = [reading(noon - 6 * MINUTE, 9), reading(noon - 4 * MINUTE, 2), reading(noon + 2 * MINUTE, 3), reading(noon + 5 * MINUTE, 9)];
			const [isl] = estimateProduction(withFarms, weather, null, [farm(readings)]);
			expect(isl.profileMw[1]).toBeCloseTo(rest + 2.5, 3);
			// The farm's capacity is still counted as it was.
			expect(isl).toMatchObject({ distributedMw: 10, farmMw: 6 });
		});

		it("models the farm, held to what it can export, where there are no readings", () => {
			const [isl] = estimateProduction(withFarms, weather, null, [farm([reading(first, 0)])]);
			const farmMw = Math.min(arrayOutputMw(5, planeOfArrayWm2(overcast, sun, FARM), 15, FARM), 4.5);
			expect(isl.profileMw[1]).toBeCloseTo(rest + farmMw, 3);
			expect(isl.profileMw[1]).toBeCloseTo(modelled({ rooftopMw: 4, farmMw: 6 }), 3);
			const [sunny] = estimateProduction(withFarms, { ...weather, locations: { ISL: { ...weather.locations.ISL, ghiWm2: [0, 1400, 0], dhiWm2: [0, 1400, 0] } } }, null, [farm([])]);
			const sunnyRest = estimateOutputMw({ rooftopMw: 4, farmMw: 1 }, { ghiWm2: 1400, dniWm2: 0, dhiWm2: 1400 }, sun, 15);
			expect(sunny.profileMw[1]).toBeCloseTo(sunnyRest + 4.5, 3);
		});

		it("doesn't count what the farm draws at night as negative output", () => {
			const [isl] = estimateProduction(withFarms, weather, null, [farm([reading(last, -0.02)])]);
			expect(isl.profileMw[2]).toBe(0);
		});

		it("uses the readings in the five minutes to now", () => {
			const at = noon + 7 * MINUTE;
			const readings = [reading(noon, 1), reading(at - 4 * MINUTE, 3), reading(at - 2 * MINUTE, 4)];
			const [isl] = estimateProduction(withFarms, weather, new Date(at), [farm(readings)]);
			const [unmetered] = estimateProduction([{ ...withFarms[0], farmMw: 1, distributedMw: 5 }], weather, new Date(at));
			expect(isl.productionMw).toBeCloseTo(unmetered.productionMw! + 3.5, 3);
		});

		it("leaves other GXPs alone", () => {
			expect(estimateProduction(gxps, weather, null, [{ ...farm([reading(noon, 3)]), gxp: "BLN" }])[0].profileMw).toEqual([0, noonMw, 0]);
		});
	});
});
