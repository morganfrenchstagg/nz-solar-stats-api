import { type GxpLocation, weatherPoints, type WeatherPoints } from "./blend";
import gxpLocations from "./gxpLocations.json";

export const POPULATION_SOURCE = gxpLocations.source;

// Where to take a GXP's weather: where its customers are, from
// scripts/gxp-locations.ts, or its substation if it isn't in that table yet.
export function gxpWeatherPoints(
	gxp: string,
	substation: { lat: number; long: number },
	capacityMw: number,
): WeatherPoints {
	const locations: Record<string, GxpLocation> = gxpLocations.gxps;
	return weatherPoints(substation, locations[gxp], capacityMw);
}
