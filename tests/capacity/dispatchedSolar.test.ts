import { describe, expect, it } from "vitest";
import {
	attributeStepsToFarms,
	type CapacityStep,
	findCapacitySteps,
	stepParts,
} from "../../src/capacity/dispatchedSolar";
import type { SolarFarm } from "../../src/capacity/electricityMap";
import { emiRows } from "./emiFixtures";

const kowhaiPark: SolarFarm = {
	node: "ISL0661 KPS0",
	name: "Kōwhai Park",
	capacityMw: 150,
	commissioned: "2026-08-13T02:00:00.000Z",
	location: null,
};
const taiohi: SolarFarm = {
	node: "HLY0331 TOH0",
	name: "Taiohi",
	capacityMw: 22.51,
	commissioned: "2025-09-15T01:00:00.000Z",
	location: null,
};
const tePunaMauri: SolarFarm = {
	node: "MTO0331 RWI0",
	name: "Te Puna Mauri ō Omaru",
	capacityMw: 16.23,
	commissioned: "2024-12-12T18:20:00.000Z",
	location: null,
};
const papareireia: SolarFarm = {
	node: "MTO0331 GDS0",
	name: "Papareireiā",
	capacityMw: 18,
	commissioned: "2025-11-12T21:30:00.000Z",
	location: null,
};
const lauriston: SolarFarm = {
	node: "ASB0661 LAU0",
	name: "Lauriston",
	capacityMw: 47.24,
	commissioned: "2024-10-15T21:20:00.000Z",
	location: null,
};
const rangitaiki: SolarFarm = {
	node: "EDG0331 RGT0",
	name: "Rangitaiki",
	capacityMw: 23.76,
	commissioned: "2024-03-06T18:15:00.000Z",
	location: null,
};
const omeheu: SolarFarm = {
	node: "EDG0331 EDS0",
	name: "Omeheu",
	capacityMw: 28.7,
	commissioned: "2026-05-19T05:50:00.000Z",
	location: null,
};
const tauhei: SolarFarm = {
	node: "WHU1101 TAH0",
	name: "Tauhei",
	capacityMw: 150,
	commissioned: "2026-05-01T01:15:00.000Z",
	location: { lat: -37.5802, long: 175.7122 },
};
const ruakaka: SolarFarm = {
	node: "BRB0331 RUS0",
	name: "Ruakākā Solar Farm",
	capacityMw: 130,
	commissioned: null,
	location: null,
};

// [name or NSP, month end, MW to 1dp], to keep expectations readable.
function summarise(steps: (CapacityStep & { name?: string })[]) {
	return steps.map((step) => [
		step.name ?? step.nsp,
		step.monthEnd,
		Math.round(step.mw * 10) / 10,
	]);
}

describe("findCapacitySteps", () => {
	it("finds farm-sized steps but not ICPs moving between NSPs", () => {
		expect(summarise(findCapacitySteps(emiRows("ISL0661ORONGN")))).toEqual([
			["ISL0661ORONGN", "2026-07-31", 160.1],
		]);
	});

	it("treats an NSP that appears part way through as starting from nothing", () => {
		const rows = [
			...emiRows("ISL0661ORONGN"),
			{
				nsp: "ISL0331ORONGN",
				monthEnd: "2026-08-31",
				icpCount: 1,
				capacityMw: 12,
				newInstallAvgKw: 12000,
				newInstallCount: 1,
			},
		];
		expect(summarise(findCapacitySteps(rows))).toContainEqual([
			"ISL0331ORONGN",
			"2026-08-31",
			12,
		]);
	});
});

describe("following systems the registry moves between NSPs", () => {
	const steps = findCapacitySteps([...emiRows("WHU0331POCOGN"), ...emiRows("PAO1101POCOGN")]);

	it("counts a moved system where it went from when it first appeared", () => {
		// 8.9 MW of Piako's May step moved to Waihou in October.
		expect(summarise(steps)).toEqual([
			["WHU0331POCOGN", "2026-05-31", 13.3],
			["PAO1101POCOGN", "2026-05-31", 8.8],
		]);
	});

	it("keeps track of where it was until the move", () => {
		const waihou = steps.find((step) => step.nsp === "WHU0331POCOGN")!;
		expect(summarise(stepParts(waihou))).toEqual([
			["WHU0331POCOGN", "2026-05-31", 4.3],
			["PAO1101POCOGN", "2026-05-31", 8.9],
			["PAO1101POCOGN", "2026-10-31", -8.9],
			["WHU0331POCOGN", "2026-10-31", 8.9],
		]);
	});

	it("needs an ICP to have moved, not just capacity", () => {
		// Same change in capacity, but Piako lost no ICP.
		const rows = emiRows("PAO1101POCOGN").map((row) =>
			row.monthEnd === "2026-10-31" ? { ...row, icpCount: 368 } : row,
		);
		expect(summarise(findCapacitySteps([...emiRows("WHU0331POCOGN"), ...rows]))).toEqual([
			["WHU0331POCOGN", "2026-05-31", 4.3],
			["PAO1101POCOGN", "2026-05-31", 17.7],
			["WHU0331POCOGN", "2026-10-31", 8.9],
		]);
	});
});

