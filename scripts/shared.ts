// Helpers shared by the backtest scripts.
import {
	averagePixels,
	blendIrradiance,
	resample,
	STEP_MS,
	stepsThrough,
	type WeatherPoints,
} from "../src/production/blend.ts";
import { estimateOutputMw, type SolarCapacity } from "../src/production/estimate.ts";
import { type Sky, type Sun, sunAt } from "../src/production/solar.ts";

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
	sky: Sky;
	sun: Sun;
	temperatureC: number;
	topOfAtmosphereWm2: number; // on flat ground
}

export type Weather = Map<number, Instant>; // keyed by epoch ms

// "satellite" is what the API does: Himawari readings for times that have
// passed, the forecast after. "forecast" is the forecast alone, for comparison.
export type WeatherSource = "satellite" | "forecast";

type Series = Record<string, (number | null)[]> & { time: number[] };

// Weather every 10 minutes (STEP_MS) for a GXP or site, a day either side of
// the range so every period has both ends: the forecast (and always the
// temperature) at `points.forecast`, and satellite readings averaged over
// `points.pixels` by their weights, as the API does.
export async function fetchWeather(
	points: WeatherPoints,
	from: string,
	to: string,
	{ source = "satellite" }: { source?: WeatherSource } = {},
): Promise<Weather> {
	const range = {
		timezone: "Pacific/Auckland",
		start_date: shiftDate(from, -1),
		end_date: shiftDate(to, 1),
		timeformat: "unixtime",
	};
	const [forecast] = await getSeries("https://api.open-meteo.com/v1/forecast", "minutely_15", [points.forecast], {
		minutely_15: [...SKY_VARIABLES, "temperature_2m", "terrestrial_radiation_instant"].join(","),
		...range,
	});
	const forecastTimes = forecast.time.map((seconds) => seconds * 1000);
	const times = stepsThrough(forecastTimes);
	const onSteps = (variable: string) => resample(forecastTimes, forecast[variable] as number[], times);
	let [ghi, dni, dhi] = SKY_VARIABLES.map(onSteps);
	const [temperature, topOfAtmosphere] = ["temperature_2m", "terrestrial_radiation_instant"].map(onSteps);

	if (source === "satellite") {
		const pixels = await getSeries("https://satellite-api.open-meteo.com/v1/archive", "hourly", points.pixels, {
			hourly: SKY_VARIABLES.join(","),
			temporal_resolution: "native",
			models: "jma_jaxa_himawari",
			...range,
			// The satellite archive takes no date after today's in UTC, which
			// until midday in NZ is still yesterday.
			end_date: [range.end_date, new Date().toISOString().slice(0, 10)].sort()[0],
		});
		const satelliteTimes = pixels[0].time.map((seconds) => seconds * 1000);
		const blend = (variable: string, fallback: number[]) =>
			blendIrradiance(
				satelliteTimes,
				averagePixels(
					pixels.map((pixel) => pixel[variable]),
					points.pixels.map((pixel) => pixel.weight),
				),
				times,
				fallback,
			).irradianceWm2;
		[ghi, dni, dhi] = [blend(SKY_VARIABLES[0], ghi), blend(SKY_VARIABLES[1], dni), blend(SKY_VARIABLES[2], dhi)];
	}

	const weather: Weather = new Map();
	times.forEach((time, i) => {
		weather.set(time, {
			sky: { ghiWm2: ghi[i], dniWm2: dni[i], dhiWm2: dhi[i] },
			sun: sunAt(time, points.forecast.lat, points.forecast.long),
			temperatureC: temperature[i],
			topOfAtmosphereWm2: topOfAtmosphere[i],
		});
	});
	return weather;
}

// Global horizontal, direct normal and diffuse horizontal, as the API fetches them.
const SKY_VARIABLES = [
	"shortwave_radiation_instant",
	"direct_normal_irradiance_instant",
	"diffuse_radiation_instant",
] as const;

// One series per point. Open-Meteo sometimes sends a past day as all nulls,
// then has it moments later, so a mostly-null response is retried. The
// satellite's occasional missing reading is fine: the blend bridges it.
async function getSeries(
	url: string,
	key: "minutely_15" | "hourly",
	points: { lat: number; long: number }[],
	params: Record<string, string>,
): Promise<Series[]> {
	const query = new URLSearchParams({
		latitude: points.map((point) => point.lat.toFixed(4)).join(","),
		longitude: points.map((point) => point.long.toFixed(4)).join(","),
		...params,
	});
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`${url}?${query}`);
		const body = (await res.json()) as { reason?: string } & Record<string, Series>;
		if (!res.ok) throw new Error(`Open-Meteo: ${body.reason ?? res.status}`);

		const series = (Array.isArray(body) ? body : [body]).map((point) => point[key] as Series);
		const values = series.flatMap(({ time, ...rest }) => Object.values(rest).flat());
		const missing = values.filter((value) => value === null).length / values.length;
		// The forecast should have no gaps at all.
		if (missing <= (key === "minutely_15" ? 0 : 0.5)) return series;
		if (attempt === 4) throw new Error("Open-Meteo kept sending gaps; try again later");
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
}

function instantAt(weather: Weather, time: number): Instant {
	const instant = weather.get(time);
	if (!instant) throw new Error(`No weather at ${new Date(time).toISOString()}`);
	return instant;
}

// The model's energy between two 10-minute instants, in kWh, by the
// trapezoid rule over the weather's steps.
export function modelKwh(weather: Weather, start: number, end: number, capacity: SolarCapacity): number {
	let kwh = 0;
	for (let time = start; time < end; time += STEP_MS) {
		const [from, to] = [time, time + STEP_MS].map((t) => {
			const { sky, sun, temperatureC } = instantAt(weather, t);
			return estimateOutputMw(capacity, sky, sun, temperatureC);
		});
		kwh += ((from + to) / 2) * 1000 * (STEP_MS / 3_600_000);
	}
	return kwh;
}

export function clearnessIndex(weather: Weather, date: string): number {
	let ground = 0;
	let topOfAtmosphere = 0;
	for (let time = nzMidnight(date); time < nzMidnight(shiftDate(date, 1)); time += STEP_MS) {
		ground += instantAt(weather, time).sky.ghiWm2;
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
