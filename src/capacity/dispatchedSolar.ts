import type { SolarFarm, Substation } from "./electricityMap";
import type { EmiSolarRow } from "./emi";

// A month where an NSP's installed solar grew by more than its new rooftop
// systems explain, i.e. something farm-sized was connected.
export interface CapacityStep {
	nsp: string;
	monthEnd: string;
	mw: number;
}

export interface FarmStep extends CapacityStep {
	node: string;
	name: string;
}

// Smaller steps are indistinguishable from ICPs moving between NSPs.
const MIN_STEP_MW = 2;
// New installations averaging more than this include something bigger than a
// rooftop, so they don't tell us what a typical system looks like.
const ROOFTOP_MAX_KW = 50;
const DEFAULT_ROOFTOP_KW = 5;

// Farms can appear in the registry a little before their commissioning date
// (Kōwhai Park was a month early), or well after it (Rangitaiki, 17 months).
const LEAD_MONTHS = 3;
// Registry capacity doesn't match dispatch capacity exactly; EMI records about
// 7% more than the dispatch capacity for Kōwhai Park and 15% more for Pukenui.
const MIN_MATCH = 0.85;
const MAX_MATCH = 1.25;
// Farms are often registered in stages (Taiohi, Papareireiā), but the first
// stage is always a substantial part of the farm.
const MIN_FIRST_STAGE = 0.3;
const MAX_STAGE_SPREAD_MONTHS = 12;
// A farm connected straight to the grid has no NSP of its own, but some of it
// can still turn up in the registry at NSPs nearby the month it's
// commissioned: Tauhei (150 MW at Waihou, May 2026) as 17.8 MW at Piako and
// 4.3 MW at Waihou. Grid load at both showed little of the solar those steps
// would add as local generation (about half at Piako), so they're the farm's.
const NEARBY_KM = 20;
const NEARBY_MONTHS = 1;

export function findCapacitySteps(rows: EmiSolarRow[]): CapacityStep[] {
	const firstMonthEnd = rows.reduce(
		(first, row) => (row.monthEnd < first ? row.monthEnd : first),
		rows[0]?.monthEnd ?? "",
	);

	const steps: CapacityStep[] = [];
	for (const series of groupByNsp(rows)) {
		const rooftopKw: number[] = [];
		// An NSP that appears after EMI's first month started from nothing.
		let previous = { icpCount: 0, capacityMw: 0 };
		for (const row of series) {
			if (row.monthEnd !== firstMonthEnd) {
				const typicalKw = median(rooftopKw.slice(-12)) ?? DEFAULT_ROOFTOP_KW;
				const icpsAdded = row.icpCount - previous.icpCount;
				const mw =
					row.capacityMw - previous.capacityMw - (icpsAdded * typicalKw) / 1000;
				if (mw >= MIN_STEP_MW) {
					steps.push({ nsp: row.nsp, monthEnd: row.monthEnd, mw: round(mw) });
				}
			}
			if (row.newInstallAvgKw !== null && row.newInstallAvgKw < ROOFTOP_MAX_KW) {
				rooftopKw.push(row.newInstallAvgKw);
			}
			previous = row;
		}
	}
	return steps.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));
}

// Works out which capacity steps are dispatched solar farms. Farms connected
// straight to the grid have no NSP in EMI, so only get steps at NSPs nearby
// (see NEARBY_KM).
export function attributeStepsToFarms(
	steps: CapacityStep[],
	farms: SolarFarm[],
	substations: Pick<Substation, "siteId" | "lat" | "long">[] = [],
): FarmStep[] {
	const unclaimed = [...steps].sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));
	const claimed: FarmStep[] = [];

	// Oldest first, so a farm can't take the steps of a newer one at its GXP.
	const byCommissioning = [...farms].sort((a, b) =>
		(a.commissioned ?? "9999").localeCompare(b.commissioned ?? "9999"),
	);
	for (const farm of byCommissioning) {
		const gxp = farm.node.slice(0, 3);
		const earliest = farm.commissioned
			? monthIndex(farm.commissioned) - LEAD_MONTHS
			: -Infinity;
		const candidates = unclaimed.filter(
			(step) => step.nsp.startsWith(gxp) && monthIndex(step.monthEnd) >= earliest,
		);

		const min = farm.capacityMw * MIN_MATCH;
		const max = farm.capacityMw * MAX_MATCH;
		const first = candidates.find(
			(step) => step.mw >= farm.capacityMw * MIN_FIRST_STAGE && step.mw <= max,
		);
		if (!first) {
			for (const step of nearbySteps(farm, unclaimed, substations)) {
				unclaimed.splice(unclaimed.indexOf(step), 1);
				claimed.push({ ...step, node: farm.node, name: farm.name });
			}
			continue;
		}

		// Later stages only count until the farm's capacity is accounted for, so a
		// separate system arriving soon after (Lauriston, December 2024) isn't taken.
		const stages = [first];
		let total = first.mw;
		for (const step of candidates) {
			if (total >= min) break;
			if (step.nsp !== first.nsp || step.monthEnd <= first.monthEnd) continue;
			const sinceFirst = monthIndex(step.monthEnd) - monthIndex(first.monthEnd);
			if (sinceFirst > MAX_STAGE_SPREAD_MONTHS) break;
			if (total + step.mw > max) continue;
			stages.push(step);
			total += step.mw;
		}

		for (const stage of stages) {
			unclaimed.splice(unclaimed.indexOf(stage), 1);
			claimed.push({ ...stage, node: farm.node, name: farm.name });
		}
	}
	return claimed.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));
}

// Steps at NSPs whose GXP is near a farm, the month it was commissioned or the
// next, up to the farm's capacity.
function nearbySteps(
	farm: SolarFarm,
	steps: CapacityStep[],
	substations: Pick<Substation, "siteId" | "lat" | "long">[],
): CapacityStep[] {
	const { commissioned, location } = farm;
	if (!commissioned || !location) return [];
	const nearby: CapacityStep[] = [];
	let total = 0;
	for (const step of steps) {
		const monthsAfter = monthIndex(step.monthEnd) - monthIndex(commissioned);
		const substation = substations.find((s) => s.siteId === step.nsp.slice(0, 3));
		if (monthsAfter < 0 || monthsAfter > NEARBY_MONTHS || !substation) continue;
		if (distanceKm(location, substation) > NEARBY_KM) continue;
		if (total + step.mw > farm.capacityMw * MAX_MATCH) continue;
		nearby.push(step);
		total += step.mw;
	}
	return nearby;
}

function distanceKm(a: { lat: number; long: number }, b: { lat: number; long: number }): number {
	const radians = (degrees: number) => (degrees * Math.PI) / 180;
	const h =
		Math.sin(radians(b.lat - a.lat) / 2) ** 2 +
		Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.long - a.long) / 2) ** 2;
	return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function groupByNsp(rows: EmiSolarRow[]): EmiSolarRow[][] {
	const byNsp = new Map<string, EmiSolarRow[]>();
	for (const row of rows) {
		const series = byNsp.get(row.nsp) ?? [];
		series.push(row);
		byNsp.set(row.nsp, series);
	}
	return [...byNsp.values()].map((series) =>
		series.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd)),
	);
}

// Months since year 0 for an ISO date, so months can be subtracted.
function monthIndex(isoDate: string): number {
	return Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7)) - 1;
}

function median(values: number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(mw: number): number {
	return Math.round(mw * 1000) / 1000;
}
