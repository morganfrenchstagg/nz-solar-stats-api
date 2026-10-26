// Backtests the production model against PVOutput systems' daily generation.
//
//   npm run backtest:pvoutput -- ISL
//   npm run backtest:pvoutput -- ISL --systems 12345,67890 --from 2026-08-27 --to 2026-10-25
//
// Needs PVOUTPUT_API_KEY and PVOUTPUT_SYSTEM_ID, e.g. in .env. Without
// --systems it searches for systems within --radius km of the GXP (default 25).
// Other people's systems need Donation mode on your PVOutput account; your own
// doesn't. --out <file> writes a CSV of system-days, and --weather
// satellite|forecast picks the irradiance (default satellite, as the API
// does). Dates default to the 60 days to yesterday; Open-Meteo only has
// forecast temperatures for about three months back.
//
// PVOutput records gross generation, so unlike EMI's exports the ratio here is
// a direct check on the model. Each system is modelled at its own location,
// with the capacity the registry would record for it: the lower of its panel
// and inverter ratings.
import { writeFileSync } from "node:fs";
import { PvOutput, PvOutputError, type SystemInfo } from "./pvoutput.ts";
import {
	clearnessIndex,
	correlation,
	fetchWeather,
	median,
	modelKwh,
	nzDate,
	nzMidnight,
	shiftDate,
	SKIES,
	skyOf,
	type WeatherSource,
} from "./shared.ts";

// Requests for one system: its details, then up to two of daily outputs.
const REQUESTS_PER_SYSTEM = 3;
const MIN_DAYS = 7;

interface SystemDay {
	date: string;
	actualKwh: number;
	modelKwh: number;
	clearness: number;
}

interface SystemResult {
	systemId: string;
	info: SystemInfo;
	distanceKm: number;
	nameplateKw: number;
	days: SystemDay[];
	ratio: number;
	dailyR: number;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args.splice(index, 2)[1];
};
const radiusKm = Number(option("radius", "25"));
const systemIds = option("systems", "");
const to = option("to", shiftDate(nzDate(Date.now()), -1));
const from = option("from", shiftDate(to, -59));
const outPath = option("out", "");
const weatherSource = option("weather", "satellite") as WeatherSource;
const [gxp] = args;
if (!gxp || !["satellite", "forecast"].includes(weatherSource)) {
	console.error(
		"Usage: npm run backtest:pvoutput -- <GXP> [--systems id,id] [--radius km] [--from date] [--to date] [--weather satellite|forecast] [--out file]",
	);
	process.exit(1);
}

const apiKey = process.env.PVOUTPUT_API_KEY;
const ownSystemId = process.env.PVOUTPUT_SYSTEM_ID;
if (!apiKey || !ownSystemId) {
	console.error(
		[
			"Set PVOUTPUT_API_KEY and PVOUTPUT_SYSTEM_ID, e.g. in .env (gitignored):",
			"",
			"  PVOUTPUT_API_KEY=...",
			"  PVOUTPUT_SYSTEM_ID=...",
			"",
			"Both are on your PVOutput Settings page: enable API Access, generate a key and note your System Id.",
			"Other people's systems also need Donation mode on your account.",
		].join("\n"),
	);
	process.exit(1);
}

const substations = (await (await fetch("https://api.electricitymap.frenchsta.gg/v1/substations")).json()) as {
	siteId: string;
	description: string;
	lat: number;
	long: number;
}[];
const site = substations.find((substation) => substation.siteId === gxp.toUpperCase());
if (!site) throw new Error(`No substation ${gxp}`);

const client = new PvOutput(apiKey, ownSystemId);
let candidates: string[];
if (systemIds) {
	candidates = systemIds.split(",").map((id) => id.trim());
} else {
	const found = await client.search(site.lat, site.long, radiusKm, 30);
	console.log(`${found.length} systems within ${radiusKm} km of ${site.description} reported in the last 30 days`);
	candidates = found.map((system) => system.systemId);
}

const results: SystemResult[] = [];
const skipped: string[] = [];
let donationRefused = false;
for (const systemId of candidates) {
	if (donationRefused && systemId !== ownSystemId) {
		skipped.push(`${systemId} (needs Donation mode)`);
		continue;
	}
	if (client.remaining !== null && client.remaining < REQUESTS_PER_SYSTEM) {
		skipped.push(`${systemId} and later (rate limit, resets ${client.resetsAt?.toLocaleTimeString("en-NZ") ?? "within the hour"})`);
		break;
	}
	try {
		const info = await client.system(systemId);
		const outputs = await client.outputs(systemId, from, to);
		const nameplateKw = Math.min(info.sizeW, info.inverterW ?? Infinity) / 1000;
		// A single system sits on one satellite pixel.
		const system = { lat: info.lat, long: info.long };
		const weather = await fetchWeather({ forecast: system, pixels: [{ ...system, weight: 1 }] }, from, to, { source: weatherSource });
		const days = outputs
			// A day with nothing generated is an outage or a missed upload, not weather.
			.filter((output) => output.generatedWh && output.date >= from && output.date <= to)
			.map((output) => ({
				date: output.date,
				actualKwh: output.generatedWh! / 1000,
				modelKwh: modelKwh(weather, nzMidnight(output.date), nzMidnight(shiftDate(output.date, 1)), nameplateKw / 1000),
				clearness: clearnessIndex(weather, output.date),
			}));
		if (days.length < MIN_DAYS) {
			skipped.push(`${systemId} (${days.length} days of output)`);
			continue;
		}
		results.push({
			systemId,
			info,
			distanceKm: distanceKm(site, info),
			nameplateKw,
			days,
			ratio: sum(days.map((d) => d.actualKwh)) / sum(days.map((d) => d.modelKwh)),
			dailyR: correlation(days.map((d) => d.actualKwh), days.map((d) => d.modelKwh)),
		});
		process.stdout.write(".");
	} catch (error) {
		if (error instanceof PvOutputError && error.needsDonationMode) {
			donationRefused = true;
			skipped.push(`${systemId} (needs Donation mode)`);
		} else if (error instanceof PvOutputError && error.rateLimited) {
			skipped.push(`${systemId} and later (rate limit)`);
			break;
		} else {
			skipped.push(`${systemId} (${(error as Error).message})`);
		}
	}
}
console.log();

