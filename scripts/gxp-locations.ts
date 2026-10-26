// Works out where each GXP's customers are, so its weather is taken there
// rather than at the substation, which can be well out of town.
//
//   npm run gxp-locations
//
// Each hexagon of Kontur's 400 m population grid goes to its nearest GXP with
// distributed solar: a stand-in for the real supply areas, which aren't
// published. Hexagons far from every GXP, on the Chathams, Kermadecs and
// subantarctic islands, are off the national grid and left out. For each GXP
// this writes the population-weighted centre and its
// most-populated satellite pixels (with their share of its people) to
// src/production/gxpLocations.json. Rerun it when GXPs change.
//
// Options: --api <url> for the GXP list (default http://localhost:8787, the
// dev server) and --kontur <file> for a local copy of the GeoPackage, which is
// downloaded otherwise.
//
// Population data: Kontur Population, 2023-11-01, CC BY 4.0.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

const KONTUR_URL =
	"https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_NZ_20231101.gpkg.gz";
const OUT = new URL("../src/production/gxpLocations.json", import.meta.url);
// Himawari's grid: population is binned into satellite pixels this size.
const PIXEL_DEGREES = 0.05;
// The most any GXP averages, matching the API's pixel budget.
const PIXELS_PER_GXP = 5;
// The main islands' most remote people (around Cape Reinga) are within 150 km
// of a GXP; the closest of the far-flung islands, the Aucklands, is 480 km
// from one.
const MAX_GXP_DISTANCE_KM = 200;
const EARTH_RADIUS_M = 6378137;
const KM_PER_DEGREE = (EARTH_RADIUS_M / 1000) * (Math.PI / 180);

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args.splice(index, 2)[1];
};
const apiUrl = option("api", "http://localhost:8787");
let konturPath = option("kontur", "");

if (!konturPath) {
	console.log("Downloading Kontur's NZ population grid…");
	const res = await fetch(KONTUR_URL);
	if (!res.ok) throw new Error(`Kontur download failed: ${res.status}`);
	konturPath = join(mkdtempSync(join(tmpdir(), "kontur-")), "kontur_population_NZ.gpkg");
	writeFileSync(konturPath, gunzipSync(Buffer.from(await res.arrayBuffer())));
}

// Hexagon centres, from the bounding box at the front of each GeoPackage
// geometry (in Web Mercator metres).
const hexagons: { lat: number; long: number; population: number }[] = [];
const db = new DatabaseSync(konturPath, { readOnly: true });
for (const row of db.prepare("SELECT geom, population FROM population").iterate()) {
	const geom = row.geom as Uint8Array;
	const flags = geom[3];
	if (((flags >> 1) & 7) !== 1) throw new Error("Expected each geometry to carry an xy bounding box");
	const view = new DataView(geom.buffer, geom.byteOffset, geom.byteLength);
	const [minX, maxX, minY, maxY] = [0, 1, 2, 3].map((i) => view.getFloat64(8 + i * 8, (flags & 1) === 1));
	const x = (minX + maxX) / 2;
	const y = (minY + maxY) / 2;
	const long = ((x / EARTH_RADIUS_M) * 180) / Math.PI;
	hexagons.push({
		lat: ((2 * Math.atan(Math.exp(y / EARTH_RADIUS_M)) - Math.PI / 2) * 180) / Math.PI,
		// East of 180° rather than −180°, so the Chathams aren't measured the
		// long way round the world.
		long: long < 0 ? long + 360 : long,
		population: row.population as number,
	});
}

const substations = (await (await fetch("https://api.electricitymap.frenchsta.gg/v1/substations")).json()) as {
	siteId: string;
	lat: number;
	long: number;
}[];
const capacity = (await (await fetch(`${apiUrl}/solar-capacity`)).json()) as { result: { gxps: { gxp: string }[] } };
const gxps = capacity.result.gxps
	.map(({ gxp }) => substations.find((substation) => substation.siteId === gxp))
	.filter((substation) => substation !== undefined);

const assigned = new Map<string, typeof hexagons>();
const offGrid = { hexagons: 0, population: 0 };
for (const hexagon of hexagons) {
	const scale = Math.cos((hexagon.lat * Math.PI) / 180);
	const km = (gxp: (typeof gxps)[number]) =>
		Math.hypot(gxp.lat - hexagon.lat, (gxp.long - hexagon.long) * scale) * KM_PER_DEGREE;
	const nearest = gxps.reduce((best, gxp) => (km(gxp) < km(best) ? gxp : best));
	if (km(nearest) > MAX_GXP_DISTANCE_KM) {
		offGrid.hexagons++;
		offGrid.population += hexagon.population;
		continue;
	}
	assigned.set(nearest.siteId, [...(assigned.get(nearest.siteId) ?? []), hexagon]);
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;
const locations: Record<string, { population: number; centre: number[]; pixels: number[][] }> = {};
for (const [gxp, members] of [...assigned].sort(([a], [b]) => a.localeCompare(b))) {
	const population = members.reduce((sum, h) => sum + h.population, 0);
	if (population === 0) continue;
	const pixels = new Map<string, { lat: number; long: number; population: number }>();
	for (const h of members) {
		const row = Math.floor(h.lat / PIXEL_DEGREES);
		const column = Math.floor(h.long / PIXEL_DEGREES);
		const pixel = pixels.get(`${row},${column}`) ?? { lat: (row + 0.5) * PIXEL_DEGREES, long: (column + 0.5) * PIXEL_DEGREES, population: 0 };
		pixel.population += h.population;
		pixels.set(`${row},${column}`, pixel);
	}
	locations[gxp] = {
		population: Math.round(population),
		centre: [
			round(members.reduce((sum, h) => sum + h.lat * h.population, 0) / population, 4),
			round(members.reduce((sum, h) => sum + h.long * h.population, 0) / population, 4),
		],
		// [lat, long, share of the GXP's people]
		pixels: [...pixels.values()]
			.sort((a, b) => b.population - a.population)
			.slice(0, PIXELS_PER_GXP)
			.map((pixel) => [round(pixel.lat, 4), round(pixel.long, 4), round(pixel.population / population, 3)]),
	};
}

// One GXP a line, so regenerating gives readable diffs.
const lines = Object.entries(locations).map(([gxp, location]) => `\t\t${JSON.stringify(gxp)}: ${JSON.stringify(location)}`);
writeFileSync(
	OUT,
	[
		"{",
		'\t"source": "Kontur Population 2023-11-01 (CC BY 4.0), 400 m hexagons each assigned to their nearest GXP",',
		'\t"gxps": {',
		lines.join(",\n"),
		"\t}",
		"}",
		"",
	].join("\n"),
);
console.log(`Wrote ${Object.keys(locations).length} GXPs (${hexagons.length} hexagons) to ${OUT.pathname}`);
console.log(`Left out ${offGrid.hexagons} hexagons (${Math.round(offGrid.population)} people) over ${MAX_GXP_DISTANCE_KM} km from any GXP`);
