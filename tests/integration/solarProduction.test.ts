import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tenMinuteKey } from "../../src/aggregates/store";
import { estimateKey } from "../../src/production/job";

// 2pm on Monday 26 October in NZ.
const NOW = Date.parse("2026-10-26T01:00:00Z");

async function getProduction(path = "") {
	const response = await SELF.fetch(`http://local.test/solar-production${path}`);
	const body = await response.json<{ success: boolean; result: any; errors?: { message: string }[] }>();
	return { status: response.status, body };
}

// Cut down to what tells the days apart; the job's tests cover what's in them.
function estimateFor(date: string) {
	return { time: NOW, date, total: { productionMw: date === "2026-10-26" ? 49.414 : null } };
}

describe("GET /solar-production[/{date}]", () => {
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		// R2 state is shared between tests, so start each one from the same files.
		const { objects } = await env.DATASET.list();
		if (objects.length > 0) await env.DATASET.delete(objects.map((object) => object.key));
		for (const date of ["2026-10-20", "2026-10-25", "2026-10-26"]) {
			await env.DATASET.put(estimateKey(date), JSON.stringify(estimateFor(date)));
		}
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("serves today's estimate as the job last stored it, without asking Open-Meteo", async () => {
		const fetch = vi.spyOn(globalThis, "fetch");
		const { status, body } = await getProduction();

		expect(status).toBe(200);
		expect(body).toEqual({ success: true, result: estimateFor("2026-10-26") });
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		["/today", "2026-10-26"],
		["/yesterday", "2026-10-25"],
		["/2026-10-20", "2026-10-20"],
	])("serves %s's estimate", async (path, date) => {
		const { status, body } = await getProduction(path);
		expect(status).toBe(200);
		expect(body.result).toEqual(estimateFor(date));
	});

	it("goes by the NZ date, which turns over before UTC's", async () => {
		// Just after midnight on Tuesday in NZ, still Monday in UTC.
		vi.setSystemTime(Date.parse("2026-10-26T11:05:00Z"));
		await env.DATASET.put(estimateKey("2026-10-27"), JSON.stringify(estimateFor("2026-10-27")));

		expect((await getProduction()).body.result.date).toBe("2026-10-27");
		expect((await getProduction("/yesterday")).body.result.date).toBe("2026-10-26");
	});

	it("serves a day before yesterday as the aggregate job last estimated it", async () => {
		const recalculated = { ...estimateFor("2026-10-20"), time: NOW + 1000 };
		await env.DATASET.put(tenMinuteKey("2026-10-20"), JSON.stringify(recalculated));
		// From before the production job started.
		await env.DATASET.put(tenMinuteKey("2016-01-01"), JSON.stringify(estimateFor("2016-01-01")));

		expect((await getProduction("/2026-10-20")).body.result).toEqual(recalculated);
		expect((await getProduction("/2016-01-01")).body.result).toEqual(estimateFor("2016-01-01"));
	});

	it("serves yesterday as the production job last stored it, or failing that the aggregate job", async () => {
		await env.DATASET.put(tenMinuteKey("2026-10-25"), JSON.stringify({ ...estimateFor("2026-10-25"), time: NOW - 1000 }));
		expect((await getProduction("/yesterday")).body.result).toEqual(estimateFor("2026-10-25"));

		await env.DATASET.delete(estimateKey("2026-10-25"));
		expect((await getProduction("/yesterday")).body.result.time).toBe(NOW - 1000);
	});

	it("returns 404 for a day with no estimate stored", async () => {
		const { status, body } = await getProduction("/2026-10-30");

		expect(status).toBe(404);
		expect(body.errors![0].message).toBe("No estimate for 2026-10-30");
	});

	it("returns 404 for today before the job has stored it", async () => {
		await env.DATASET.delete(estimateKey("2026-10-26"));
		expect((await getProduction()).status).toBe(404);
	});

	it.each(["/tomorrow", "/26-10-2026", "/2026-13-01"])("rejects %s as a date", async (path) => {
		const { status } = await getProduction(path);
		expect(status).toBe(400);
	});
});
