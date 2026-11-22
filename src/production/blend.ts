// Combines satellite irradiance, for times that have already happened, with
// the forecast for the rest. Solar is imported by its full name so the
// backtest scripts can run this under Node too.
import { sunAt } from "./solar.ts";

// GXPs at least this big average up to five satellite pixels, so the estimate
// reflects the area their rooftops spread over; smaller GXPs use one, to save
// Open-Meteo calls. Open-Meteo's bounding_box would average a whole area, but
// it isn't supported for Himawari.
export const MULTI_PIXEL_MIN_MW = 5;

export interface Pixel {
	lat: number;
	long: number;
	weight: number;
}

// Where a GXP's customers are, from scripts/gxp-locations.ts: its population
// centre and most-populated pixels as [lat, long, share of its people].
export interface GxpLocation {
	population: number;
	centre: number[];
	pixels: number[][];
}

export interface WeatherPoints {
	forecast: { lat: number; long: number };
	pixels: Pixel[];
}

// Where to take a GXP's weather: the forecast at its population centre, and
// the satellite at its most-populated pixels, weighted by population. Without
// a population location, at and around its substation.
export function weatherPoints(
	substation: { lat: number; long: number },
	location: GxpLocation | undefined,
	capacityMw: number,
): WeatherPoints {
	if (!location) {
		return {
			forecast: substation,
			pixels: pixelsAround(substation.lat, substation.long, capacityMw).map((pixel) => ({ ...pixel, weight: 1 })),
		};
	}
	const pixels = location.pixels.map(([lat, long, weight]) => ({ lat, long, weight }));
	return {
		forecast: { lat: location.centre[0], long: location.centre[1] },
		pixels: capacityMw >= MULTI_PIXEL_MIN_MW ? pixels : pixels.slice(0, 1),
	};
}

// Around a substation: its own pixel and the next one over in each direction
// (about 5–6 km away). The satellite grid is 0.05°, so smaller offsets can
// land two points in the same pixel.
const PIXEL_OFFSETS: [number, number][] = [
	[0, 0],
	[0.05, 0],
	[-0.05, 0],
	[0, 0.06],
	[0, -0.06],
];
// The estimate's steps: the satellite's own interval, so its readings are used
// as they are. The forecast is hourly underneath (Open-Meteo interpolates its
// 15-minute data outside Europe and North America) and is interpolated onto
// these steps too.
export const STEP_MS = 10 * 60 * 1000;

// Steps from the first of a forecast's evenly spaced times to the end of its
// last interval, e.g. an NZ day's 144.
export function stepsThrough(times: number[]): number[] {
	const end = times[times.length - 1] + (times[1] - times[0]);
	const steps: number[] = [];
	for (let time = times[0]; time < end; time += STEP_MS) steps.push(time);
	return steps;
}

// A time-sorted series' values at other time-sorted instants, by linear
// interpolation, holding the end values.
export function resample(times: number[], values: number[], at: number[]): number[] {
	let i = 1;
	return at.map((time) => {
		if (time <= times[0]) return values[0];
		while (i < times.length - 1 && times[i] < time) i++;
		if (time >= times[i]) return values[i];
		const share = (time - times[i - 1]) / (times[i] - times[i - 1]);
		return values[i - 1] + share * (values[i] - values[i - 1]);
	});
}

// After the latest satellite reading, how its cloudiness compares with the
// forecast fades away over this long, so the two don't jump apart.
export const BRIDGE_MS = 2 * 60 * 60 * 1000;
// Below this the forecast is too dim to compare the satellite against.
const MIN_BRIDGE_FORECAST_WM2 = 50;
const MAX_BRIDGE_RATIO = 1.5;

export function pixelsAround(lat: number, long: number, capacityMw: number): { lat: number; long: number }[] {
	const offsets = capacityMw >= MULTI_PIXEL_MIN_MW ? PIXEL_OFFSETS : PIXEL_OFFSETS.slice(0, 1);
	return offsets.map(([dLat, dLong]) => ({ lat: lat + dLat, long: long + dLong }));
}

// The weighted mean of the pixels with a reading at each instant, or null if
// none has one. Two points in the same pixel just give it both their weights.
export function averagePixels(
	pixels: (number | null)[][],
	weights: number[] = pixels.map(() => 1),
): (number | null)[] {
	return pixels[0].map((_, i) => {
		let total = 0;
		let weight = 0;
		pixels.forEach((pixel, j) => {
			if (pixel[i] === null) return;
			total += pixel[i]! * weights[j];
			weight += weights[j];
		});
		return weight === 0 ? null : total / weight;
	});
}

// Once the sun is well up, the satellite reads cloud too dark and clear sky a
// little bright. This is the output of the six dispatched solar farms with
// fixed panels over the model's, the year to November 2026, by how clear the
// satellite had it (its reading as a share of the sunlight above the
// atmosphere, down the side) and how high the sun was (across). Each reading
// is scaled by the entry for it, read off between the nearest four. Rooftops
// bear it out: scaled, the 5-minute load at 15 rooftop-heavy GXPs fitted
// better in spring at 13 and no differently in the other seasons, and 47
// rooftop systems on PVOutput went from 7% over the model on cloudy days and
// 3% under on sunny ones (late October to mid November 2026) to 4% and 2%.
const SKY_CLEARNESS = [0.14, 0.29, 0.43, 0.58, 0.73];
const SKY_ELEVATIONS_DEG = [40, 50, 64];
export const SKY_FACTORS = [
	[1.05, 1.02, 0.95],
	[1.11, 1.1, 1.05],
	[1.07, 1.07, 1.02],
	[1.03, 1.01, 0.97],
	[1.03, 0.99, 0.94],
];
// With the sun lower the farms fall short too, but that's their rows shading
// each other and the sun's angle on their panels, not the sky: scaling
// rooftops by it made all 15 GXPs' load fit worse in autumn and winter. So
// the factors fade in over the 10° below the table's first column.
const SKY_FADE_FROM_DEG = 30;
const RADIANS = Math.PI / 180;

