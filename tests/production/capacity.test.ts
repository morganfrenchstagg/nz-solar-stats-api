import { describe, expect, it } from "vitest";
import { capacityAt, growthMwPerMonth } from "../../src/production/capacity";

// Month-end snapshots growing by `steps` MW each month from 10 MW.
function snapshots(changes: number[], stepMw: Record<number, number> = {}) {
	let mw = 10;
	return [{ monthEnd: "2025-12-31", distributedMw: mw, stepMw: 0 }].concat(
		changes.map((change, i) => {
			mw += change;
			const month = new Date(Date.UTC(2026, i + 1, 0)).toISOString().slice(0, 10);
			return { monthEnd: month, distributedMw: mw, stepMw: stepMw[i] ?? 0 };
		}),
	);
}

describe("growthMwPerMonth", () => {
	it("is the steady rate when growth is steady", () => {
		expect(growthMwPerMonth(snapshots([0.2, 0.2, 0.2, 0.2]))).toBeCloseTo(0.2, 10);
	});

	it("counts recent months more", () => {
		// Half-life of three months: the latest change has twice the weight of one three months older.
		const rate = growthMwPerMonth(snapshots([0.1, 0.1, 0.1, 0.4]));
		const weights = [0.5 ** 1, 0.5 ** (2 / 3), 0.5 ** (1 / 3), 1];
		expect(rate).toBeCloseTo((0.1 * (weights[0] + weights[1] + weights[2]) + 0.4) / weights.reduce((a, b) => a + b), 10);
		expect(rate).toBeGreaterThan(0.2);
	});

	it("leaves out farm-sized steps", () => {
		// A 10 MW farm arrives in the third month, on top of the usual 0.2 MW.
		expect(growthMwPerMonth(snapshots([0.2, 0.2, 10.2, 0.2], { 2: 10 }))).toBeCloseTo(0.2, 10);
	});

	it("looks back a year at most", () => {
		const oldBoom = snapshots([5, ...Array(12).fill(0.2)]);
		expect(growthMwPerMonth(oldBoom)).toBeCloseTo(0.2, 10);
	});
});

describe("capacityAt", () => {
	const months = snapshots([0.3, 0.3, 0.3]); // to 31 March 2026, at 10.9 MW

	it("grows the latest snapshot on or before the date at the recent rate", () => {
		const estimate = capacityAt(months, "2026-04-15")!;
		expect(estimate.monthEnd).toBe("2026-03-31");
		expect(estimate.growthMwPerMonth).toBeCloseTo(0.3, 10);
		// 15 days on: half a month's growth, near enough.
		expect(estimate.capacityMw).toBeCloseTo(10.9 + 0.3 * (15 / (365.25 / 12)), 10);
	});

	it("only uses snapshots up to the date", () => {
		expect(capacityAt(months, "2026-02-14")!.monthEnd).toBe("2026-01-31");
	});

	it("is the snapshot itself on a month end", () => {
		expect(capacityAt(months, "2026-03-31")!.capacityMw).toBeCloseTo(10.9, 10);
	});

	it("is null before the first snapshot", () => {
		expect(capacityAt(months, "2025-11-30")).toBeNull();
	});
});
