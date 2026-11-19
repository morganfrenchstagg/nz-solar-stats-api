// Reads the System Operator's 5-minute real-time dispatch, as served by
// electricitymap, and fits how much of a GXP's load the modelled solar
// explains. Load buses are series without a unit suffix (e.g. BLN0331),
// negative when drawing from the grid. Dispatched generators, solar farms
// included, are separate series with one (e.g. KOE1101 KSF0) and aren't
// netted into the load buses.
import { nzInstant } from "./shared.ts";

export const DISPATCH_URL = "https://api.electricitymap.frenchsta.gg/v1/dispatch";
const FIVE_MINUTES_MS = 5 * 60 * 1000;
// Longer gaps than this aren't bridged: about 5% of readings are missing,
// mostly one or two at a time.
const MAX_GAP_MS = 25 * 60 * 1000;

export interface DispatchDay {
	series: string[];
	data: (string | number | null)[][]; // [NZ clock time, a value per series]
}

export type Readings = Map<number, number>; // epoch ms → MW

// Each series' readings by instant.
export function parseDispatch(days: DispatchDay[]): Map<string, Readings> {
	const readings = new Map<string, Readings>();
	for (const day of days) {
		const series = day.series.map((name) => {
			const existing = readings.get(name) ?? new Map<number, number>();
			readings.set(name, existing);
			return existing;
		});
		for (const [clock, ...values] of day.data) {
			const time = nzInstant(clock as string);
			values.forEach((value, i) => {
				if (typeof value === "number") series[i].set(time, value);
			});
		}
	}
	return readings;
}

// A GXP's net load, at the instants every one of its load buses has a reading.
export function netLoad(readings: Map<string, Readings>, site: string): Readings {
	const buses = [...readings].filter(([name]) => name.startsWith(site) && !name.includes(" ")).map(([, bus]) => bus);
	const load: Readings = new Map();
	if (buses.length === 0) return load;
	for (const time of buses[0].keys()) {
		if (buses.every((bus) => bus.has(time))) load.set(time, -buses.reduce((sum, bus) => sum + bus.get(time)!, 0));
	}
	return load;
}

// Average MW from `start` to `end`, by the trapezoid rule over the 5-minute
// readings with short gaps bridged; null if a longer gap falls in it.
export function averageMw(readings: Readings, start: number, end: number): number | null {
	let total = 0;
	let previous: number | null = null;
	for (let time = start; time <= end; time += FIVE_MINUTES_MS) {
		const value = readingAt(readings, time);
		if (value === null) return null;
		if (previous !== null) total += (previous + value) / 2;
		previous = value;
	}
	return total / ((end - start) / FIVE_MINUTES_MS);
}

function readingAt(readings: Readings, time: number): number | null {
	if (readings.has(time)) return readings.get(time)!;
	let before: number | null = null;
	let after: number | null = null;
	for (let step = FIVE_MINUTES_MS; step < MAX_GAP_MS; step += FIVE_MINUTES_MS) {
		if (before === null && readings.has(time - step)) before = time - step;
		if (after === null && readings.has(time + step)) after = time + step;
	}
	if (before === null || after === null || after - before > MAX_GAP_MS) return null;
	return readings.get(before)! + ((time - before) / (after - before)) * (readings.get(after)! - readings.get(before)!);
}

export interface Slope {
	slope: number;
	// Clustered by group: a group's errors (a day's) tend to run together.
	standardError: number;
}

// The least-squares slope of y on x, with a level for each group and the
// given control columns, all fitted together. The controls may overlap with
// the groups or each other: the parts that add nothing are dropped.
export function fitSlope({ y, x, groups, controls }: { y: number[]; x: number[]; groups: number[]; controls: number[][] }): Slope {
	// A level for each group: take each group's mean out of everything.
	const withinGroups = (values: ArrayLike<number>) => {
		const sums = new Map<number, [number, number]>();
		groups.forEach((group, i) => {
			const [sum, count] = sums.get(group) ?? [0, 0];
			sums.set(group, [sum + values[i], count + 1]);
		});
		return Float64Array.from(values, (value, i) => {
			const [sum, count] = sums.get(groups[i])!;
			return value - sum / count;
		});
	};
	const dot = (a: Float64Array, b: Float64Array) => {
		let total = 0;
		for (let i = 0; i < a.length; i++) total += a[i] * b[i];
		return total;
	};
	const removeBasis = (values: Float64Array, basis: Float64Array[]) => {
		for (const unit of basis) {
			const along = dot(values, unit);
			for (let i = 0; i < values.length; i++) values[i] -= along * unit[i];
		}
	};

	// An orthonormal basis for the controls (Gram–Schmidt), then y and x with
	// it taken out (Frisch–Waugh): the slope between what's left is the fit's.
	const basis: Float64Array[] = [];
	for (const control of controls) {
		const column = withinGroups(control);
		const length = Math.sqrt(dot(column, column));
		// Twice, so a column that's nearly in the basis comes out square to it.
		removeBasis(column, basis);
		removeBasis(column, basis);
		const remaining = Math.sqrt(dot(column, column));
		if (remaining > 1e-9 * length) basis.push(column.map((value) => value / remaining));
	}
	const ry = withinGroups(y);
	const rx = withinGroups(x);
	removeBasis(ry, basis);
	removeBasis(rx, basis);

	const xx = dot(rx, rx);
	const slope = dot(ry, rx) / xx;
	const scores = new Map<number, number>();
	groups.forEach((group, i) => scores.set(group, (scores.get(group) ?? 0) + rx[i] * (ry[i] - slope * rx[i])));
	const standardError = Math.sqrt([...scores.values()].reduce((total, score) => total + score ** 2, 0)) / xx;
	return { slope, standardError };
}
