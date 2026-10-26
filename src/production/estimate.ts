import { type Facing, planeOfArrayWm2, type Sky, type Sun, sunAt } from "./solar.ts";
import type { DayWeather } from "./weather";

// Each GXP's distributed solar is modelled in two parts. Rooftops are a mix
// of arrays facing the ways roofs do; farm-sized steps in its capacity (solar
// farms too small to be dispatched, like Rānui at Blenheim) are one array laid
// out for the sun. The rooftop constants are fitted to 53 NZ rooftop systems
// on PVOutput, August to October 2026. Solar is imported by its full name so
// the backtest scripts can run this under Node too.

export interface PanelArray {
	// Panels are typically sized above the registry capacity, which is the
	// lesser of a system's panels and inverter.
	dcToAc: number;
	// Soiling, wiring, mismatch, shading, ageing and the inverter, in full sun.
	efficiency: number;
	// How fast efficiency falls in dim light (see arrayOutputMw).
	lowLightLoss: number;
}

// Efficiency is fitted with this tilt maths, which puts about 2.5% more light
// on a panel than Open-Meteo's own tilted irradiance.
export const ROOFTOP: PanelArray = { dcToAc: 1.15, efficiency: 0.85, lowLightLoss: 0.08 };

// How PVOutput's NZ rooftop capacity faces: 61% north, 19% north-east or
// north-west and 20% east or west, at a median tilt of 22°.
export const ROOF_FACINGS: (Facing & { share: number })[] = [
	{ azimuthDeg: 0, tiltDeg: 20, share: 0.61 },
	{ azimuthDeg: 45, tiltDeg: 20, share: 0.095 },
	{ azimuthDeg: 315, tiltDeg: 20, share: 0.095 },
	{ azimuthDeg: 90, tiltDeg: 20, share: 0.1 },
	{ azimuthDeg: 270, tiltDeg: 20, share: 0.1 },
];

// A fixed farm facing north, with more panel per inverter than a house and
// central inverters that don't lose out in dim light. Rānui's 15-minute output
// fits this far better than the rooftop mix (r 0.987 against 0.971, 22–25
// October 2026), and fits no better at tilts from 20° to 30°.
export const FARM: PanelArray & Facing = {
	dcToAc: 1.3,
	efficiency: 0.88,
	lowLightLoss: 0,
	azimuthDeg: 0,
	tiltDeg: 25,
};

// Panels lose about 0.4% of their output per °C above 25 °C, and in sun run
// hotter than the air by about 0.03 °C per W/m² (NOCT 45 °C).
const TEMPERATURE_COEFFICIENT = -0.004;
const CELL_HEATING_C_PER_WM2 = 0.03;

// A GXP's distributed capacity, and how much of it is farm-sized steps.
export interface SolarCapacity {
	rooftopMw: number;
	farmMw: number;
}

export interface GxpCapacity {
	gxp: string;
	name: string;
	distributedMw: number;
	farmMw: number; // part of distributedMw
}

export interface GxpProduction extends GxpCapacity {
	// Output and weather at the moment asked about, or null for a whole past day.
	productionMw: number | null;
	irradianceWm2: number | null; // on the average rooftop panel
	temperatureC: number | null;
	profileMw: number[];
}

// One array's output for the irradiance on its panels. Dim light is
// converted less efficiently, and the satellite reads overcast a little
// bright: with the rooftop's loss of 0.08, efficiency falls by 6% at
// 500 W/m², 13% at 200 and 18% at 100. Without it, cloudy days came out 8%
// high against sunny ones.
export function arrayOutputMw(
	capacityMw: number,
	irradianceWm2: number,
	airTemperatureC: number,
	array: PanelArray,
): number {
	if (!(irradianceWm2 > 0)) return 0;
	const cellTemperatureC = airTemperatureC + irradianceWm2 * CELL_HEATING_C_PER_WM2;
	const dcMw =
		capacityMw *
		array.dcToAc *
		(irradianceWm2 / 1000) *
		array.efficiency *
		(1 + array.lowLightLoss * Math.log(irradianceWm2 / 1000)) *
		(1 + TEMPERATURE_COEFFICIENT * (cellTemperatureC - 25));
	// Inverters can't put out more than their rating.
	return Math.min(Math.max(dcMw, 0), capacityMw);
}

export function estimateOutputMw(capacity: SolarCapacity, sky: Sky, sun: Sun, airTemperatureC: number): number {
	let mw = 0;
	if (capacity.rooftopMw > 0) {
		// Each way roofs face has its own share of the inverters.
		for (const facing of ROOF_FACINGS) {
			const irradiance = planeOfArrayWm2(sky, sun, facing);
			mw += arrayOutputMw(capacity.rooftopMw * facing.share, irradiance, airTemperatureC, ROOFTOP);
		}
	}
	if (capacity.farmMw > 0) {
		mw += arrayOutputMw(capacity.farmMw, planeOfArrayWm2(sky, sun, FARM), airTemperatureC, FARM);
	}
	return mw;
}

// Irradiance on the average rooftop panel.
export function rooftopIrradianceWm2(sky: Sky, sun: Sun): number {
	return ROOF_FACINGS.reduce((total, facing) => total + facing.share * planeOfArrayWm2(sky, sun, facing), 0);
}

// Each GXP's output at every point in the day's weather, and at `at` if given.
export function estimateProduction(
	gxps: GxpCapacity[],
	weather: DayWeather,
	at: Date | null,
): GxpProduction[] {
	return gxps.map((gxp) => {
		const location = weather.locations[gxp.gxp];
		const capacity = { rooftopMw: gxp.distributedMw - gxp.farmMw, farmMw: gxp.farmMw };
		const profileMw = weather.times.map((time, i) => {
			const sky = { ghiWm2: location.ghiWm2[i], dniWm2: location.dniWm2[i], dhiWm2: location.dhiWm2[i] };
			const sun = sunAt(time, location.lat, location.long);
			return round(estimateOutputMw(capacity, sky, sun, location.temperatureC[i]));
		});
		if (!at) {
			return { ...gxp, productionMw: null, irradianceWm2: null, temperatureC: null, profileMw };
		}

		const valueNow = (values: number[]) => valueAt(weather.times, values, at.getTime());
		const sky = { ghiWm2: valueNow(location.ghiWm2), dniWm2: valueNow(location.dniWm2), dhiWm2: valueNow(location.dhiWm2) };
		const sun = sunAt(at.getTime(), location.lat, location.long);
		const temperatureNow = valueNow(location.temperatureC);
		return {
			...gxp,
			productionMw: round(estimateOutputMw(capacity, sky, sun, temperatureNow)),
			irradianceWm2: round(rooftopIrradianceWm2(sky, sun), 1),
			temperatureC: round(temperatureNow, 1),
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
