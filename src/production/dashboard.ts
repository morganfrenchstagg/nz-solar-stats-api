import { connect } from "cloudflare:sockets";
import type { Reading } from "./estimate";

// Reads Rānui's output from its operator's Node-RED dashboard (FlowFuse
// Dashboard 2), which charts it every 2 minutes over the last hour, 24 hours
// and 7 days. The page gets its data over socket.io, so this speaks that:
// engine.io long-polling, asking for a chart's stored messages as the page
// does when it shows one.

export type HttpRequest = (method: "GET" | "POST", path: string, body?: string) => Promise<string>;

const SOCKET_PATH = "/dashboard/socket.io/?EIO=4&transport=polling";
// Packets in one polling response are separated by a record separator.
const SEPARATOR = "\x1e";
// The farm's output charts, told apart by how far back they go.
const CHART_LABEL = "Ranui Solar Output";
const MAX_POLLS = 10;
const TIMEOUT_MS = 30 * 1000;

// Readings since `since` (Unix ms), from the shortest chart going back that
// far, or the longest if none does.
export async function dashboardReadings(http: HttpRequest, since: number | null, now: Date): Promise<Reading[]> {
	const session = await DashboardSession.open(http);
	try {
		const charts = session.charts();
		if (charts.length === 0) throw new Error(`The dashboard has no "${CHART_LABEL}" chart`);
		const wanted = since === null ? Infinity : now.getTime() - since;
		const chart = charts.find((candidate) => candidate.spanMs > wanted) ?? charts[charts.length - 1];
		return await session.chartReadings(chart.id);
	} finally {
		await session.close();
	}
}

interface Chart {
	id: string;
	spanMs: number;
}

class DashboardSession {
	private buffered: string[] = [];
	private config: { widgets?: Record<string, { type?: string; props?: Record<string, unknown> }> } | null = null;

	private constructor(
		private http: HttpRequest,
		private path: string,
	) {}

	static async open(http: HttpRequest): Promise<DashboardSession> {
		const handshake = await http("GET", SOCKET_PATH);
		if (!handshake.startsWith("0")) throw new Error(`Unexpected socket.io handshake: ${handshake.slice(0, 100)}`);
		const { sid } = JSON.parse(handshake.slice(1)) as { sid: string };
		const session = new DashboardSession(http, `${SOCKET_PATH}&sid=${encodeURIComponent(sid)}`);
		await session.send("40");
		// The dashboard sends its layout once connected.
		await session.receive((event) => event === "ui-config");
		return session;
	}

	// The farm's output charts, shortest first.
	charts(): Chart[] {
		return Object.entries(this.config?.widgets ?? {})
			.filter(([, widget]) => widget.type === "ui-chart" && String(widget.props?.label ?? "").includes(CHART_LABEL))
			.map(([id, { props }]) => ({
				id,
				// e.g. 24 of 3600 seconds
				spanMs: Number(props?.removeOlder) * Number(props?.removeOlderUnit) * 1000,
			}))
			.filter((chart) => chart.spanMs > 0)
			.sort((a, b) => a.spanMs - b.spanMs);
	}

	async chartReadings(id: string): Promise<Reading[]> {
		await this.send(`42${JSON.stringify(["widget-load", id])}`);
		const messages = (await this.receive((event) => event === `widget-load:${id}`)) as unknown[];
		const readings: Reading[] = [];
		for (const message of Array.isArray(messages) ? messages : []) {
			const point = (message as { _datapoint?: { x?: unknown; y?: unknown } })?._datapoint;
			if (typeof point?.x === "number" && typeof point.y === "number" && Number.isFinite(point.y)) {
				readings.push({ time: Math.round(point.x), mw: point.y });
			}
		}
		return readings.sort((a, b) => a.time - b.time);
	}

	async close(): Promise<void> {
		// Closes the engine.io session rather than leaving it to time out.
		await this.send("1").catch(() => {});
	}

	private async send(packet: string): Promise<void> {
		const reply = await this.http("POST", this.path, packet);
		if (reply !== "ok") throw new Error(`The dashboard didn't take a packet: ${reply.slice(0, 100)}`);
	}

