import type { DayWeather } from "./weather";

// A first-cut model, not yet backtested. Each GXP's rooftop solar is treated
// as one array facing north at a typical roof pitch; real roofs face every
// way, which flattens the day's curve and lowers its peak.
export const PANEL_TILT_DEGREES = 20;
export const PANEL_AZIMUTH_DEGREES = 180; // Open-Meteo: 0° is south, ±180° north
// Registry capacity is usually the inverter's rating; panels are typically
// sized above it.
const DC_TO_AC_RATIO = 1.2;
// Soiling, wiring, mismatch, shading and ageing (PVWatts' 14% default), then a
// 96% efficient inverter.
const SYSTEM_EFFICIENCY = 0.83;
// Panels lose about 0.4% of their output per °C above 25 °C, and in sun run
// hotter than the air by about 0.03 °C per W/m² (NOCT 45 °C).
const TEMPERATURE_COEFFICIENT = -0.004;
const CELL_HEATING_C_PER_WM2 = 0.03;

export interface GxpCapacity {
	gxp: string;
	name: string;
	distributedMw: number;
}

export interface GxpProduction extends GxpCapacity {
	// Output and weather at the moment asked about, or null for a whole past day.
	productionMw: number | null;
	irradianceWm2: number | null;
	temperatureC: number | null;
	profileMw: number[];
}

export function estimateOutputMw(
	capacityMw: number,
	irradianceWm2: number,
	airTemperatureC: number,
): number {
	const cellTemperatureC = airTemperatureC + irradianceWm2 * CELL_HEATING_C_PER_WM2;
	const dcMw =
		capacityMw *
		DC_TO_AC_RATIO *
		(irradianceWm2 / 1000) *
		SYSTEM_EFFICIENCY *
		(1 + TEMPERATURE_COEFFICIENT * (cellTemperatureC - 25));
	// Inverters can't put out more than their rating.
	return Math.min(Math.max(dcMw, 0), capacityMw);
}

// Each GXP's output at every point in the day's weather, and at `at` if given.
export function estimateProduction(
	gxps: GxpCapacity[],
	weather: DayWeather,
	at: Date | null,
): GxpProduction[] {
	return gxps.map((gxp) => {
		const { irradianceWm2, temperatureC } = weather.locations[gxp.gxp];
		const profileMw = irradianceWm2.map((irradiance, index) =>
			round(estimateOutputMw(gxp.distributedMw, irradiance, temperatureC[index])),
		);
		if (!at) {
			return { ...gxp, productionMw: null, irradianceWm2: null, temperatureC: null, profileMw };
		}

		const irradianceAt = valueAt(weather.times, irradianceWm2, at.getTime());
		const temperatureAt = valueAt(weather.times, temperatureC, at.getTime());
		return {
			...gxp,
			productionMw: round(estimateOutputMw(gxp.distributedMw, irradianceAt, temperatureAt)),
			irradianceWm2: round(irradianceAt, 1),
			temperatureC: round(temperatureAt, 1),
			profileMw,
		};
	});
}

// Linearly interpolates a forecast between the instants either side of `at`.
function valueAt(times: number[], values: number[], at: number): number {
	if (at <= times[0]) return values[0];
	for (let index = 1; index < times.length; index++) {
		if (at <= times[index]) {
			const share = (at - times[index - 1]) / (times[index] - times[index - 1]);
			return values[index - 1] + share * (values[index] - values[index - 1]);
		}
	}
	return values[values.length - 1];
}

export function round(value: number, digits = 3): number {
	const scale = 10 ** digits;
	return Math.round(value * scale) / scale;
}
