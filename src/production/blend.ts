// Combines satellite irradiance, for times that have already happened, with
// the forecast for the rest. Kept free of imports so the backtest scripts can
// run it under Node too.

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