describe("following systems that leave the registry", () => {
	it("takes a step off again when a system its size goes", () => {
		const [step] = findCapacitySteps(emiRows("CBG0111WAIPGN"));
		expect(step.removedMonthEnd).toBe("2026-04-30");
		expect(summarise(stepParts(step))).toEqual([
			["CBG0111WAIPGN", "2025-07-31", 9.1],
			["CBG0111WAIPGN", "2026-04-30", -9.1],
		]);
	});

	it("leaves the step alone when the drop is a different size", () => {
		const rows = emiRows("CBG0111WAIPGN").map((row) =>
			row.monthEnd >= "2026-04-30" ? { ...row, capacityMw: row.capacityMw + 4 } : row,
		);
		const [step] = findCapacitySteps(rows);
		expect(step.removedMonthEnd).toBeUndefined();
	});
});

describe("attributeStepsToFarms", () => {
	it("claims a farm that shows up in EMI before its commissioning date", () => {
		const steps = findCapacitySteps(emiRows("ISL0661ORONGN"));
		expect(summarise(attributeStepsToFarms(steps, [kowhaiPark], "2026-09-30"))).toEqual([
			["Kōwhai Park", "2026-07-31", 160.1],
		]);
	});

	it("claims every stage of a staged farm but not a later farm at the same NSP", () => {
		const steps = findCapacitySteps(emiRows("HLY0331WAIKGN"));
		expect(summarise(steps)).toContainEqual(["HLY0331WAIKGN", "2026-03-31", 9.9]);
		expect(summarise(attributeStepsToFarms(steps, [taiohi], "2026-09-30"))).toEqual([
			["Taiohi", "2025-10-31", 12.7],
			["Taiohi", "2025-11-30", 9.6],
		]);
	});

	it("tells apart farms sharing an NSP and leaves undispatched farms alone", () => {
		const steps = findCapacitySteps(emiRows("MTO0331NPOWGN"));
		expect(summarise(steps)).toContainEqual(["MTO0331NPOWGN", "2024-05-31", 4.5]);
		expect(summarise(attributeStepsToFarms(steps, [papareireia, tePunaMauri], "2026-09-30"))).toEqual([
			["Te Puna Mauri ō Omaru", "2024-12-31", 16.8],
			["Papareireiā", "2025-11-30", 9],
			["Papareireiā", "2026-04-30", 8.6],
		]);
	});

	it("stops claiming once a farm's capacity is accounted for", () => {
		const steps = findCapacitySteps(emiRows("ASB0661EASHGN"));
		expect(summarise(steps)).toContainEqual(["ASB0661EASHGN", "2024-12-31", 6.4]);
		expect(summarise(attributeStepsToFarms(steps, [lauriston], "2026-09-30"))).toEqual([
			["Lauriston", "2024-11-30", 48.3],
		]);
	});

	it("claims a farm registered long after it was commissioned", () => {
		const steps = findCapacitySteps(emiRows("EDG0331HEDLGN"));
		expect(summarise(attributeStepsToFarms(steps, [omeheu, rangitaiki], "2026-09-30"))).toEqual([
			["Rangitaiki", "2025-08-31", 23.5],
			["Omeheu", "2026-05-31", 28.7],
		]);
	});

	it("claims steps at a grid-connected farm's GXP around when it's commissioned", () => {
		const steps = findCapacitySteps([...emiRows("WHU0331POCOGN"), ...emiRows("PAO1101POCOGN")]);
		// Piako's May step was local generation, apart from what moved to Waihou.
		expect(summarise(attributeStepsToFarms(steps, [tauhei], "2026-10-31"))).toEqual([
			["Tauhei", "2026-05-31", 13.3],
		]);
		const later = { ...tauhei, commissioned: "2026-07-01T00:00:00.000Z" };
		const earlier = { ...tauhei, commissioned: "2026-01-01T00:00:00.000Z" };
		expect(attributeStepsToFarms(steps, [later], "2026-10-31")).toHaveLength(1);
		expect(attributeStepsToFarms(steps, [earlier], "2026-10-31")).toEqual([]);
	});

	it("takes a farm that isn't commissioned yet to be commissioning now", () => {
		const steps = findCapacitySteps(emiRows("BRB0331NPOWGN"));
		expect(summarise(attributeStepsToFarms(steps, [ruakaka], "2026-10-31"))).toEqual([
			["Ruakākā Solar Farm", "2026-10-31", 3.8],
		]);
		expect(attributeStepsToFarms(steps, [ruakaka], "2027-03-31")).toEqual([]);
	});
});
