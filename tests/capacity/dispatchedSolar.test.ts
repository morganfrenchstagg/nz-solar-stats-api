import { describe, expect, it } from "vitest";
import {
	attributeStepsToFarms,
	type CapacityStep,
	findCapacitySteps,
} from "../../src/capacity/dispatchedSolar";
import type { SolarFarm } from "../../src/capacity/electricityMap";
import { emiRows } from "./emiFixtures";

const kowhaiPark: SolarFarm = {
	node: "ISL0661 KPS0",
	name: "Kōwhai Park",
	capacityMw: 150,
	commissioned: "2026-08-13T02:00:00.000Z",
};
const taiohi: SolarFarm = {
	node: "HLY0331 TOH0",
	name: "Taiohi",
	capacityMw: 22.51,
	commissioned: "2025-09-15T01:00:00.000Z",
};
const tePunaMauri: SolarFarm = {
	node: "MTO0331 RWI0",
	name: "Te Puna Mauri ō Omaru",
	capacityMw: 16.23,
	commissioned: "2024-12-12T18:20:00.000Z",
};
const papareireia: SolarFarm = {
	node: "MTO0331 GDS0",
	name: "Papareireiā",
	capacityMw: 18,
	commissioned: "2025-11-12T21:30:00.000Z",
};
const lauriston: SolarFarm = {
	node: "ASB0661 LAU0",
	name: "Lauriston",
	capacityMw: 47.24,
	commissioned: "2024-10-15T21:20:00.000Z",
};
const rangitaiki: SolarFarm = {
	node: "EDG0331 RGT0",
	name: "Rangitaiki",
	capacityMw: 23.76,
	commissioned: "2024-03-06T18:15:00.000Z",
};
const omeheu: SolarFarm = {
	node: "EDG0331 EDS0",
	name: "Omeheu",
	capacityMw: 28.7,
	commissioned: "2026-05-19T05:50:00.000Z",
};
const tauhei: SolarFarm = {
	node: "WHU1101 TAH0",
	name: "Tauhei",
	capacityMw: 150,
	commissioned: "2026-05-01T01:15:00.000Z",
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
			},
		];
		expect(summarise(findCapacitySteps(rows))).toContainEqual([
			"ISL0331ORONGN",
			"2026-08-31",
			12,
		]);
	});
});

describe("attributeStepsToFarms", () => {
	it("claims a farm that shows up in EMI before its commissioning date", () => {
		const steps = findCapacitySteps(emiRows("ISL0661ORONGN"));
		expect(summarise(attributeStepsToFarms(steps, [kowhaiPark]))).toEqual([
			["Kōwhai Park", "2026-07-31", 160.1],
		]);
	});

	it("claims every stage of a staged farm but not a later farm at the same NSP", () => {
		const steps = findCapacitySteps(emiRows("HLY0331WAIKGN"));
		expect(summarise(steps)).toContainEqual(["HLY0331WAIKGN", "2026-03-31", 9.9]);
		expect(summarise(attributeStepsToFarms(steps, [taiohi]))).toEqual([
			["Taiohi", "2025-10-31", 12.7],
			["Taiohi", "2025-11-30", 9.6],
		]);
	});

	it("tells apart farms sharing an NSP and leaves undispatched farms alone", () => {
		const steps = findCapacitySteps(emiRows("MTO0331NPOWGN"));
		expect(summarise(steps)).toContainEqual(["MTO0331NPOWGN", "2024-05-31", 4.5]);
		expect(summarise(attributeStepsToFarms(steps, [papareireia, tePunaMauri]))).toEqual([
			["Te Puna Mauri ō Omaru", "2024-12-31", 16.8],
			["Papareireiā", "2025-11-30", 9],
			["Papareireiā", "2026-04-30", 8.6],
		]);
	});

	it("stops claiming once a farm's capacity is accounted for", () => {
		const steps = findCapacitySteps(emiRows("ASB0661EASHGN"));
		expect(summarise(steps)).toContainEqual(["ASB0661EASHGN", "2024-12-31", 6.4]);
		expect(summarise(attributeStepsToFarms(steps, [lauriston]))).toEqual([
			["Lauriston", "2024-11-30", 48.3],
		]);
	});

	it("claims a farm registered long after it was commissioned", () => {
		const steps = findCapacitySteps(emiRows("EDG0331HEDLGN"));
		expect(summarise(attributeStepsToFarms(steps, [omeheu, rangitaiki]))).toEqual([
			["Rangitaiki", "2025-08-31", 23.5],
			["Omeheu", "2026-05-31", 28.7],
		]);
	});

	it("doesn't claim a smaller farm at the GXP for a grid-connected farm", () => {
		const steps = findCapacitySteps(emiRows("WHU0331POCOGN"));
		expect(summarise(steps)).toEqual([["WHU0331POCOGN", "2026-05-31", 4.3]]);
		expect(attributeStepsToFarms(steps, [tauhei])).toEqual([]);
	});
});
