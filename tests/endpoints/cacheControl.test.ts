import { describe, expect, it } from "vitest";
import { secondsUntilStale } from "../../src/endpoints/cacheControl";

const at = (iso: string) => new Date(iso);
const minutes = (count: number) => count * 60;
const hours = (count: number) => count * 60 * 60;

describe("secondsUntilStale", () => {
	it("lasts until the production job's next run has had two minutes to store today's estimate", () => {
		expect(secondsUntilStale("production", at("2026-10-26T01:03:20Z"))).toBe(minutes(8) + 40);
	});

	it("doesn't last past what a run under way is about to store", () => {
		expect(secondsUntilStale("production", at("2026-10-26T01:00:00Z"))).toBe(minutes(2));
		expect(secondsUntilStale("production", at("2026-10-26T01:01:59Z"))).toBe(1);
		expect(secondsUntilStale("production", at("2026-10-26T01:02:00Z"))).toBe(minutes(10));
	});

	it("follows the aggregate job five minutes behind", () => {
		expect(secondsUntilStale("aggregate", at("2026-10-26T01:00:00Z"))).toBe(minutes(7));
	});

	it("keeps current energy an hour, then until the aggregate job's next run", () => {
		expect(secondsUntilStale("currentEnergy", at("2026-10-26T01:00:00Z"))).toBe(minutes(67));
		expect(secondsUntilStale("currentEnergy", at("2026-10-26T01:06:00Z"))).toBe(minutes(61));
		expect(secondsUntilStale("currentEnergy", at("2026-10-26T01:07:00Z"))).toBe(minutes(70));
	});

	it("lasts until the capacity job's next daily run", () => {
		expect(secondsUntilStale("capacity", at("2026-10-26T18:05:00Z"))).toBe(minutes(5));
		expect(secondsUntilStale("capacity", at("2026-10-26T18:10:00Z"))).toBe(hours(24));
	});

	it("keeps days before yesterday until the weather archive or capacity job could change them", () => {
		// The archive job's 10:35 UTC run, and the aggregate job's run after it.
		expect(secondsUntilStale("history", at("2026-10-26T01:00:00Z"))).toBe(hours(9) + minutes(55));
		// The capacity job's.
		expect(secondsUntilStale("history", at("2026-10-26T15:00:00Z"))).toBe(hours(3) + minutes(20));
		// Overnight, to the next day's archive run.
		expect(secondsUntilStale("history", at("2026-10-26T18:30:00Z"))).toBe(hours(16) + minutes(25));
	});
});
