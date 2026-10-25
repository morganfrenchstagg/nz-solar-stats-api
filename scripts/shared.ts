// Helpers shared by the backtest scripts.
import {
	estimateOutputMw,
	PANEL_AZIMUTH_DEGREES,
	PANEL_TILT_DEGREES,
} from "../src/production/estimate.ts";

export const QUARTER_HOUR_MS = 15 * 60 * 1000;

// Days are classed by their clearness index: the share of top-of-atmosphere
// sunlight that reached the ground.
export const SKIES = [
	{ name: "cloudy", below: 0.4 },
	{ name: "partly cloudy", below: 0.6 },
	{ name: "sunny", below: Infinity },
];

export function skyOf(clearness: number): string {
	return SKIES.find((sky) => clearness < sky.below)!.name;
}

export interface Instant {
	irradianceWm2: number; // on the model's panel
	temperatureC: number;
	groundWm2: number; // horizontal
	topOfAtmosphereWm2: number;
}

export type Weather = Map<number, Instant>; // keyed by epoch ms

// 15-minute weather at a location from Open-Meteo, using the same variables
// the API does, a day either side of the range so every period has both ends.
export async function fetchWeather(lat: number, long: number, from: string, to: string): Promise<Weather> {
	const params = new URLSearchParams({
		latitude: lat.toFixed(4),
		longitude: long.toFixed(4),
		minutely_15:
			"global_tilted_irradiance_instant,temperature_2m,shortwave_radiation_instant,terrestrial_radiation_instant",
		tilt: String(PANEL_TILT_DEGREES),
		azimuth: String(PANEL_AZIMUTH_DEGREES),
		timezone: "Pacific/Auckland",
		start_date: shiftDate(from, -1),
		end_date: shiftDate(to, 1),
		timeformat: "unixtime",
	});
	// Open-Meteo sometimes sends a past day as all nulls, then has it moments later.
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
		const body = (await res.json()) as {
			reason?: string;
			minutely_15: Record<
				"global_tilted_irradiance_instant" | "temperature_2m" | "shortwave_radiation_instant" | "terrestrial_radiation_instant",
				(number | null)[]
			> & { time: number[] };
		};
		if (!res.ok) throw new Error(`Open-Meteo: ${body.reason ?? res.status}`);

		const { time, ...series } = body.minutely_15;
		if (Object.values(series).some((values) => values.includes(null))) {
			if (attempt === 4) throw new Error("Open-Meteo kept sending gaps; try again later");
			await new Promise((resolve) => setTimeout(resolve, 10_000));
			continue;
		}
		const weather: Weather = new Map();
		time.forEach((seconds, i) => {
			weather.set(seconds * 1000, {
				irradianceWm2: series.global_tilted_irradiance_instant[i]!,
				temperatureC: series.temperature_2m[i]!,
				groundWm2: series.shortwave_radiation_instant[i]!,
				topOfAtmosphereWm2: series.terrestrial_radiation_instant[i]!,
			});
		});
		return weather;
	}
}

function instantAt(weather: Weather, time: number): Instant {
	const instant = weather.get(time);
	if (!instant) throw new Error(`No weather at ${new Date(time).toISOString()}`);
	return instant;
}

// The model's energy between two quarter-hour instants, in kWh, by the
// trapezoid rule over the 15-minute weather.
export function modelKwh(weather: Weather, start: number, end: number, capacityMw: number): number {
	let kwh = 0;
	for (let time = start; time < end; time += QUARTER_HOUR_MS) {
		const [from, to] = [time, time + QUARTER_HOUR_MS].map((t) => {
			const { irradianceWm2, temperatureC } = instantAt(weather, t);
			return estimateOutputMw(capacityMw, irradianceWm2, temperatureC);
		});
		kwh += ((from + to) / 2) * 1000 * 0.25;
	}
	return kwh;
}

export function clearnessIndex(weather: Weather, date: string): number {
	let ground = 0;
	let topOfAtmosphere = 0;
	for (let time = nzMidnight(date); time < nzMidnight(shiftDate(date, 1)); time += QUARTER_HOUR_MS) {
		ground += instantAt(weather, time).groundWm2;
		topOfAtmosphere += instantAt(weather, time).topOfAtmosphereWm2;
	}
	return ground / topOfAtmosphere;
}

// The UTC instant of midnight at the start of an NZ date. Daylight saving
// changes at 2–3am, so the offset an hour either side of midnight is right.
export function nzMidnight(date: string): number {
	const utcMidnight = Date.parse(`${date}T00:00:00Z`);
	const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Pacific/Auckland", timeZoneName: "longOffset" })
		.formatToParts(utcMidnight - 12 * 60 * 60 * 1000)
		.find((part) => part.type === "timeZoneName")!
		.value.match(/GMT([+-])(\d{2}):(\d{2})/)!;
	const offsetMs = (Number(offset[2]) * 60 + Number(offset[3])) * 60 * 1000 * (offset[1] === "-" ? -1 : 1);
	return utcMidnight - offsetMs;
}

export function nzDate(instant: number): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Auckland" }).format(instant);
}

export function shiftDate(date: string, days: number): string {
	const day = new Date(`${date}T00:00:00Z`);
	day.setUTCDate(day.getUTCDate() + days);
	return day.toISOString().slice(0, 10);
}

export function mean(values: number[]): number {
	return values.reduce((total, value) => total + value, 0) / values.length;
}

export function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

export function stdDev(values: number[]): number {
	const average = mean(values);
	return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

export function correlation(xs: number[], ys: number[]): number {
	const mx = mean(xs);
	const my = mean(ys);
	let covariance = 0;
	let vx = 0;
	let vy = 0;
	xs.forEach((x, i) => {
		covariance += (x - mx) * (ys[i] - my);
		vx += (x - mx) ** 2;
		vy += (ys[i] - my) ** 2;
	});
	return covariance / Math.sqrt(vx * vy);
}
