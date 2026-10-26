// Backtests the production model against metered solar exports in EMI's
// embedded generation dataset.
//
//   npm run backtest -- MHO0331 202608_Embedded_generation.csv 202609_Embedded_generation.csv
//   npm run backtest -- all 202608_Embedded_generation.csv 202609_Embedded_generation.csv
//   npm run backtest -- farms 202608_Embedded_generation.csv 202609_Embedded_generation.csv
//
// The first argument is a POC, a GXP (every POC starting with it), "all" to
// compare every GXP with solar exports, or "farms" for the dispatched solar
// farms in the files. Options: --api <url> for capacities (default
// http://localhost:8787, the dev server), --weather satellite|forecast
// (default satellite, as the API does), --capacity growth|snapshot (default
// growth: the latest month-end snapshot plus recent growth, as the API does;
// snapshot leaves out the growth) and --out <file> for a CSV of half-hours
// (one GXP) or of GXP results ("all").
//
// Metered injection is what ICPs export after using their own solar, so it
// sits below the model's gross generation. The shape and the day-to-day swings
// are the fair test; the overall ratio is roughly the share exported. Farms
// export everything they generate, so they test the model's level directly.
import { readFileSync, writeFileSync } from "node:fs";
import { type GxpLocation, weatherPoints, type WeatherPoints } from "../src/production/blend.ts";
import { capacityAt, type CapacityMonth } from "../src/production/capacity.ts";
import type { SolarCapacity } from "../src/production/estimate.ts";
import gxpLocations from "../src/production/gxpLocations.json" with { type: "json" };
import {
	clearnessIndex,
	correlation,
	fetchWeather,
	median,
	modelKwh,
	nzMidnight,
	SKIES,
	skyOf,
	stdDev,
	type WeatherSource,
} from "./shared.ts";

const HALF_HOUR_MS = 30 * 60 * 1000;
// Retailers exporting more than this share of their energy at night aren't
// selling solar (e.g. KING's Mangahao hydro at MHO0331).
const MAX_SOLAR_NIGHT_SHARE = 0.05;
// Below this, a GXP's exports are too small to say much ("all" only).
const MIN_EXPORT_MWH = 5;
// Solar farms dispatched by the System Operator, by their series in the
// embedded generation files. Kōwhai Park (ISL0661, CTCT) is left out while
// it's still commissioning.
const FARMS = [
	{ poc: "ASB0661", retailer: "GENE", unit: "Lauriston" },
	{ poc: "EDG0331", retailer: "LODE", unit: "Rangitaiki" },
	{ poc: "EDG0331", retailer: "AQNZ", unit: "Omeheu" },
	{ poc: "KOE1101", retailer: "LODE", unit: "Kohirā" },
	{ poc: "KOE1101", retailer: "AQNZ", unit: "Pukenui" },
	{ poc: "MTO0331", retailer: "NPGL", unit: "Te Puna Mauri ō Omaru" },
];

type Days = Map<string, number[]>; // trading date → kWh per trading period

interface HalfHour {
	tradingDate: string;
	period: number;
	start: number; // epoch ms
	observedKwh: number;
	modelKwh: number;
	capacityMw: number;
}

interface Result {
	target: string;
	name: string;
	halfHours: HalfHour[];
	capacityMw: number;
	kwPerIcp: number | null;
	observedMwh: number;
	modelMwh: number;
	share: number;
	dailyShareSpread: number;
	dailyR: number;
	halfHourR: number;
	shapeError: number;
	peaks: { observed: string; model: string };
	// Energy-weighted middle of the day, NZ clock time: unlike the peak, not
	// thrown by flat tops when output hits an inverter limit.
	centres: { observed: string; model: string };
	profile: [string, number, number][]; // NZ clock time, observed and modelled share of energy
	skies: Sky[];
}

