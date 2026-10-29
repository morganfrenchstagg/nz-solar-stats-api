// The cron triggers in wrangler.jsonc. src/index.ts tells the jobs apart by
// these strings, and responses are cached until the job storing their data
// is next due (src/endpoints/cacheControl.ts).
export const CRONS = {
	// Daily at 6–7am NZ time.
	capacity: "0 18 * * *",
	production: "*/10 * * * *",
	// Five minutes after each production run.
	aggregate: "5,15,25,35,45,55 * * * *",
	// Twice a day, at NZ night.
	weatherArchive: "35 10,14 * * *",
} as const;

const MINUTE_MS = 60 * 1000;

// When a cron is next due after an instant. Only crons that run every day are
// supported: a minute and an hour (each *, */n or a list of numbers), in UTC
// as Cloudflare runs them, and * for the rest.
export function nextRun(cron: string, after: Date): Date {
	const [minute, hour, ...rest] = cron.split(" ");
	if (rest.length !== 3 || rest.some((field) => field !== "*")) {
		throw new Error(`Can't schedule ${cron}: only its minute and hour can be set`);
	}
	const minutes = cronValues(minute, 60);
	const hours = cronValues(hour, 24);
	const run = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS);
	do run.setTime(run.getTime() + MINUTE_MS);
	while (!minutes.has(run.getUTCMinutes()) || !hours.has(run.getUTCHours()));
	return run;
}

// The values a cron field allows, from 0 to below `size`.
function cronValues(field: string, size: number): Set<number> {
	const every = field.match(/^\*(?:\/(\d+))?$/);
	const values = every
		? Array.from({ length: size }, (_, value) => value).filter((value) => value % Number(every[1] ?? 1) === 0)
		: field.split(",").map(Number);
	if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value < 0 || value >= size)) {
		throw new Error(`Can't schedule a cron field of ${field}`);
	}
	return new Set(values);
}
