import type { SolarFarm } from "./electricityMap";
import type { EmiSolarRow } from "./emi";

// A month where an NSP's installed solar grew by more than its new rooftop
// systems explain, i.e. something farm-sized was connected.
export interface CapacityStep {
	nsp: string;
	monthEnd: string;
	mw: number;
	// Capacity in this step that the registry had at another NSP until it moved
	// it here (see followMove).
	movedIn?: CapacityMove[];
	// When the registry took the step's capacity off again (see followRemoval).
	removedMonthEnd?: string;
}

export interface CapacityMove {
	from: string; // NSP
	monthEnd: string; // when the registry moved it
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
// can still turn up in the registry at its GXP's NSPs around when it's
// commissioned. Tauhei (150 MW at Waihou 110 kV, May 2026) did as 13.2 MW at
// Waihou 33 kV, 8.9 MW of it registered at Piako until October; grid load at
// Waihou showed none of it as local generation. A farm with no commissioning
// date isn't commissioned yet, so it's taken to be commissioning in EMI's
// latest month: Ruakākā (130 MW at Bream Bay) and a 3.8 MW step at Bream Bay
// in October 2026 that its load doesn't show either.
const COMMISSIONING_MONTHS = 1;
// The registry moving a system between NSPs takes it off one and adds it to
// the other in the same month, give or take rooftops: 8.88 MW and 8.90 MW
// for Piako and Waihou in October 2026.
const MOVE_MATCH = 0.05;

// A farm-sized change in an NSP's capacity, up or down.
interface CapacityChange extends CapacityStep {
	// ICPs that joined the NSP (or left it, if negative) besides new installations.
	icpsMoved: number;
}

export function findCapacitySteps(rows: EmiSolarRow[]): CapacityStep[] {
	const changes = farmSizedChanges(rows);
	const steps = changes.filter((change) => change.mw > 0);
	for (const drop of changes.filter((change) => change.mw < 0)) {
		if (!followMove(drop, steps)) followRemoval(drop, steps);
	}
	return steps
		.map(({ icpsMoved, ...step }) => step)
		.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));
}

// Farm-sized changes in each NSP's capacity, oldest first.
function farmSizedChanges(rows: EmiSolarRow[]): CapacityChange[] {
	const firstMonthEnd = rows.reduce(
		(first, row) => (row.monthEnd < first ? row.monthEnd : first),
		rows[0]?.monthEnd ?? "",
	);

	const changes: CapacityChange[] = [];
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
				if (Math.abs(mw) >= MIN_STEP_MW) {
					const icpsMoved = icpsAdded - row.newInstallCount;
					changes.push({ nsp: row.nsp, monthEnd: row.monthEnd, mw: round(mw), icpsMoved });
				}
			}
			if (row.newInstallAvgKw !== null && row.newInstallAvgKw < ROOFTOP_MAX_KW) {
				rooftopKw.push(row.newInstallAvgKw);
			}
			previous = row;
		}
	}
	return changes.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));
}