interface Sky {
	name: string;
	days: number;
	clearness: [number, number]; // lowest and highest daily clearness index
	observedMwh: number;
	share: number;
	// Misses once the model is scaled by the overall share, as a share of observed energy.
	dailyError: number;
	halfHourError: number;
	halfHourR: number;
}

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args.splice(index, 2)[1];
};
const apiUrl = option("api", "http://localhost:8787");
const outPath = option("out", "");
const weatherSource = option("weather", "satellite") as WeatherSource;
const capacityMethod = option("capacity", "growth");
const [target, ...files] = args;
if (
	!target ||
	files.length === 0 ||
	!["satellite", "forecast"].includes(weatherSource) ||
	!["growth", "snapshot"].includes(capacityMethod)
) {
	console.error(
		"Usage: npm run backtest -- <POC | GXP | all | farms> <embedded generation CSV>... [--api url] [--weather satellite|forecast] [--capacity growth|snapshot] [--out file]",
	);
	process.exit(1);
}
console.log(`Weather: ${weatherSource === "satellite" ? "satellite readings (as the API uses them)" : "forecast only"}`);
console.log(
	`Capacity: ${capacityMethod === "growth" ? "latest month-end snapshot plus recent growth (as the API does)" : "latest month-end snapshot"}`,
);

// Injected kWh by POC and retailer.
const injections = new Map<string, Map<string, Days>>();
for (const file of files) {
	const [header, ...lines] = readFileSync(file, "utf8").trim().split(/\r?\n/);
	const columns = header.split(",");
	const at = (name: string) => columns.indexOf(name);
	for (const line of lines) {
		const cells = line.split(",");
		if (cells[at("Flow_Direction")] !== "I") continue;
		const periods = Array.from({ length: 50 }, (_, i) => cells[at(`TP${i + 1}`)])
			.filter((value) => value !== undefined && value !== "")
			.map(Number);
		const retailers = injections.get(cells[at("POC")]) ?? new Map<string, Days>();
		const days = retailers.get(cells[at("Participant_Code")]) ?? new Map<string, number[]>();
		const existing = days.get(cells[at("Trading_Date")]);
		days.set(
			cells[at("Trading_Date")],
			existing ? existing.map((kwh, i) => kwh + (periods[i] ?? 0)) : periods,
		);
		retailers.set(cells[at("Participant_Code")], days);
		injections.set(cells[at("POC")], retailers);
	}
}

const substations = (await (await fetch("https://api.electricitymap.frenchsta.gg/v1/substations")).json()) as {
	siteId: string;
	description: string;
	lat: number;
	long: number;
}[];

if (target === "all") {
	await backtestAll();
} else if (target === "farms") {
	await backtestFarms();
} else {
	const result = await backtest(target, true);
	printResult(result);
	if (outPath) {
		writeFileSync(
			outPath,
			[
				"start_utc,trading_date,trading_period,capacity_mw,observed_kwh,model_kwh",
				...result.halfHours.map((h) =>
					[new Date(h.start).toISOString(), h.tradingDate, h.period, h.capacityMw, h.observedKwh.toFixed(3), h.modelKwh.toFixed(3)].join(","),
				),
			].join("\n") + "\n",
		);
		console.log(`\nWrote ${result.halfHours.length} half-hours to ${outPath}`);
	}
}

