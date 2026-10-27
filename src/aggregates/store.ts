import { type EnergyFile, type EnergyPoint, sumEnergy, upsertEnergy } from "./energy";
import { datesBetween, isoWeek, monthBounds } from "./periods";

export type EnergyResolution = "daily" | "weekly" | "monthly" | "annual";

// Where each file of energy totals is kept in R2: a month's days, an ISO
// year's weeks, a year's months, and every year. Periods are YYYY-MM for
// daily and YYYY otherwise; annual has the one file.
export function energyKey(resolution: EnergyResolution, period: string): string {
	return resolution === "annual" ? "aggregates/annual.json" : `aggregates/${resolution}/${period}.json`;
}

// A day's estimate every 10 minutes, in the same form as the production job's.
export function tenMinuteKey(date: string): string {
	return `aggregates/10-minute/${date}.json`;
}

// Weather fetched from Open-Meteo's archive for a day, to estimate it from.
export function archivedWeatherKey(date: string): string {
	return `weather/${date}.json`;
}

const JSON_METADATA = { httpMetadata: { contentType: "application/json" } };

// Energy files read during a run, kept in memory, and written back if they
// changed.
export class EnergyStore {
	private files = new Map<string, EnergyFile>();
	private changed = new Set<string>();

	constructor(private bucket: R2Bucket) {}

	async get(resolution: EnergyResolution, period: string): Promise<EnergyFile> {
		const key = energyKey(resolution, period);
		let file = this.files.get(key);
		if (!file) {
			file = (await (await this.bucket.get(key))?.json<EnergyFile>()) ?? { data: [] };
			this.files.set(key, file);
		}
		return file;
	}

	async upsert(resolution: EnergyResolution, period: string, point: EnergyPoint): Promise<void> {
		const file = await this.get(resolution, period);
		const key = energyKey(resolution, period);
		this.files.set(key, upsertEnergy(file, point));
		this.changed.add(key);
	}

	async flush(): Promise<void> {
		for (const key of this.changed) {
			await this.bucket.put(key, JSON.stringify(this.files.get(key)), JSON_METADATA);
		}
		this.changed.clear();
	}
}

// Sums the weeks, months and years with any of the dates in them from their
// days. A week can span two months, so it's summed from the days rather than
// from what's changed.
export async function sumPeriods(store: EnergyStore, dates: string[]): Promise<void> {
	const weeks = new Map(dates.map((date) => isoWeek(date)).map((week) => [week.from, week]));
	for (const week of weeks.values()) {
		const days: EnergyPoint[] = [];
		for (const date of datesBetween(week.from, week.to)) {
			const day = (await store.get("daily", date.slice(0, 7))).data.find((point) => point.from === date);
			if (day) days.push(day);
		}
		await store.upsert("weekly", week.year, sumEnergy(week.from, week.to, days));
	}

	const months = [...new Set(dates.map((date) => date.slice(0, 7)))];
	for (const month of months) {
		const { from, to } = monthBounds(month);
		await store.upsert("monthly", month.slice(0, 4), sumEnergy(from, to, (await store.get("daily", month)).data));
	}

	for (const year of new Set(months.map((month) => month.slice(0, 4)))) {
		const monthly = (await store.get("monthly", year)).data;
		await store.upsert("annual", "all", sumEnergy(`${year}-01-01`, `${year}-12-31`, monthly));
	}
}
