import { describe, expect, it } from "vitest";
import { averagePixels, blendIrradiance, BRIDGE_MS, pixelsAround, weatherPoints } from "../../src/production/blend";

const MINUTE = 60 * 1000;

describe("pixelsAround", () => {
	it("uses five pixels for bigger GXPs and one for small ones", () => {
		expect(pixelsAround(-43.5, 172.5, 58)).toHaveLength(5);
		expect(pixelsAround(-43.5, 172.5, 1.2)).toEqual([{ lat: -43.5, long: 172.5 }]);
	});
});

describe("weatherPoints", () => {
	const substation = { lat: -40.58, long: 175.45 };
	const location = {
		population: 35851,
		centre: [-40.58, 175.29],
		pixels: [[-40.625, 175.275, 0.46], [-40.475, 175.275, 0.09], [-40.625, 175.325, 0.08]],
	};

	it("takes the weather where a GXP's people are, weighted by population", () => {
		expect(weatherPoints(substation, location, 20)).toEqual({
			forecast: { lat: -40.58, long: 175.29 },
			pixels: [
				{ lat: -40.625, long: 175.275, weight: 0.46 },
				{ lat: -40.475, long: 175.275, weight: 0.09 },
				{ lat: -40.625, long: 175.325, weight: 0.08 },
			],
		});
	});

	it("uses only the most-populated pixel for a small GXP", () => {
		expect(weatherPoints(substation, location, 4.8).pixels).toEqual([{ lat: -40.625, long: 175.275, weight: 0.46 }]);
	});

	it("falls back to the substation for a GXP without a population location", () => {
		const points = weatherPoints(substation, undefined, 20);
		expect(points.forecast).toEqual(substation);
		expect(points.pixels).toHaveLength(5);
		expect(points.pixels[0]).toEqual({ ...substation, weight: 1 });
	});
});

describe("averagePixels", () => {
	it("averages the pixels with readings", () => {
		expect(averagePixels([[100, null, null], [300, 200, null]])).toEqual([200, 200, null]);
	});

	it("weights pixels by their share of the people", () => {
		expect(averagePixels([[100, 100], [400, null]], [3, 1])).toEqual([175, 100]);
	});
});

describe("blendIrradiance", () => {
	// Forecast every 15 minutes, satellite every 10, from time 0.
	const forecastTimes = Array.from({ length: 33 }, (_, i) => i * 15 * MINUTE); // 8 hours
	const flatForecast = forecastTimes.map(() => 800);
	const satelliteTimes = Array.from({ length: 49 }, (_, i) => i * 10 * MINUTE);

	it("uses the forecast when the satellite has nothing", () => {
		const satellite = satelliteTimes.map(() => null);
		expect(blendIrradiance(satelliteTimes, satellite, forecastTimes, flatForecast)).toEqual({
			irradianceWm2: flatForecast,
			observedUntil: null,
		});
	});

	it("follows the satellite up to its latest reading, interpolating to the forecast's instants", () => {
		// Readings for the first hour, rising 10 W/m² a minute, then nothing yet.
		const satellite = satelliteTimes.map((time) => (time <= 60 * MINUTE ? time / MINUTE * 10 : null));
		const { irradianceWm2, observedUntil } = blendIrradiance(satelliteTimes, satellite, forecastTimes, flatForecast);

		expect(observedUntil).toBe(60 * MINUTE);
		expect(irradianceWm2.slice(0, 5)).toEqual([0, 150, 300, 450, 600]);
	});

	it("fades the satellite's last cloudiness into the forecast", () => {
		// Cloud halves the sun at the last reading, an hour in.
		const satellite = satelliteTimes.map((time) => (time <= 60 * MINUTE ? 400 : null));
		const { irradianceWm2 } = blendIrradiance(satelliteTimes, satellite, forecastTimes, flatForecast);
		const at = (minutes: number) => irradianceWm2[minutes / 15];

		expect(at(60)).toBe(400);
		expect(at(60 + BRIDGE_MS / MINUTE / 2)).toBe(600); // halfway back to the forecast
		expect(at(60 + BRIDGE_MS / MINUTE)).toBe(800);
		expect(at(480)).toBe(800);
	});

	it("bridges gaps in the satellite readings", () => {
		const satellite = satelliteTimes.map((time) => (time === 20 * MINUTE ? null : time <= 60 * MINUTE ? 500 : null));
		expect(blendIrradiance(satelliteTimes, satellite, forecastTimes, flatForecast).irradianceWm2[1]).toBe(500);
	});

	it("doesn't scale the forecast by a reading taken in the dark", () => {
		const darkForecast = forecastTimes.map((time) => (time <= 60 * MINUTE ? 10 : 800));
		const satellite = satelliteTimes.map((time) => (time <= 60 * MINUTE ? 0 : null));
		const { irradianceWm2 } = blendIrradiance(satelliteTimes, satellite, forecastTimes, darkForecast);

		expect(irradianceWm2[8]).toBe(800);
	});
});