// Every GXP with solar exports, except those with dispatched solar farms: a
// farm's exports look like solar but its capacity isn't in distributed_mw.
async function backtestAll() {
	const generators = (await (await fetch("https://api.electricitymap.frenchsta.gg/v1/generators")).json()) as {
		units: { node: string; fuelCode: string }[];
	}[];
	const farmGxps = new Set(
		generators.flatMap((generator) => generator.units).filter((unit) => unit.fuelCode === "SOL").map((unit) => unit.node.slice(0, 3)),
	);
	const solarMwh = new Map<string, number>();
	for (const [poc, retailers] of injections) {
		for (const days of retailers.values()) {
			const { total, solar } = classify(days);
			if (solar) solarMwh.set(poc.slice(0, 3), (solarMwh.get(poc.slice(0, 3)) ?? 0) + total / 1000);
		}
	}

	const results: Result[] = [];
	const skipped: string[] = [];
	for (const gxp of [...solarMwh.keys()].sort()) {
		if (farmGxps.has(gxp)) {
			skipped.push(`${gxp} (dispatched solar farm)`);
		} else if (solarMwh.get(gxp)! < MIN_EXPORT_MWH) {
			skipped.push(`${gxp} (${solarMwh.get(gxp)!.toFixed(1)} MWh)`);
		} else {
			try {
				results.push(await backtest(gxp, false));
				process.stdout.write(".");
			} catch (error) {
				skipped.push(`${gxp} (${(error as Error).message})`);
			}
		}
	}

	console.log(`\n\nGXP  name                 MW   kW/ICP  exported  modelled  share  ±day  daily r  hh r  peak obs/mod`);
	for (const r of results.sort((a, b) => a.share - b.share)) {
		console.log(
			`${r.target}  ${r.name.slice(0, 18).padEnd(18)} ${r.capacityMw.toFixed(1).padStart(6)}  ${(r.kwPerIcp ?? 0).toFixed(1).padStart(6)}  ${r.observedMwh.toFixed(0).padStart(8)}  ${r.modelMwh.toFixed(0).padStart(8)}  ${r.share.toFixed(2).padStart(5)}  ${r.dailyShareSpread.toFixed(2)}  ${r.dailyR.toFixed(2).padStart(7)}  ${r.halfHourR.toFixed(2)}  ${r.peaks.observed}/${r.peaks.model}`,
		);
	}

	const shares = results.map((r) => r.share).sort((a, b) => a - b);
	const quantile = (q: number) => shares[Math.round(q * (shares.length - 1))];
	const exported = results.reduce((sum, r) => sum + r.observedMwh, 0);
	const modelled = results.reduce((sum, r) => sum + r.modelMwh, 0);
	console.log(`\n${results.length} GXPs: ${exported.toFixed(0)} MWh exported of ${modelled.toFixed(0)} MWh modelled, a share of ${(exported / modelled).toFixed(2)}`);
	console.log(`  Share by GXP: median ${quantile(0.5).toFixed(2)}, middle half ${quantile(0.25).toFixed(2)}–${quantile(0.75).toFixed(2)}, range ${shares[0].toFixed(2)}–${shares[shares.length - 1].toFixed(2)}`);
	console.log(`  Median correlation: daily r ${median(results.map((r) => r.dailyR)).toFixed(2)}, half-hour r ${median(results.map((r) => r.halfHourR)).toFixed(2)}`);
	console.log(`  Share vs average system size: r = ${correlation(results.map((r) => r.kwPerIcp ?? 0), results.map((r) => r.share)).toFixed(2)}`);
	console.log(`  Skipped ${skipped.length}: ${skipped.join(", ")}`);

	if (outPath) {
		writeFileSync(
			outPath,
			[
				"gxp,name,capacity_mw,kw_per_icp,exported_mwh,modelled_mwh,share,daily_share_spread,daily_r,half_hour_r,observed_peak,modelled_peak",
				...results.map((r) =>
					[r.target, `"${r.name}"`, r.capacityMw, (r.kwPerIcp ?? 0).toFixed(2), r.observedMwh.toFixed(2), r.modelMwh.toFixed(2), r.share.toFixed(4), r.dailyShareSpread.toFixed(4), r.dailyR.toFixed(4), r.halfHourR.toFixed(4), r.peaks.observed, r.peaks.model].join(","),
				),
			].join("\n") + "\n",
		);
		console.log(`\nWrote ${results.length} GXPs to ${outPath}`);
	}
}

// Whether a retailer's exports at a POC look like solar: almost none at night.
function classify(days: Days) {
	let total = 0;
	let night = 0;
	for (const periods of days.values()) {
		periods.forEach((kwh, i) => {
			total += kwh;
			// Before 6am or from 8pm, give or take an hour on daylight saving days.
			if (i < 12 || i >= 40) night += kwh;
		});
	}
	return { total, night, solar: total > 0 && night / total <= MAX_SOLAR_NIGHT_SHARE };
}

async function backtest(target: string, verbose: boolean): Promise<Result> {
	const gxp = target.slice(0, 3);
	const solar: Days[] = [];
	for (const [poc, retailers] of injections) {
		if (!poc.startsWith(target)) continue;
		for (const [retailer, days] of retailers) {
			const { total, night, solar: isSolar } = classify(days);
			if (isSolar) solar.push(days);
			if (verbose) {
				console.log(
					`${isSolar ? "solar    " : "excluded "} ${poc} ${retailer.padEnd(5)} ${(total / 1000).toFixed(2).padStart(10)} MWh, ${((night / total) * 100).toFixed(0)}% at night`,
				);
			}
		}
	}
	if (solar.length === 0) throw new Error(`no solar exports found for ${target}`);

	const site = substations.find((substation) => substation.siteId === gxp);
	if (!site) throw new Error(`no substation ${gxp}`);
	const capacities = await capacityHistory(gxp);
	// What the API would have estimated on each date, from the snapshots before
	// it, with every farm-sized step so far modelled as a farm.
	const capacityOn = (date: string): SolarCapacity => {
		const estimate = capacityAt(capacities, date);
		if (!estimate) throw new Error(`no capacity as at ${date}`);
		const totalMw =
			capacityMethod === "snapshot"
				? capacities.find((month) => month.monthEnd === estimate.monthEnd)!.distributedMw
				: estimate.capacityMw;
		const stepsMw = capacities.filter((month) => month.monthEnd <= date).reduce((total, month) => total + month.stepMw, 0);
		const farmMw = Math.min(stepsMw, totalMw);
		return { rooftopMw: totalMw - farmMw, farmMw };
	};
	const lastDate = [...new Set(solar.flatMap((days) => [...days.keys()]))].sort().at(-1)!;
	const latest = capacities.findLast((month) => month.monthEnd <= lastDate)!;
	const locations: Record<string, GxpLocation> = gxpLocations.gxps;
	return compare({
		target,
		name: site.description,
		series: solar,
		points: weatherPoints(site, locations[gxp], latest.distributedMw),
		capacityAt: capacityOn,
		kwPerIcp: (latest.distributedMw * 1000) / latest.icpCount,
	});
}

