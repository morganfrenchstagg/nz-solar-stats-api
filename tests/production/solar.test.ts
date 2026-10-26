import { describe, expect, it } from "vitest";
import { planeOfArrayWm2, sunAt } from "../../src/production/solar";

const WELLINGTON = { lat: -41.29, long: 174.78 };
const MINUTE = 60 * 1000;

describe("sunAt", () => {
	it("puts the summer solstice sun due north at noon, 90° less the latitude less the tilt of the Earth up", () => {
		// Solar noon in Wellington is around 00:20 UTC.
		const start = Date.parse("2026-12-21T00:00:00Z");
		const suns = Array.from({ length: 60 }, (_, i) => sunAt(start + i * MINUTE, WELLINGTON.lat, WELLINGTON.long));
		const noon = suns.reduce((highest, sun) => (sun.elevationDeg > highest.elevationDeg ? sun : highest));

		expect(noon.elevationDeg).toBeCloseTo(90 - (41.29 - 23.44), 1);
		expect(Math.min(noon.azimuthDeg, 360 - noon.azimuthDeg)).toBeLessThan(1);
	});

	it("rises in the east and is below the horizon at night", () => {
		// 6am and midnight NZDT.
		const morning = sunAt(Date.parse("2026-12-20T17:00:00Z"), WELLINGTON.lat, WELLINGTON.long);
		expect(morning.elevationDeg).toBeGreaterThan(0);
		expect(morning.azimuthDeg).toBeGreaterThan(45);
		expect(morning.azimuthDeg).toBeLessThan(135);
		expect(sunAt(Date.parse("2026-12-20T11:00:00Z"), WELLINGTON.lat, WELLINGTON.long).elevationDeg).toBeLessThan(0);
	});
});

describe("planeOfArrayWm2", () => {
	const noon = sunAt(Date.parse("2026-12-21T00:20:00Z"), WELLINGTON.lat, WELLINGTON.long);
	const morning = sunAt(Date.parse("2026-12-20T19:00:00Z"), WELLINGTON.lat, WELLINGTON.long);
	// A clear sky, consistent with the sun's height.
	const clear = (sun: typeof noon) => {
		const dniWm2 = 850;
		const dhiWm2 = 100;
		return { dniWm2, dhiWm2, ghiWm2: dniWm2 * Math.sin((sun.elevationDeg * Math.PI) / 180) + dhiWm2 };
	};

	it("gives a flat panel the global horizontal irradiance", () => {
		const sky = clear(noon);
		expect(planeOfArrayWm2(sky, noon, { tiltDeg: 0, azimuthDeg: 0 })).toBeCloseTo(sky.ghiWm2, 6);
	});

	it("favours panels facing the sun", () => {
		const facing = (azimuthDeg: number, sun: typeof noon) =>
			planeOfArrayWm2(clear(sun), sun, { tiltDeg: 20, azimuthDeg });
		expect(facing(0, noon)).toBeGreaterThan(facing(90, noon));
		expect(facing(90, morning)).toBeGreaterThan(facing(0, morning));
		expect(facing(90, morning)).toBeGreaterThan(facing(270, morning));
	});

	it("gives every panel the same share of an overcast sky, whichever way it faces", () => {
		const overcast = { ghiWm2: 200, dniWm2: 0, dhiWm2: 200 };
		const north = planeOfArrayWm2(overcast, noon, { tiltDeg: 20, azimuthDeg: 0 });
		// The sky it sees, plus a little off the ground.
		expect(north).toBeCloseTo(200 * ((1 + Math.cos(Math.PI / 9)) / 2) + 200 * 0.2 * ((1 - Math.cos(Math.PI / 9)) / 2), 6);
		expect(planeOfArrayWm2(overcast, noon, { tiltDeg: 20, azimuthDeg: 270 })).toBeCloseTo(north, 6);
	});

	it("is zero in the dark", () => {
		const night = sunAt(Date.parse("2026-12-20T11:00:00Z"), WELLINGTON.lat, WELLINGTON.long);
		expect(planeOfArrayWm2({ ghiWm2: 0, dniWm2: 0, dhiWm2: 0 }, night, { tiltDeg: 20, azimuthDeg: 0 })).toBe(0);
	});
});