if (results.length === 0) {
	console.log(`\nNo systems to compare. Skipped: ${skipped.join(", ") || "none found"}`);
	if (donationRefused) {
		console.log("PVOutput only shares other people's systems with Donation mode accounts; try --systems with your own id.");
	}
	process.exit(1);
}
report(results);
if (skipped.length > 0) console.log(`\nSkipped ${skipped.length}: ${skipped.join(", ")}`);
if (client.remaining !== null) console.log(`PVOutput requests left this hour: ${client.remaining}`);

if (outPath) {
	writeFileSync(
		outPath,
		[
			"system_id,name,date,nameplate_kw,orientation,tilt,actual_kwh,model_kwh,clearness,sky",
			...results.flatMap((r) =>
				r.days.map((d) =>
					[r.systemId, `"${r.info.name.replaceAll('"', "'")}"`, d.date, r.nameplateKw, r.info.orientation, r.info.tiltDegrees ?? "", d.actualKwh.toFixed(3), d.modelKwh.toFixed(3), d.clearness.toFixed(3), skyOf(d.clearness)].join(","),
				),
			),
		].join("\n") + "\n",
	);
	console.log(`Wrote ${sum(results.map((r) => r.days.length))} system-days to ${outPath}`);
}

function report(results: SystemResult[]) {
	console.log(`\n${results.length} systems near ${site!.description}, ${from} to ${to}`);
	console.log("system    name                  km  panels kW  inverter kW  orient  tilt  days  kWh/kW/day actual/model  ratio  daily r");
	for (const r of [...results].sort((a, b) => a.ratio - b.ratio)) {
		const perKwDay = (kwh: number[]) => sum(kwh) / r.nameplateKw / r.days.length;
		console.log(
			`${r.systemId.padEnd(8)}  ${r.info.name.slice(0, 20).padEnd(20)}  ${r.distanceKm.toFixed(0).padStart(2)}  ${(r.info.sizeW / 1000).toFixed(1).padStart(9)}  ${(r.info.inverterW === null ? "?" : (r.info.inverterW / 1000).toFixed(1)).padStart(11)}  ${r.info.orientation.padEnd(6)}  ${String(r.info.tiltDegrees ?? "?").padStart(4)}  ${String(r.days.length).padStart(4)}  ${perKwDay(r.days.map((d) => d.actualKwh)).toFixed(2).padStart(8)} / ${perKwDay(r.days.map((d) => d.modelKwh)).toFixed(2)}  ${r.ratio.toFixed(2).padStart(5)}  ${r.dailyR.toFixed(2).padStart(7)}`,
		);
	}

	const allDays = results.flatMap((r) => r.days);
	const ratios = results.map((r) => r.ratio).sort((a, b) => a - b);
	console.log(`\n  Actual / modelled    ${(sum(allDays.map((d) => d.actualKwh)) / sum(allDays.map((d) => d.modelKwh))).toFixed(2)} pooled; by system median ${median(ratios).toFixed(2)}, range ${ratios[0].toFixed(2)}–${ratios[ratios.length - 1].toFixed(2)}`);
	console.log(`  Daily correlation    median r = ${median(results.map((r) => r.dailyR)).toFixed(2)}`);

	const groups = new Map<string, SystemResult[]>();
	for (const r of results) {
		const group = r.info.orientation === "N" ? "north" : ["NE", "NW"].includes(r.info.orientation) ? "north-east/west" : ["E", "W", "EW"].includes(r.info.orientation) ? "east/west" : "other";
		groups.set(group, [...(groups.get(group) ?? []), r]);
	}
	console.log("\n  By orientation       systems  actual/modelled");
	for (const [group, members] of groups) {
		const days = members.flatMap((r) => r.days);
		console.log(`    ${group.padEnd(18)} ${String(members.length).padStart(7)}  ${(sum(days.map((d) => d.actualKwh)) / sum(days.map((d) => d.modelKwh))).toFixed(2).padStart(15)}`);
	}

	// Misses are after scaling each system by its own ratio, so they show the
	// weather's errors rather than the system's size or orientation.
	console.log("\n  By sky               system-days  actual/modelled  daily miss");
	for (const { name } of SKIES) {
		const days = results.flatMap((r) => r.days.filter((d) => skyOf(d.clearness) === name).map((d) => ({ ...d, scaled: d.modelKwh * r.ratio })));
		if (days.length === 0) continue;
		const actual = sum(days.map((d) => d.actualKwh));
		console.log(
			`    ${name.padEnd(18)} ${String(days.length).padStart(11)}  ${(actual / sum(days.map((d) => d.modelKwh))).toFixed(2).padStart(15)}  ${((sum(days.map((d) => Math.abs(d.actualKwh - d.scaled))) / actual) * 100).toFixed(0).padStart(9)}%`,
		);
	}
}

function sum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function distanceKm(a: { lat: number; long: number }, b: { lat: number; long: number }): number {
	const radians = (degrees: number) => (degrees * Math.PI) / 180;
	const h =
		Math.sin(radians(b.lat - a.lat) / 2) ** 2 +
		Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.long - a.long) / 2) ** 2;
	return 2 * 6371 * Math.asin(Math.sqrt(h));
}