// Compares metered series against the model at a site, over the dates they cover.
async function compare(subject: {
	target: string;
	name: string;
	series: Days[];
	// Where to take the weather, as the API would.
	points: WeatherPoints;
	capacityAt: (date: string) => SolarCapacity;
	kwPerIcp: number | null;
}): Promise<Result> {
	const solar = subject.series;
	// Trading periods count half-hours of elapsed time from NZ midnight, so a
	// daylight saving day has 46 or 50 of them.
	const halfHours: HalfHour[] = [];
	const dates = [...new Set(solar.flatMap((days) => [...days.keys()]))].sort();
	for (const tradingDate of dates) {
		const midnight = nzMidnight(tradingDate);
		const periods = Math.max(...solar.map((days) => days.get(tradingDate)?.length ?? 0));
		for (let period = 1; period <= periods; period++) {
			halfHours.push({
				tradingDate,
				period,
				start: midnight + (period - 1) * HALF_HOUR_MS,
				observedKwh: solar.reduce((sum, days) => sum + (days.get(tradingDate)?.[period - 1] ?? 0), 0),
				modelKwh: 0,
				capacityMw: 0,
			});
		}
	}

	const weather = await fetchWeather(subject.points, dates[0], dates[dates.length - 1], { source: weatherSource });
	for (const halfHour of halfHours) {
		const capacity = subject.capacityAt(halfHour.tradingDate);
		halfHour.capacityMw = capacity.rooftopMw + capacity.farmMw;
		halfHour.modelKwh = modelKwh(weather, halfHour.start, halfHour.start + HALF_HOUR_MS, capacity);
	}
	const clearness = new Map(dates.map((date) => [date, clearnessIndex(weather, date)]));

	const measured = measure(halfHours);
	return {
		...measured,
		target: subject.target,
		name: subject.name,
		halfHours,
		capacityMw: halfHours[halfHours.length - 1].capacityMw,
		kwPerIcp: subject.kwPerIcp,
		skies: bySky(halfHours, clearness, measured.share),
	};
}

