import { describe, expect, it } from "vitest";
import { dashboardReadings, type HttpRequest, parseHttpResponse } from "../../src/production/dashboard";

const NOW = new Date("2026-11-22T07:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const CHARTS = {
	hour: { label: "Ranui Solar Output Hour", removeOlder: "60", removeOlderUnit: "60" },
	day: { label: "Ranui Solar Output Day", removeOlder: "24", removeOlderUnit: "3600" },
	week: { label: "Ranui Solar Output week", removeOlder: "7", removeOlderUnit: "86400" },
};

// A FlowFuse dashboard over engine.io long-polling, as Rānui's serves it: a
// handshake, then the layout once connected, then a chart's messages (one
// every 2 minutes over its span) when they're asked for, with a ping first.
// Records the packets posted to it and the charts asked for.
function fakeDashboard() {
	const posted: string[] = [];
	const loaded: string[] = [];
	let queue: string[] = [];
	const widgets = Object.fromEntries([
		...Object.entries(CHARTS).map(([id, props]) => [id, { type: "ui-chart", props: { ...props, xAxisType: "time" } }]),
		["wind", { type: "ui-chart", props: { label: "Wind", removeOlder: "24", removeOlderUnit: "3600" } }],
		["output", { type: "ui-text", props: { label: "Output" } }],
	]);
	const http: HttpRequest = async (method, path, body) => {
		if (!path.includes("sid=")) return `0${JSON.stringify({ sid: "abc", pingInterval: 25000 })}`;
		if (method === "POST") {
			posted.push(...body!.split("\x1e"));
			for (const packet of body!.split("\x1e")) {
				if (packet === "40") queue.push(`40{"sid":"def"}`, `42${JSON.stringify(["ui-config", "base", { widgets }])}`);
				if (packet.startsWith("42")) {
					const [, id] = JSON.parse(packet.slice(2));
					loaded.push(id);
					const spanMs = Number(CHARTS[id as keyof typeof CHARTS].removeOlder) * Number(CHARTS[id as keyof typeof CHARTS].removeOlderUnit) * 1000;
					const messages = Array.from({ length: spanMs / (2 * MINUTE) }, (_, i) => {
						const x = NOW.getTime() - spanMs + (i + 1) * 2 * MINUTE;
						return { topic: "RSL/MW", payload: i / 10, _datapoint: { category: "RSL/MW", x, y: i / 10 } };
					});
					queue.push("2", `42${JSON.stringify([`widget-load:${id}`, messages])}`);
				}
			}
			return "ok";
		}
		const reply = queue.join("\x1e");
		queue = [];
		return reply;
	};
	return { http, posted, loaded };
}

describe("dashboardReadings", () => {
	it("reads the last hour's chart when the latest stored reading is recent", async () => {
		const dashboard = fakeDashboard();
		const readings = await dashboardReadings(dashboard.http, NOW.getTime() - 20 * MINUTE, NOW);
		expect(dashboard.loaded).toEqual(["hour"]);
		expect(readings).toHaveLength(30);
		expect(readings[0]).toEqual({ time: NOW.getTime() - HOUR + 2 * MINUTE, mw: 0 });
		expect(readings.at(-1)).toEqual({ time: NOW.getTime(), mw: 2.9 });
		// It answers the ping, and closes the session when it's done.
		expect(dashboard.posted).toEqual(["40", `42["widget-load","hour"]`, "3", "1"]);
	});

	it("goes back further after a gap", async () => {
		const dashboard = fakeDashboard();
		await dashboardReadings(dashboard.http, NOW.getTime() - 3 * HOUR, NOW);
		await dashboardReadings(dashboard.http, NOW.getTime() - 30 * HOUR, NOW);
		expect(dashboard.loaded).toEqual(["day", "week"]);
	});

	it("reads the longest chart when there are no readings yet, or the gap is longer than it", async () => {
		const dashboard = fakeDashboard();
		await dashboardReadings(dashboard.http, null, NOW);
		const readings = await dashboardReadings(dashboard.http, NOW.getTime() - 30 * 24 * HOUR, NOW);
		expect(dashboard.loaded).toEqual(["week", "week"]);
		expect(readings).toHaveLength(7 * 24 * 30);
	});

	it("fails when the dashboard doesn't answer", async () => {
		const silent: HttpRequest = async (method, path) =>
			!path.includes("sid=") ? `0{"sid":"abc"}` : method === "POST" ? "ok" : "";
		await expect(dashboardReadings(silent, null, NOW)).rejects.toThrow("didn't send what was asked for");
	});
});

describe("parseHttpResponse", () => {
	const encode = (text: string) => new TextEncoder().encode(text);

	it("reads a body of the length given", () => {
		expect(parseHttpResponse(encode("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"))).toBe("hello");
	});

	it("joins a chunked body's chunks", () => {
		const raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nRā\r\n3\r\nnui\r\n0\r\n\r\n";
		expect(parseHttpResponse(encode(raw))).toBe("Rānui");
	});

	it("fails on an error status or a body cut short", () => {
		expect(() => parseHttpResponse(encode("HTTP/1.1 400 Bad Request\r\nContent-Length: 2\r\n\r\nno"))).toThrow(
			"400 Bad Request",
		);
		expect(() => parseHttpResponse(encode("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\nshort"))).toThrow("cut short");
	});
});