// What to scale a location's satellite readings by at each instant, all three
// components alike, from its global horizontal readings (see SKY_FACTORS).
export function skyFactors(times: number[], ghiWm2: (number | null)[], lat: number, long: number): number[] {
	return times.map((time, i) => {
		const ghi = ghiWm2[i];
		if (ghi === null || ghi <= 0) return 1;
		const sun = sunAt(time, lat, long);
		if (sun.elevationDeg <= SKY_FADE_FROM_DEG) return 1;

		const clearness = ghi / (sun.extraterrestrialWm2 * Math.sin(sun.elevationDeg * RADIANS));
		const [row, down] = between(SKY_CLEARNESS, clearness);
		const [column, across] = between(SKY_ELEVATIONS_DEG, sun.elevationDeg);
		const factor =
			SKY_FACTORS[row][column] * (1 - down) * (1 - across) +
			SKY_FACTORS[row + 1][column] * down * (1 - across) +
			SKY_FACTORS[row][column + 1] * (1 - down) * across +
			SKY_FACTORS[row + 1][column + 1] * down * across;
		const fade = Math.min((sun.elevationDeg - SKY_FADE_FROM_DEG) / (SKY_ELEVATIONS_DEG[0] - SKY_FADE_FROM_DEG), 1);
		return 1 + fade * (factor - 1);
	});
}

// Where a value falls among ascending nodes: the node at or below it and how
// far it is to the next, holding the ends.
function between(nodes: number[], value: number): [number, number] {
	const held = Math.min(Math.max(value, nodes[0]), nodes[nodes.length - 1]);
	let index = 0;
	while (index < nodes.length - 2 && held > nodes[index + 1]) index++;
	return [index, (held - nodes[index]) / (nodes[index + 1] - nodes[index])];
}

// How far either side of a reading the readings it's averaged with reach,
// each counting less the further away it is (with 10-minute readings, the
// two nearest on each side count 2/3 and 1/3). A GXP's rooftops spread over
// a district, so its output changes more gently than the cloud over a few
// pixels. Against 5-minute grid load at the 25 GXPs where solar is biggest,
// January to September 2026, 18% of the raw estimate's 10-minute swings
// showed up; smoothed, 59% do, and the fit improved at all 25.
export const SMOOTHING_MS = 30 * 60 * 1000;

// Each reading averaged with its neighbours (see SMOOTHING_MS). A missing
// reading stays missing, so the latest is only averaged with those before it.
export function smoothReadings(times: number[], readings: (number | null)[]): (number | null)[] {
	return readings.map((reading, i) => {
		if (reading === null) return null;
		let total = 0;
		let weight = 0;
		for (const step of [-1, 1]) {
			for (let j = step === -1 ? i : i + 1; j >= 0 && j < readings.length; j += step) {
				// In whole milliseconds, so steady readings stay exact.
				const share = SMOOTHING_MS - Math.abs(times[j] - times[i]);
				if (share <= 0) break;
				if (readings[j] === null) continue;
				total += share * readings[j]!;
				weight += share;
			}
		}
		return total / weight;
	});
}

// Irradiance at each forecast instant: the satellite's up to its latest
// reading (bridging any gaps), then the forecast.
export function blendIrradiance(
	satelliteTimes: number[],
	satellite: (number | null)[],
	forecastTimes: number[],
	forecast: number[],
): { irradianceWm2: number[]; observedUntil: number | null } {
	const observed = satelliteTimes
		.map((time, i) => [time, satellite[i]] as const)
		.filter((point): point is readonly [number, number] => point[1] !== null);
	if (observed.length === 0) return { irradianceWm2: forecast, observedUntil: null };

	const last = observed[observed.length - 1][0];
	const forecastPoints = forecastTimes.map((time, i) => [time, forecast[i]] as const);
	const lastForecast = interpolate(forecastPoints, last);
	const ratio =
		lastForecast >= MIN_BRIDGE_FORECAST_WM2
			? Math.min(interpolate(observed, last) / lastForecast, MAX_BRIDGE_RATIO)
			: 1;
	return {
		irradianceWm2: forecastTimes.map((time, i) => {
			if (time <= last) return interpolate(observed, time);
			const faded = Math.min((time - last) / BRIDGE_MS, 1);
			return forecast[i] * (ratio + (1 - ratio) * faded);
		}),
		observedUntil: last,
	};
}

// Linear interpolation through time-sorted points, holding the end values.
function interpolate(points: readonly (readonly [number, number])[], time: number): number {
	if (time <= points[0][0]) return points[0][1];
	for (let i = 1; i < points.length; i++) {
		const [t1, v1] = points[i];
		if (time <= t1) {
			const [t0, v0] = points[i - 1];
			return v0 + ((v1 - v0) * (time - t0)) / (t1 - t0);
		}
	}
	return points[points.length - 1][1];
}
