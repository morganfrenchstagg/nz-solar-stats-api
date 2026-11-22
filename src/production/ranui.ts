import type { MeteredFarm, Reading } from "./estimate";
import { nzDate } from "./weather";

// Rānui, a solar farm on the distribution network at Blenheim, too small to
// be dispatched. Its operator's dashboard shows its export every 2 minutes
// (see dashboard.ts), which the production job stores and the model uses in
// place of the farm array wherever there are readings.
export const RANUI = {
	id: "ranui",
	name: "Rānui",
	gxp: "BLN",
	// Its step in the registry, which arrived at Blenheim in March 2026: the
	// farm is part of Blenheim's farm-sized steps from that month end.
	capacityMw: 11.128,
	since: "2026-03-31",
	// Its export sits flat at just under 10 MW for hours on sunny days, below
	// its registry capacity, so the farm array is held to it too.
	exportLimitMw: 10,
} as const;

const MINUTE_MS = 60 * 1000;
// Readings this close either side of a day count towards its first and last
// 10-minute steps.
const MARGIN_MS = 5 * MINUTE_MS;

// The instant an NZ date starts.
export function nzMidnight(date: string): number {
	for (const offset of ["+13:00", "+12:00"]) {
		const midnight = Date.parse(`${date}T00:00:00${offset}`);
		if (nzDate(new Date(midnight)) === date && nzDate(new Date(midnight - 1)) !== date) return midnight;
	}
	throw new Error(`Can't find when ${date} starts in NZ`);
}

function nextDate(date: string): string {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + 1);
	return day.toISOString().slice(0, 10);
}

// Rānui as a metered farm on an NZ date, or null before it's in Blenheim's
// capacity.
export function ranuiFarm(date: string, readings: Reading[]): MeteredFarm | null {
	if (date < RANUI.since) return null;
	return { gxp: RANUI.gxp, capacityMw: RANUI.capacityMw, exportLimitMw: RANUI.exportLimitMw, readings };
}

// Rānui's readings through an NZ date, in time order.
export async function ranuiReadingsOn(db: D1Database, date: string): Promise<Reading[]> {
	if (date < RANUI.since) return [];
	const { results } = await db
		.prepare("SELECT time, mw FROM farm_readings WHERE farm = ?1 AND time >= ?2 AND time < ?3 ORDER BY time")
		.bind(RANUI.id, nzMidnight(date) - MARGIN_MS, nzMidnight(nextDate(date)) + MARGIN_MS)
		.all<Reading>();
	return results;
}

// When Rānui's latest stored reading was taken, or null if there are none.
export async function latestRanuiReading(db: D1Database): Promise<number | null> {
	return db.prepare("SELECT max(time) AS time FROM farm_readings WHERE farm = ?").bind(RANUI.id).first<number>("time");
}

// Stores readings, keeping any already stored for the same instant, and
// records each day's readings against it so the aggregate job estimates it
// again. A day it hasn't indexed yet is estimated with its readings anyway.
// Returns the NZ dates the readings are in.
export async function storeRanuiReadings(db: D1Database, readings: Reading[]): Promise<string[]> {
	if (readings.length === 0) return [];
	const dates = [...new Set(readings.map((reading) => nzDate(new Date(reading.time))))].sort();
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO farm_readings (farm, time, mw)
				SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?2)`,
			)
			.bind(RANUI.id, JSON.stringify(readings.map((reading) => [reading.time, reading.mw]))),
		...dates.map((date) =>
			db
				.prepare(
					`UPDATE production_days SET metered = (
						SELECT count(*) || ' ' || max(time) FROM farm_readings WHERE farm = ?1 AND time >= ?2 AND time < ?3
					) WHERE nz_date = ?4`,
				)
				.bind(RANUI.id, nzMidnight(date) - MARGIN_MS, nzMidnight(nextDate(date)) + MARGIN_MS, date),
		),
	]);
	return dates;
}
