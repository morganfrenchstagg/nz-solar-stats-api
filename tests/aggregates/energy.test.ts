import { describe, expect, it } from "vitest";
import { dailyEnergy, sumEnergy, upsertEnergy } from "../../src/aggregates/energy";
import { addMonths, datesBetween, isoWeek, monthBounds } from "../../src/aggregates/periods";

describe("isoWeek", () => {
	it.each([
		["2026-10-26", { year: "2026", from: "2026-10-26", to: "2026-11-01" }],
		["2026-11-01", { year: "2026", from: "2026-10-26", to: "2026-11-01" }],
		// Thursday 1 January 2026, so the week is 2026's.
		["2025-12-29", { year: "2026", from: "2025-12-29", to: "2026-01-04" }],
		// Friday 1 January 2027, so the week is 2026's.
		["2027-01-03", { year: "2026", from: "2026-12-28", to: "2027-01-03" }],
	])("puts %s in the week Monday to Sunday", (date, week) => {
		expect(isoWeek(date)).toEqual(week);
	});
});

describe("periods", () => {
	it("bounds months, leap years included", () => {
		expect(monthBounds("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
		expect(monthBounds("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
		expect(monthBounds("2026-12")).toEqual({ from: "2026-12-01", to: "2026-12-31" });
	});

	it("counts months back like SQLite, carrying an overflowing day over", () => {
		expect(addMonths("2026-10-26", -14)).toBe("2025-08-26");
		expect(addMonths("2026-04-30", -14)).toBe("2025-03-02");
	});

	it("lists the dates between two, inclusive", () => {
		expect(datesBetween("2026-02-27", "2026-03-01")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01"]);
	});
});

describe("dailyEnergy", () => {
	it("holds each 10-minute step's output for its 10 minutes", () => {
		const estimate = {
			date: "2026-10-26",
			gxps: [
				{ gxp: "ISL", profileMw: Array(144).fill(6) },
				{ gxp: "ASB", profileMw: [0, 3, 3, 0] },
			],
		};
		expect(dailyEnergy(estimate)).toEqual({
			from: "2026-10-26",
			to: "2026-10-26",
			days: 1,
			totalMwh: 145,
			gxps: { ISL: 144, ASB: 1 },
		});
	});
});

describe("sumEnergy", () => {
	it("adds periods up, with GXPs that only some have", () => {
		const day = (from: string, gxps: Record<string, number>) => ({ from, to: from, days: 1, totalMwh: 0, gxps });
		expect(sumEnergy("2026-10-01", "2026-10-31", [day("2026-10-01", { ISL: 1.5 }), day("2026-10-02", { ISL: 1, ASB: 0.25 })])).toEqual({
			from: "2026-10-01",
			to: "2026-10-31",
			days: 2,
			totalMwh: 2.75,
			gxps: { ISL: 2.5, ASB: 0.25 },
		});
	});

	it("replaces a period that starts on the same day, keeping them in order", () => {
		const point = (from: string, totalMwh: number) => ({ from, to: from, days: 1, totalMwh, gxps: {} });
		const file = { data: [point("2026-10-01", 1), point("2026-10-03", 3)] };
		expect(upsertEnergy(upsertEnergy(file, point("2026-10-02", 2)), point("2026-10-03", 4)).data).toEqual([
			point("2026-10-01", 1),
			point("2026-10-02", 2),
			point("2026-10-03", 4),
		]);
	});
});