// The registry sometimes moves a farm-sized system to another NSP, as it did
// an 8.9 MW one from Piako to Waihou in October 2026: one NSP loses an ICP and
// what the other gains, which gains one besides its new installations. (A farm
// taken off one NSP's existing ICP and another added to an existing ICP
// elsewhere the same month, as at Cambridge and Maungaturoto in April 2026,
// moves no ICP.) That isn't a new step: the system is counted at the NSP it
// went to from the month it first appeared at the one it left, and attributed
// there. Grid load agreed: Piako's
// showed the 8.8 MW left of its May step as local generation all along, and
// Waihou's none of the 8.9 MW. stepParts gives where it was month by month.
function followMove(drop: CapacityChange, steps: CapacityChange[]): boolean {
	if (drop.icpsMoved >= 0) return false;
	const arrival = steps.find(
		(step) =>
			step.monthEnd === drop.monthEnd &&
			step.nsp !== drop.nsp &&
			step.icpsMoved > 0 &&
			Math.abs(step.mw + drop.mw) <= step.mw * MOVE_MATCH,
	);
	if (!arrival) return false;
	const origin = steps
		.filter(
			(step) =>
				step.nsp === drop.nsp &&
				step.monthEnd < drop.monthEnd &&
				!step.movedIn &&
				!step.removedMonthEnd &&
				step.mw >= arrival.mw * (1 - MOVE_MATCH),
		)
		.at(-1);
	if (!origin) return false;

	steps.splice(steps.indexOf(arrival), 1);
	origin.mw = round(origin.mw - arrival.mw);
	if (origin.mw < MIN_STEP_MW) steps.splice(steps.indexOf(origin), 1);

	const move = { from: drop.nsp, monthEnd: drop.monthEnd, mw: arrival.mw };
	const there = steps.find((step) => step.nsp === arrival.nsp && step.monthEnd === origin.monthEnd);
	if (there) {
		there.mw = round(there.mw + move.mw);
		there.movedIn = [...(there.movedIn ?? []), move];
	} else {
		steps.push({ nsp: arrival.nsp, monthEnd: origin.monthEnd, mw: move.mw, movedIn: [move], icpsMoved: 0 });
		steps.sort((a, b) => a.monthEnd.localeCompare(b.monthEnd));
	}
	return true;
}

// A farm-sized system can also leave the registry altogether, as 9.1 MW at
// Cambridge did in April 2026, nine months after it appeared. A drop the size
// of an earlier step at the same NSP takes that step off again, so it isn't
// still modelled as a farm once it's gone.
function followRemoval(drop: CapacityChange, steps: CapacityChange[]) {
	const origin = steps
		.filter((step) => step.nsp === drop.nsp && step.monthEnd < drop.monthEnd && !step.removedMonthEnd)
		.at(-1);
	if (origin && Math.abs(origin.mw + drop.mw) <= origin.mw * MOVE_MATCH) {
		origin.removedMonthEnd = drop.monthEnd;
	}
}

// Where a step's capacity was in the registry, as changes at each NSP: any
// capacity moved into it was at the NSP it came from until the move, and
// capacity taken off again goes at the month it went.
export function stepParts(step: CapacityStep): CapacityStep[] {
	const moves = step.movedIn ?? [];
	const own = round(step.mw - moves.reduce((total, move) => total + move.mw, 0));
	return [
		...(own > 0 ? [{ nsp: step.nsp, monthEnd: step.monthEnd, mw: own }] : []),
		...moves.flatMap((move) => [
			{ nsp: move.from, monthEnd: step.monthEnd, mw: move.mw },
			{ nsp: move.from, monthEnd: move.monthEnd, mw: -move.mw },
			{ nsp: step.nsp, monthEnd: move.monthEnd, mw: move.mw },
		]),
		...(step.removedMonthEnd ? [{ nsp: step.nsp, monthEnd: step.removedMonthEnd, mw: -step.mw }] : []),
	];
}

// Works out which capacity steps are dispatched solar farms, given EMI's latest
// month end. Farms connected straight to the grid have no NSP in EMI, so only
// get the steps at their GXP around when they're commissioned (see
// COMMISSIONING_MONTHS).
export function attributeStepsToFarms(
	steps: CapacityStep[],
	farms: SolarFarm[],
	latestMonthEnd: string,
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
			for (const step of commissioningSteps(farm, candidates, latestMonthEnd)) {
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

// Steps from a little before a farm was commissioned to the month after, up to
// its capacity.
function commissioningSteps(
	farm: SolarFarm,
	steps: CapacityStep[],
	latestMonthEnd: string,
): CapacityStep[] {
	const commissioned = monthIndex(farm.commissioned ?? latestMonthEnd);
	const claimed: CapacityStep[] = [];
	let total = 0;
	for (const step of steps) {
		const monthsAfter = monthIndex(step.monthEnd) - commissioned;
		if (monthsAfter < -LEAD_MONTHS || monthsAfter > COMMISSIONING_MONTHS) continue;
		if (total + step.mw > farm.capacityMw * MAX_MATCH) continue;
		claimed.push(step);
		total += step.mw;
	}
	return claimed;
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
