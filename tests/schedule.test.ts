import { describe, expect, it } from "vitest";
import { CRONS, nextRun } from "../src/schedule";

const at = (iso: string) => new Date(iso);

describe("nextRun", () => {
	it.each([
		[CRONS.production, "2026-10-26T01:03:20Z", "2026-10-26T01:10:00Z"],
		[CRONS.production, "2026-10-26T23:55:00Z", "2026-10-27T00:00:00Z"],
		[CRONS.aggregate, "2026-10-26T01:55:30Z", "2026-10-26T02:05:00Z"],
		[CRONS.capacity, "2026-10-26T01:00:00Z", "2026-10-26T18:00:00Z"],
		[CRONS.weatherArchive, "2026-10-26T11:00:00Z", "2026-10-26T14:35:00Z"],
		[CRONS.weatherArchive, "2026-10-26T14:40:00Z", "2026-10-27T10:35:00Z"],
	])("is next due for %s after %s at %s", (cron, after, due) => {
		expect(nextRun(cron, at(after))).toEqual(at(due));
	});

	it("isn't due again the instant it's due", () => {
		expect(nextRun(CRONS.production, at("2026-10-26T01:10:00Z"))).toEqual(at("2026-10-26T01:20:00Z"));
		expect(nextRun(CRONS.capacity, at("2026-10-26T18:00:00Z"))).toEqual(at("2026-10-27T18:00:00Z"));
	});

	it.each(["0 18 * * 1", "0 18 1 * *", "0-5 * * * *", "*/0 * * * *", "60 * * * *", "0 18"])(
		"won't schedule %s",
		(cron) => {
			expect(() => nextRun(cron, at("2026-10-26T01:00:00Z"))).toThrow();
		},
	);
});