// The dispatched solar farms, each modelled as the model's farm array at its
// own location and dispatch capacity, on its own satellite pixel.
async function backtestFarms() {
	const generators = (await (await fetch("https://api.electricitymap.frenchsta.gg/v1/generators")).json()) as {
		location: { lat: number; long: number };
		units: { name: string; capacity: number; fuelCode: string }[];
	}[];
	const results: Result[] = [];
	for (const farm of FARMS) {
		const generator = generators.find((g) => g.units.some((unit) => unit.name === farm.unit && unit.fuelCode === "SOL"));
		const days = injections.get(farm.poc)?.get(farm.retailer);
		if (!generator || !days) {
			console.log(`Skipped ${farm.unit}: ${generator ? "no series in the files" : "not in the generators list"}`);
			continue;
		}
		const capacityMw = generator.units.find((unit) => unit.name === farm.unit)!.capacity;
		results.push(
			await compare({
				target: `${farm.poc} ${farm.retailer}`,
				name: farm.unit,
				series: [days],
				points: { forecast: generator.location, pixels: [{ ...generator.location, weight: 1 }] },
				capacityAt: () => ({ rooftopMw: 0, farmMw: capacityMw }),
				kwPerIcp: null,
			}),
		);
		process.stdout.write(".");
	}

	console.log("\n\nfarm                    MW  metered  modelled  ratio  ±day  daily r  hh r  shape  centre met/mod");
	for (const r of results) {
		console.log(
			`${r.name.padEnd(22)} ${r.capacityMw.toFixed(1).padStart(5)}  ${r.observedMwh.toFixed(0).padStart(7)}  ${r.modelMwh.toFixed(0).padStart(8)}  ${r.share.toFixed(2).padStart(5)}  ${r.dailyShareSpread.toFixed(2)}  ${r.dailyR.toFixed(2).padStart(7)}  ${r.halfHourR.toFixed(2)}  ${(r.shapeError * 100).toFixed(0).padStart(4)}%  ${r.centres.observed}/${r.centres.model}`,
		);
	}

	// Each farm's misses are after scaling it by its own ratio, so pooling them
	// shows the weather's errors rather than any farm's size or layout.
	console.log("\n  All farms by sky   farm-days  ratio vs own  daily miss  half-hour miss");
	for (const { name } of SKIES) {
		const skies = results.flatMap((r) => r.skies.filter((sky) => sky.name === name).map((sky) => ({ sky, share: r.share })));
		if (skies.length === 0) continue;
		const observed = skies.reduce((sum, { sky }) => sum + sky.observedMwh, 0);
		const weighted = (pick: (sky: Sky) => number) => skies.reduce((sum, { sky }) => sum + pick(sky) * sky.observedMwh, 0) / observed;
		const relative = skies.reduce((sum, { sky, share }) => sum + (sky.share / share) * sky.observedMwh, 0) / observed;
		console.log(
			`    ${name.padEnd(14)} ${String(skies.reduce((sum, { sky }) => sum + sky.days, 0)).padStart(11)}  ${relative.toFixed(2).padStart(12)}  ${(weighted((sky) => sky.dailyError) * 100).toFixed(0).padStart(9)}%  ${(weighted((sky) => sky.halfHourError) * 100).toFixed(0).padStart(13)}%`,
		);
	}
}

function bySky(halfHours: HalfHour[], clearness: Map<string, number>, overallShare: number): Sky[] {
	const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
	return SKIES.map(({ name }) => {
		const inSky = halfHours.filter((h) => skyOf(clearness.get(h.tradingDate)!) === name);
		const dates = [...new Set(inSky.map((h) => h.tradingDate))];
		const days = dates.map((date) => {
			const day = inSky.filter((h) => h.tradingDate === date);
			return { observed: sum(day.map((h) => h.observedKwh)), model: sum(day.map((h) => h.modelKwh)) };
		});
		const observed = sum(days.map((day) => day.observed));
		const daylight = inSky.filter((h) => h.modelKwh > 0 || h.observedKwh > 0);
		const indices = dates.map((date) => clearness.get(date)!);
		return {
			name,
			days: dates.length,
			clearness: [Math.min(...indices), Math.max(...indices)] as [number, number],
			observedMwh: observed / 1000,
			share: observed / sum(days.map((day) => day.model)),
			dailyError: sum(days.map((day) => Math.abs(day.observed - day.model * overallShare))) / observed,
			halfHourError: sum(daylight.map((h) => Math.abs(h.observedKwh - h.modelKwh * overallShare))) / observed,
			halfHourR: correlation(daylight.map((h) => h.observedKwh), daylight.map((h) => h.modelKwh)),
		};
	}).filter((sky) => sky.days > 0);
}

