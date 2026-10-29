import { CRONS, nextRun } from "../schedule";
import { AppContext } from "../types";

const MINUTE_MS = 60 * 1000;

interface Schedule {
	crons: string[];
	// How long after a run's due its data can be counted on to be stored: a
	// run can start a little late, and takes a while.
	allowanceMs: number;
	// Kept at least this long, then until the next run's stored its data.
	atLeastMs?: number;
}

// The runs that store each kind of response's data again.
const REFRESHES = {
	// Today's and yesterday's estimates.
	production: { crons: [CRONS.production], allowanceMs: 2 * MINUTE_MS },
	// How far the backfill has got.
	aggregate: { crons: [CRONS.aggregate], allowanceMs: 2 * MINUTE_MS },
	// Energy in periods with yesterday in them, which is estimated again each
	// time its weather's refreshed. They're kept an hour or so rather than
	// fetched again every run.
	currentEnergy: { crons: [CRONS.aggregate], allowanceMs: 2 * MINUTE_MS, atLeastMs: 60 * MINUTE_MS },
	capacity: { crons: [CRONS.capacity], allowanceMs: 10 * MINUTE_MS },
	// Days before yesterday, and periods that ended before it, are only
	// estimated again once the weather archive job brings them weather or the
	// capacity job new capacities, allowing for the aggregate job's run after
	// that; or when a deploy changes the model, which no schedule can tell.
	history: { crons: [CRONS.weatherArchive, CRONS.capacity], allowanceMs: 20 * MINUTE_MS },
} satisfies Record<string, Schedule>;

export type Refresh = keyof typeof REFRESHES;

// Lets a response be cached until its data's next due to be stored again.
export function cacheUntilStale(c: AppContext, refresh: Refresh, now = new Date()): void {
	// Set on c.res, which Hono merges into the response chanfana makes from
	// what an endpoint returns.
	c.res.headers.set("Cache-Control", `public, max-age=${secondsUntilStale(refresh, now)}`);
}

// Seconds until the next run (at least atLeastMs from now) will have stored
// its data. That's the one under way if it was due within the allowance before
// then: what it's about to store mustn't be cached past.
export function secondsUntilStale(refresh: Refresh, now: Date): number {
	const { crons, allowanceMs, atLeastMs = 0 }: Schedule = REFRESHES[refresh];
	const since = new Date(now.getTime() + atLeastMs - allowanceMs);
	const due = Math.min(...crons.map((cron) => nextRun(cron, since).getTime()));
	return Math.ceil((due + allowanceMs - now.getTime()) / 1000);
}
