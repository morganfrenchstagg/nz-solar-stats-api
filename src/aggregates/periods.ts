// Calendar arithmetic on YYYY-MM-DD dates, which are NZ dates here.

const DAY_MS = 24 * 60 * 60 * 1000;

export function addDays(date: string, days: number): string {
	return format(parse(date) + days * DAY_MS);
}

// Months later (or earlier), with an overflowing day carried into the next
// month like SQLite's date(date, '-14 months'): 30 April less 14 months is
// 2 March.
export function addMonths(date: string, months: number): string {
	const [year, month, day] = date.split("-").map(Number);
	return format(Date.UTC(year, month - 1 + months, day));
}

export function datesBetween(from: string, to: string): string[] {
	const dates: string[] = [];
	for (let day = parse(from); day <= parse(to); day += DAY_MS) dates.push(format(day));
	return dates;
}

// An ISO 8601 week, Monday to Sunday. A week spanning new year belongs to the
// year its Thursday is in.
export function isoWeek(date: string): { year: string; from: string; to: string } {
	const day = parse(date);
	const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
	return {
		year: String(new Date(monday + 3 * DAY_MS).getUTCFullYear()),
		from: format(monday),
		to: format(monday + 6 * DAY_MS),
	};
}

// A month's first and last dates, for a month as YYYY-MM.
export function monthBounds(month: string): { from: string; to: string } {
	const [year, number] = month.split("-").map(Number);
	return { from: `${month}-01`, to: format(Date.UTC(year, number, 0)) };
}

function parse(date: string): number {
	return Date.parse(`${date}T00:00:00Z`);
}

function format(epochMs: number): string {
	return new Date(epochMs).toISOString().slice(0, 10);
}
