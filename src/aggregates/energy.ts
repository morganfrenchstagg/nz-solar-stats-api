import { STEP_MS } from "../production/blend";
import { round } from "../production/estimate";

const STEP_HOURS = STEP_MS / (60 * 60 * 1000);

// A period's estimated distributed solar energy at each GXP.
export interface EnergyPoint {
	from: string; // first NZ date, inclusive
	to: string; // last NZ date, inclusive
	days: number; // how many of its days have been estimated
	totalMwh: number;
	gxps: Record<string, number>; // MWh
}

// A stored file of periods, e.g. every day in a month (see energyKey).
export interface EnergyFile {
	data: EnergyPoint[];
}

// A day's energy from its 10-minute estimate: each step's output held for
// the 10 minutes it starts. A day of 144 steps has 24 hours (23 or 25 when
// daylight saving starts or ends).
export function dailyEnergy(estimate: { date: string; gxps: { gxp: string; profileMw: number[] }[] }): EnergyPoint {
	const gxps = Object.fromEntries(
		estimate.gxps.map(({ gxp, profileMw }) => [gxp, profileMw.reduce((total, mw) => total + mw, 0) * STEP_HOURS]),
	);
	return { from: estimate.date, to: estimate.date, days: 1, ...totals(gxps) };
}

// The periods' sum, as one from `from` to `to`.
export function sumEnergy(from: string, to: string, points: EnergyPoint[]): EnergyPoint {
	const gxps: Record<string, number> = {};
	for (const point of points) {
		for (const [gxp, mwh] of Object.entries(point.gxps)) gxps[gxp] = (gxps[gxp] ?? 0) + mwh;
	}
	return { from, to, days: points.reduce((days, point) => days + point.days, 0), ...totals(gxps) };
}

// Replaces the period starting on the same date, if there is one, keeping
// periods in order.
export function upsertEnergy(file: EnergyFile, point: EnergyPoint): EnergyFile {
	const data = file.data.filter((existing) => existing.from !== point.from);
	data.push(point);
	data.sort((a, b) => a.from.localeCompare(b.from));
	return { data };
}

function totals(gxps: Record<string, number>): Pick<EnergyPoint, "totalMwh" | "gxps"> {
	return {
		totalMwh: round(Object.values(gxps).reduce((total, mwh) => total + mwh, 0)),
		gxps: Object.fromEntries(Object.entries(gxps).map(([gxp, mwh]) => [gxp, round(mwh)])),
	};
}
