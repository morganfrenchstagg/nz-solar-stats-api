import { describe, expect, it } from "vitest";
import { averageMw, fitSlope, netLoad, parseDispatch } from "../../scripts/dispatch.ts";
import { nzInstant } from "../../scripts/shared.ts";

describe("nzInstant", () => {
	it("reads NZ clock times either side of daylight saving starting", () => {
		// 27 September 2026: 2am NZST becomes 3am NZDT.
		expect(new Date(nzInstant("2026-09-27T01:55:00")).toISOString()).toBe("2026-09-26T13:55:00.000Z");
		expect(new Date(nzInstant("2026-09-27T03:00:00")).toISOString()).toBe("2026-09-26T14:00:00.000Z");
	});

	it("takes the first of the hour repeated when daylight saving ends", () => {
		// 5 April 2026: 3am NZDT becomes 2am NZST.
		expect(new Date(nzInstant("2026-04-05T02:30:00")).toISOString()).toBe("2026-04-04T13:30:00.000Z");
	});
});

describe("parseDispatch and netLoad", () => {
	const readings = parseDispatch([
		{
			series: ["BLN0331", "BLN0332", "KOE1101 KSF0"],
			data: [
				["2026-11-01T12:00:00", -20, -5, 10],
				["2026-11-01T12:05:00", -18, null, 11],
				["2026-11-01T12:10:00", -16, -4, 12],
			],
		},
	]);

	it("keeps each series' readings by instant", () => {
		expect(readings.get("KOE1101 KSF0")?.get(Date.parse("2026-10-31T23:05:00Z"))).toBe(11);
	});

	it("adds up a site's load buses, leaving out generators and instants a bus is missing", () => {
		const load = netLoad(readings, "BLN");
		expect([...load]).toEqual([
			[Date.parse("2026-10-31T23:00:00Z"), 25],
			[Date.parse("2026-10-31T23:10:00Z"), 20],
		]);
	});
});

describe("averageMw", () => {
	const at = (minutes: number) => Date.parse("2026-11-01T00:00:00Z") + minutes * 60_000;

	it("averages the 5-minute readings by the trapezoid rule", () => {
		const readings = new Map([0, 5, 10, 15, 20, 25, 30].map((minutes) => [at(minutes), minutes]));
		expect(averageMw(readings, at(0), at(30))).toBeCloseTo(15);
	});

	it("bridges a short gap", () => {
		const readings = new Map([0, 5, 20, 25, 30].map((minutes) => [at(minutes), 10]));
		expect(averageMw(readings, at(0), at(30))).toBeCloseTo(10);
	});

	it("gives up on a long one", () => {
		const readings = new Map([0, 30].map((minutes) => [at(minutes), 10]));
		expect(averageMw(readings, at(0), at(30))).toBeNull();
	});
});

describe("fitSlope", () => {
	it("finds the slope through day levels and a time-of-day shape that overlap", () => {
		const groups: number[] = [];
		const x: number[] = [];
		const y: number[] = [];
		const slots: number[][] = Array.from({ length: 48 }, () => []);
		for (let day = 0; day < 10; day++) {
			const cloud = [1, 0.2, 0.7, 0.9, 0.4, 1, 0.1, 0.6, 0.8, 0.3][day];
			for (let slot = 0; slot < 48; slot++) {
				const solar = Math.max(0, Math.sin(((slot - 12) / 24) * Math.PI)) * 20 * cloud;
				groups.push(day);
				x.push(solar);
				// A day's level, a daily shape, then solar taking load away.
				y.push(30 + day + 10 * Math.cos((slot / 48) * 2 * Math.PI) - 0.9 * solar);
				slots.forEach((column, k) => column.push(k === slot ? 1 : 0));
			}
		}
		const fit = fitSlope({ y, x, groups, controls: [...slots, slots[0]] });
		expect(fit.slope).toBeCloseTo(-0.9, 9);
		expect(fit.standardError).toBeCloseTo(0, 9);
	});
});
