// Combines satellite irradiance, for times that have already happened, with
// the forecast for the rest. Kept free of imports so the backtest scripts can
// run it under Node too.

// GXPs at least this big average five satellite pixels: their own and the
// next one over in each direction (about 5–6 km away), so the estimate reflects
// the area their rooftops spread over. Smaller GXPs use their own pixel, to
// save Open-Meteo calls. Open-Meteo's bounding_box would average a whole area,
// but it isn't supported for Himawari. The satellite grid is 0.05°, so smaller
// offsets can land two points in the same pixel.
export const MULTI_PIXEL_MIN_MW = 5;
const PIXEL_OFFSETS: [number, number][] = [
	[0, 0],
	[0.05, 0],
	[-0.05, 0],
	[0, 0.06],
	[0, -0.06],
];
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

// The mean of the pixels with a reading at each instant, or null if none has one.
export function averagePixels(pixels: (number | null)[][]): (number | null)[] {
	return pixels[0].map((_, i) => {
		const readings = pixels.map((pixel) => pixel[i]).filter((value): value is number => value !== null);
		return readings.length === 0 ? null : readings.reduce((sum, value) => sum + value, 0) / readings.length;
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