	// Polls until an event matching `wanted` arrives, returning its first
	// argument and keeping the dashboard's layout when it comes.
	private async receive(wanted: (event: string) => boolean): Promise<unknown> {
		for (let poll = 0; poll <= MAX_POLLS; poll++) {
			while (this.buffered.length > 0) {
				const packet = this.buffered.shift()!;
				if (packet === "2") {
					await this.send("3");
					continue;
				}
				if (packet === "1") throw new Error("The dashboard closed the session");
				if (packet.startsWith("44")) throw new Error(`The dashboard refused to connect: ${packet.slice(2, 200)}`);
				if (!packet.startsWith("42")) continue;
				const [event, ...args] = JSON.parse(packet.slice(2)) as [string, ...unknown[]];
				if (event === "ui-config") this.config = args[1] as DashboardSession["config"];
				if (wanted(event)) return event === "ui-config" ? args[1] : args[0];
			}
			if (poll < MAX_POLLS) this.buffered.push(...(await this.http("GET", this.path)).split(SEPARATOR));
		}
		throw new Error("The dashboard didn't send what was asked for");
	}
}

// HTTP/1.1 over a TCP socket. Workers can't fetch() an IP address, which is
// all the dashboard has, but can open a socket to one.
export function socketHttp(address: string): HttpRequest {
	const [hostname, port = "80"] = address.split(":");
	return async (method, path, body) => {
		const socket = connect({ hostname, port: Number(port) });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${method} ${path} timed out`)), TIMEOUT_MS);
		});
		try {
			const exchange = async () => {
				const content = body === undefined ? null : new TextEncoder().encode(body);
				const headers = [
					`${method} ${path} HTTP/1.1`,
					`Host: ${address}`,
					"Connection: close",
					...(content ? ["Content-Type: text/plain;charset=UTF-8", `Content-Length: ${content.length}`] : []),
				];
				const writer = socket.writable.getWriter();
				await writer.write(new TextEncoder().encode(`${headers.join("\r\n")}\r\n\r\n`));
				if (content) await writer.write(content);
				writer.releaseLock();
				return parseHttpResponse(new Uint8Array(await new Response(socket.readable).arrayBuffer()));
			};
			return await Promise.race([exchange(), timeout]);
		} finally {
			clearTimeout(timer);
			await socket.close().catch(() => {});
		}
	};
}

// The body of a whole HTTP/1.1 response, read until the server closed the
// connection. Throws unless it's a 200.
export function parseHttpResponse(raw: Uint8Array): string {
	const decoder = new TextDecoder();
	let headerEnd = -1;
	for (let i = 0; i + 3 < raw.length; i++) {
		if (raw[i] === 13 && raw[i + 1] === 10 && raw[i + 2] === 13 && raw[i + 3] === 10) {
			headerEnd = i;
			break;
		}
	}
	if (headerEnd < 0) throw new Error("The dashboard sent an incomplete response");
	const [statusLine, ...headerLines] = decoder.decode(raw.subarray(0, headerEnd)).split("\r\n");
	const status = Number(statusLine.split(" ")[1]);
	const headers = new Map(
		headerLines.map((line) => {
			const colon = line.indexOf(":");
			return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()] as const;
		}),
	);
	let body = raw.subarray(headerEnd + 4);
	if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
		body = dechunk(body);
	} else if (headers.has("content-length")) {
		const length = Number(headers.get("content-length"));
		if (body.length < length) throw new Error("The dashboard's response was cut short");
		body = body.subarray(0, length);
	}
	const text = decoder.decode(body);
	if (status !== 200) throw new Error(`The dashboard sent ${statusLine.slice(9)}: ${text.slice(0, 100)}`);
	return text;
}

function dechunk(body: Uint8Array): Uint8Array {
	const chunks: Uint8Array[] = [];
	let at = 0;
	while (at < body.length) {
		let lineEnd = at;
		while (lineEnd + 1 < body.length && !(body[lineEnd] === 13 && body[lineEnd + 1] === 10)) lineEnd++;
		const size = parseInt(new TextDecoder().decode(body.subarray(at, lineEnd)), 16);
		if (!(size > 0)) break;
		chunks.push(body.subarray(lineEnd + 2, lineEnd + 2 + size));
		at = lineEnd + 2 + size + 2;
	}
	const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.length;
	}
	return joined;
}
