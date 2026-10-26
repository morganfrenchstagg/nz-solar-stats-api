// A GXP's distributed capacity on any date. EMI only publishes a snapshot at
// each month end, a few weeks later, so a date gets the latest snapshot on or
// before it plus growth since then at the GXP's recent rate. Kept free of
// imports so the backtest scripts can run it under Node too.

// How fast older months fade from the growth rate: a month-on-month change
// counts half as much as one this many months newer.
export const GROWTH_HALF_LIFE_MONTHS = 3;
const GROWTH_LOOKBACK_MONTHS = 12;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS_PER_MONTH = 365.25 / 12;

export interface CapacityMonth {
	monthEnd: string; // YYYY-MM-DD
	distributedMw: number;
	stepMw: number; // farm-sized one-offs that arrived that month
}

export interface CapacityEstimate {
	capacityMw: number;
	monthEnd: string; // the snapshot it's built on
	growthMwPerMonth: number;
}

// Recent growth in MW a month: a weighted average of month-on-month changes,
// leaving out farm-sized steps, which are one-offs rather than a trend.
export function growthMwPerMonth(
	months: CapacityMonth[],
	halfLifeMonths = GROWTH_HALF_LIFE_MONTHS,
): number {
	const recent = months.slice(-(GROWTH_LOOKBACK_MONTHS + 1));
	let total = 0;
	let weights = 0;
	for (let i = 1; i < recent.length; i++) {
		const weight = 0.5 ** ((recent.length - 1 - i) / halfLifeMonths);
		total += weight * (recent[i].distributedMw - recent[i - 1].distributedMw - recent[i].stepMw);
		weights += weight;
	}
	return weights === 0 ? 0 : total / weights;
}

// `months` in date order. Null if there's no snapshot on or before the date.
export function capacityAt(
	months: CapacityMonth[],
	date: string,
	halfLifeMonths = GROWTH_HALF_LIFE_MONTHS,
): CapacityEstimate | null {
	const known = months.filter((month) => month.monthEnd <= date);
	if (known.length === 0) return null;

	const latest = known[known.length - 1];
	const growth = growthMwPerMonth(known, halfLifeMonths);
	const monthsSince = (Date.parse(date) - Date.parse(latest.monthEnd)) / DAY_MS / DAYS_PER_MONTH;
	return {
		capacityMw: Math.max(latest.distributedMw + growth * monthsSince, 0),
		monthEnd: latest.monthEnd,
		growthMwPerMonth: growth,
	};
}
