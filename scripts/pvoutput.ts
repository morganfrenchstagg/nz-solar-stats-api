// A small client for PVOutput's API: https://pvoutput.org/help/api_specification.html
//
// Every request needs an API key and the caller's own system id. Reading
// another system's data (sid1) needs Donation mode on the caller's account.
// Free keys get 60 requests an hour, Donation mode 300.

const SERVICE_URL = "https://pvoutput.org/service/r2";
// Get Output returns at most 50 days per request (150 in Donation mode).
const OUTPUT_DAYS_PER_REQUEST = 50;

// Node runs these scripts by stripping types, so no parameter properties.
export class PvOutputError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.status = status;
	}

	get needsDonationMode(): boolean {
		return this.status === 403 && /donation/i.test(this.message);
	}

	get rateLimited(): boolean {
		return this.status === 403 && /exceeded/i.test(this.message);
	}
}

export interface SearchResult {
	systemId: string;
	name: string;
	sizeW: number;
	orientation: string;
	outputs: number;
	lastOutput: string;
	distanceKm: number | null;
	lat: number;
	long: number;
}

export interface SystemInfo {
	name: string;
	sizeW: number; // panels
	inverterW: number | null;
	orientation: string;
	tiltDegrees: number | null;
	shade: string;
	lat: number;
	long: number;
}

export interface DailyOutput {
	date: string; // YYYY-MM-DD
	generatedWh: number | null;
}

export class PvOutput {
	remaining: number | null = null;
	resetsAt: Date | null = null;
	readonly ownSystemId: string;
	private readonly apiKey: string;

	constructor(apiKey: string, ownSystemId: string) {
		this.apiKey = apiKey;
		this.ownSystemId = ownSystemId;
	}

	async search(lat: number, long: number, radiusKm: number, seenDays: number): Promise<SearchResult[]> {
		return parseSearch(
			await this.get("search", { q: `${radiusKm}km`, ll: `${lat},${long}`, seen: String(seenDays) }),
		);
	}

	async system(systemId: string): Promise<SystemInfo> {
		return parseSystem(await this.get("getsystem", this.of(systemId)));
	}

	// Daily generation between two YYYY-MM-DD dates, inclusive.
	async outputs(systemId: string, from: string, to: string): Promise<DailyOutput[]> {
		const outputs: DailyOutput[] = [];
		for (let start = from; start <= to; start = addDays(start, OUTPUT_DAYS_PER_REQUEST)) {
			const end = [addDays(start, OUTPUT_DAYS_PER_REQUEST - 1), to].sort()[0];
			const body = await this.get("getoutput", {
				...this.of(systemId),
				df: start.replaceAll("-", ""),
				dt: end.replaceAll("-", ""),
				limit: String(OUTPUT_DAYS_PER_REQUEST),
			});
			outputs.push(...parseOutputs(body));
		}
		return outputs;
	}

	// The caller's own system needs no sid1, and so no Donation mode.
	private of(systemId: string): Record<string, string> {
		return systemId === this.ownSystemId ? {} : { sid1: systemId };
	}

	private async get(service: string, params: Record<string, string>): Promise<string> {
		const res = await fetch(`${SERVICE_URL}/${service}.jsp?${new URLSearchParams(params)}`, {
			headers: {
				"X-Pvoutput-Apikey": this.apiKey,
				"X-Pvoutput-SystemId": this.ownSystemId,
				"X-Rate-Limit": "1",
			},
		});
		const remaining = res.headers.get("X-Rate-Limit-Remaining");
		const reset = res.headers.get("X-Rate-Limit-Reset");
		if (remaining !== null) this.remaining = Number(remaining);
		if (reset !== null) this.resetsAt = new Date(Number(reset) * 1000);

		const body = await res.text();
		if (!res.ok) throw new PvOutputError(body.trim() || res.statusText, res.status);
		return body;
	}
}

// Lines of: name,size,postcode,orientation,outputs,last output,system id,
// panel,inverter,distance,latitude,longitude. Names and equipment can contain
// commas, so the fixed fields are found around them.
export function parseSearch(body: string): SearchResult[] {
	return body
		.split(/\r?\n/)
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const fields = line.split(",");
			const [distance, lat, long] = fields.slice(-3);
			const left = fields.slice(0, -3);
			const isWhole = (value: string | undefined) => value !== undefined && /^\d+$/.test(value);
			const at = left.findIndex(
				(field, i) => i > 0 && isWhole(field) && isWhole(left[i + 3]) && isWhole(left[i + 5]),
			);
			if (at === -1) throw new Error(`Unrecognised PVOutput search result: ${line}`);
			return {
				systemId: left[at + 5],
				name: left.slice(0, at).join(","),
				sizeW: Number(left[at]),
				orientation: left[at + 2],
				outputs: Number(left[at + 3]),
				lastOutput: left[at + 4],
				distanceKm: distance === "NaN" || distance === "" ? null : Number(distance),
				lat: Number(lat),
				long: Number(long),
			};
		});
}

// name,size,postcode,panels,panel power,panel brand,inverters,inverter power,
// inverter brand,orientation,tilt,shade,install date,latitude,longitude,status
// interval, then ;-separated optional sections.
export function parseSystem(body: string): SystemInfo {
	const fields = body.split(";")[0].trim().split(",");
	if (fields.length < 16) throw new Error(`Unrecognised PVOutput system: ${body}`);
	const fromEnd = (i: number) => fields[fields.length - i];
	const number = (value: string) => (value === "NaN" || value === "" ? null : Number(value));
	const sizeW = number(fromEnd(15));
	const lat = number(fromEnd(3));
	const long = number(fromEnd(2));
	if (sizeW === null || lat === null || long === null) {
		throw new Error(`Unrecognised PVOutput system: ${body}`);
	}
	return {
		name: fields.slice(0, fields.length - 15).join(","),
		sizeW,
		inverterW: number(fromEnd(9)),
		orientation: fromEnd(7),
		tiltDegrees: number(fromEnd(6)),
		shade: fromEnd(5),
		lat,
		long,
	};
}

// ;-separated days of: date,generated Wh,efficiency,exported,used,peak power,...
export function parseOutputs(body: string): DailyOutput[] {
	return body
		.split(";")
		.map((day) => day.trim())
		.filter((day) => day !== "")
		.map((day) => {
			const [date, generated] = day.split(",");
			return {
				date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
				generatedWh: generated === "NaN" ? null : Number(generated),
			};
		});
}

function addDays(date: string, days: number): string {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + days);
	return day.toISOString().slice(0, 10);
}
