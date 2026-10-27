import gxpLocations from "../production/gxpLocations.json";
import { type GxpCapacityMonth, gxpCapacities, productionEstimate, weatherLocation } from "../production/job";
import { blendWeather, CACHE_FORMAT, type Forecast, type SatelliteDay } from "../production/weather";
import { dailyEnergy } from "./energy";
import { addMonths, monthBounds } from "./periods";

// Bumped for a change to how days are estimated that the reference day can't
// show, such as fetching weather differently. Anything that changes the
// reference day, from the model's constants to how capacity grows and how
// days add up, changes the fingerprint by itself.
export const MODEL_REVISION = 1;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const REFERENCE_DATE = "2026-01-15";
// Midnight starting it, in NZ daylight time.
const REFERENCE_MIDNIGHT = Date.parse(`${REFERENCE_DATE}T00:00:00+13:00`);

// Identifies how days are estimated. Every stored day records the
// fingerprint it was estimated with, and is estimated again once it's
// different, so a deployed change to the model recalculates every day. Where
// each GXP's weather is taken is part of it too, so a rebuilt
// gxpLocations.json rechecks every day's weather (see weatherTakenAtPoints).
export async function modelFingerprint(): Promise<string> {
	return hash([MODEL_REVISION, CACHE_FORMAT, gxpLocations, referenceDay()]);
}

// A made-up summer's day, estimated and added up as a real one is: at a big
// GXP with a farm-sized step (Islington, so its weather is from five
// satellite pixels) and a small one (Blenheim, one pixel), under passing
// cloud, with the satellite missing a reading at noon and those after 6pm.
export function referenceDay() {
	// December 2024 to December 2025.
	const months: GxpCapacityMonth[] = Array.from({ length: 13 }, (_, i) => {
		const { to: monthEnd } = monthBounds(addMonths("2024-12-01", i).slice(0, 7));
		return [
			{ gxp: "ISL", name: "Islington", lat: -43.5, long: 172.5, monthEnd, distributedMw: 50 + 0.8 * i + (i >= 6 ? 5 : 0), stepMw: i === 6 ? 5 : 0 },
			{ gxp: "BLN", name: "Blenheim", lat: -41.5, long: 173.96, monthEnd, distributedMw: 3 + 0.05 * i, stepMw: 0 },
		];
	})
		.flat()
		.sort((a, b) => a.gxp.localeCompare(b.gxp) || a.monthEnd.localeCompare(b.monthEnd));
	const capacity = gxpCapacities(months, new Map([["ISL", 5]]), REFERENCE_DATE);
	const locations = capacity.gxps.map(weatherLocation);

	const hours = Array.from({ length: 24 }, (_, hour) => REFERENCE_MIDNIGHT + hour * HOUR_MS);
	const daylight = (time: number) => Math.max(0, Math.sin((Math.PI * ((time - REFERENCE_MIDNIGHT) / HOUR_MS - 5.5)) / 15));
	const forecast: Forecast = {
		format: CACHE_FORMAT,
		date: REFERENCE_DATE,
		fetchedAt: new Date(0).toISOString(),
		times: hours,
		locations: Object.fromEntries(
			locations.map(({ id, forecast: point }) => [
				id,
				{
					...point,
					temperatureC: hours.map((time) => 12 + 10 * daylight(time)),
					ghiWm2: hours.map((time) => 1000 * daylight(time)),
					dniWm2: hours.map((time) => 850 * daylight(time)),
					dhiWm2: hours.map((time) => 150 * daylight(time)),
				},
			]),
		),
		points: {},
	};

	const steps = Array.from({ length: 144 }, (_, i) => REFERENCE_MIDNIGHT + i * 10 * MINUTE_MS);
	const cloud = (i: number) => 0.55 + 0.45 * Math.cos(i / 5);
	const reading = (i: number, wm2: number) => (i === 72 || i >= 108 ? null : wm2);
	const satellite: SatelliteDay = {
		format: CACHE_FORMAT,
		date: REFERENCE_DATE,
		fetchedAt: new Date(0).toISOString(),
		times: steps,
		locations: Object.fromEntries(
			locations.map(({ id }) => [
				id,
				{
					ghiWm2: steps.map((time, i) => reading(i, 1000 * daylight(time) * cloud(i))),
					dniWm2: steps.map((time, i) => reading(i, 850 * daylight(time) * cloud(i) ** 2)),
					dhiWm2: steps.map((time, i) => reading(i, 150 * daylight(time) * (2 - cloud(i)))),
				},
			]),
		),
		pixels: {},
	};

	const estimate = productionEstimate(REFERENCE_DATE, capacity, blendWeather(forecast, satellite, locations), null, new Date(0));
	return { locations, estimate, energy: dailyEnergy(estimate) };
}

// Short enough to store against every day.
export async function hash(value: unknown): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
	return [...new Uint8Array(digest)]
		.slice(0, 12)
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