function measure(halfHours: HalfHour[]) {
	const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
	const observed = sum(halfHours.map((h) => h.observedKwh));
	const model = sum(halfHours.map((h) => h.modelKwh));
	const share = observed / model;
	const days = [...new Set(halfHours.map((h) => h.tradingDate))].map((date) => {
		const day = halfHours.filter((h) => h.tradingDate === date);
		return { observed: sum(day.map((h) => h.observedKwh)), model: sum(day.map((h) => h.modelKwh)) };
	});
	const daylight = halfHours.filter((h) => h.modelKwh > 0 || h.observedKwh > 0);

	// The average day, by NZ clock time.
	const byClock = new Map<string, { observed: number; model: number }>();
	for (const h of halfHours) {
		const clock = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(h.start);
		const slot = byClock.get(clock) ?? { observed: 0, model: 0 };
		slot.observed += h.observedKwh;
		slot.model += h.modelKwh;
		byClock.set(clock, slot);
	}
	const clocks = [...byClock.entries()].sort(([a], [b]) => a.localeCompare(b));
	const peak = (key: "observed" | "model") => clocks.reduce((best, slot) => (slot[1][key] > best[1][key] ? slot : best))[0];
	const centre = (key: "observed" | "model") => {
		// Weighted by energy, at the middle of each half-hour.
		const minutes = clocks.reduce((sum, [clock, slot]) => sum + (Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3)) + 15) * slot[key], 0) /
			clocks.reduce((sum, [, slot]) => sum + slot[key], 0);
		return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(Math.round(minutes % 60)).padStart(2, "0")}`;
	};

	return {
		observedMwh: observed / 1000,
		modelMwh: model / 1000,
		share,
		dailyShareSpread: stdDev(days.map((day) => day.observed / day.model)),
		dailyR: correlation(days.map((d) => d.observed), days.map((d) => d.model)),
		halfHourR: correlation(daylight.map((h) => h.observedKwh), daylight.map((h) => h.modelKwh)),
		// How far off the shape is once the model is scaled to the observed total.
		shapeError: sum(daylight.map((h) => Math.abs(h.observedKwh - h.modelKwh * share))) / observed,
		peaks: { observed: peak("observed"), model: peak("model") },
		centres: { observed: centre("observed"), model: centre("model") },
		profile: clocks.map(([clock, slot]) => [clock, slot.observed / observed, slot.model / model] as [string, number, number]),
	};
}

function printResult(r: Result) {
	const days = new Set(r.halfHours.map((h) => h.tradingDate));
	const dates = [...days].sort();
	console.log(`\n${r.target}: ${days.size} days, ${dates[0]} to ${dates[dates.length - 1]}`);
	const capacities = r.halfHours.map((h) => h.capacityMw);
	console.log(`  Capacity             ${capacities[0].toFixed(3)} → ${capacities[capacities.length - 1].toFixed(3)} MW${r.kwPerIcp === null ? "" : ` (${r.kwPerIcp.toFixed(1)} kW per ICP)`}`);
	console.log(`  Observed exports     ${r.observedMwh.toFixed(1)} MWh (${(r.observedMwh / days.size).toFixed(2)} MWh a day)`);
	console.log(`  Modelled generation  ${r.modelMwh.toFixed(1)} MWh (${(r.modelMwh / days.size).toFixed(2)} MWh a day)`);
	console.log(`  Observed / modelled  ${r.share.toFixed(2)} overall, ± ${r.dailyShareSpread.toFixed(2)} day to day`);
	console.log(`  Correlation          daily energy r = ${r.dailyR.toFixed(2)}, daylight half-hours r = ${r.halfHourR.toFixed(2)}`);
	console.log(`  Shape error          ${(r.shapeError * 100).toFixed(0)}% of observed energy, after scaling the model by ${r.share.toFixed(2)}`);
	console.log(`  Average peak         observed at ${r.peaks.observed}, modelled at ${r.peaks.model} (half-hour starting, NZ time)`);
	console.log(`  Middle of the day    observed ${r.centres.observed}, modelled ${r.centres.model} (energy-weighted, NZ time)`);

	console.log(`\n  By sky (clearness index), misses after scaling the model by ${r.share.toFixed(2)}:`);
	console.log("    sky             days  clearness   share  daily miss  half-hour miss  half-hour r");
	for (const sky of r.skies) {
		console.log(
			`    ${sky.name.padEnd(14)}  ${String(sky.days).padStart(4)}  ${sky.clearness[0].toFixed(2)}–${sky.clearness[1].toFixed(2)}  ${sky.share.toFixed(2).padStart(6)}  ${(sky.dailyError * 100).toFixed(0).padStart(9)}%  ${(sky.halfHourError * 100).toFixed(0).padStart(13)}%  ${sky.halfHourR.toFixed(2).padStart(11)}`,
		);
	}

	console.log("\n  Average day (share of the day's energy):  time  observed  modelled");
	for (const [clock, observed, model] of r.profile) {
		if (observed === 0 && model === 0) continue;
		console.log(`    ${clock}  ${(observed * 100).toFixed(1).padStart(5)}%  ${(model * 100).toFixed(1).padStart(5)}%`);
	}
}

async function capacityHistory(gxp: string): Promise<(CapacityMonth & { icpCount: number })[]> {
	const res = await fetch(`${apiUrl}/solar-capacity/${gxp}`);
	if (!res.ok) throw new Error(`no capacity from ${apiUrl} (${res.status})`);
	const body = (await res.json()) as { result: { months: (CapacityMonth & { icpCount: number })[] } };
	return body.result.months;
}
