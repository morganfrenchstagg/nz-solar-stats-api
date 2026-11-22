// Backtests the production model against the System Operator's 5-minute
// dispatch data, via electricitymap. Unlike EMI's monthly files, which come
// out weeks after each month, it's there the same day, so it covers the last
// fortnight.
//
//   npm run backtest:dispatch -- farms
//   npm run backtest:dispatch -- gxps
//   npm run backtest:dispatch -- PAO,WHU,HLY --from 2026-08-14 --to 2026-11-05
//
// "farms" compares each dispatched solar farm's output with the model's farm
// array at its own location and dispatch capacity, on its own satellite pixel,
// as `npm run backtest -- farms` does with EMI's files. Farms have no demand
// mixed in, so they test the model's level and the weather directly.
//
// "gxps", or a list of GXPs, compares each GXP's net grid load with the
// estimates the API has stored for it (/solar-production/{date}). Days before
// yesterday are estimated again whenever the model or capacities change, so
// these are the current model's. Rooftop solar shows up as load going missing:
// net load is fitted on a level for each day, a weekday and a weekend
// time-of-day shape that drift over the period, and the estimate. The slope is
// the MW of load that went missing per estimated MW, so 1 means the grid saw
// what the API estimated. It measures the capacity and the model together. A
// second fit adds heating (degrees below 16 °C, by time of day), since cold
// days are often dull. Where solar is a small part of load, other demand that
// moves with the weather swamps it, so "gxps" only lists GXPs whose estimated
// solar is at least --min-share (default 0.1) of their demand at midday.
//
// Options: --from and --to (NZ dates; default the 14 days to yesterday),
// --period <days> (default 14; a range with two or more is also broken down
// by period, counted back from --to), --weather satellite|forecast (farms;
// default satellite, as the API does), --api <url> for the stored estimates
// (default the deployed API) and --out <file> for a CSV of the results.
// Open-Meteo's forecast API, which the weather and temperatures come from, only
// goes back about three months.
import { writeFileSync } from "node:fs";
import type { GxpLocation } from "../src/production/blend.ts";
import gxpLocations from "../src/production/gxpLocations.json" with { type: "json" };
import { averageMw, DISPATCH_URL, type DispatchDay, fitSlope, netLoad, parseDispatch, type Readings, type Slope } from "./dispatch.ts";
import {
	clearnessIndex,
	correlation,
	fetchWeather,
	getSeries,
	mean,
	median,
	modelKwh,
	nzDate,
	nzMidnight,
	shiftDate,
	SKIES,
	skyOf,
	stdDev,
	type Weather,
	type WeatherSource,
} from "./shared.ts";

const HALF_HOUR_MS = 30 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Midday: half-hours from 10am to 3pm.
const MIDDAY_SLOTS = [20, 30];
// A day a farm's output peaked below this share of its capacity, while the
// model had it near full, was an outage or curtailment rather than weather.
const OUTAGE_PEAK_SHARE = 0.6;
// Below this, a GXP's solar is too small to see in its load.
const MIN_GXP_MW = 2;
const HEATING_BASE_C = 16;

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? fallback : args.splice(index, 2)[1];
};
const apiUrl = option("api", "https://nz-solar-stats-api.morgan6725.workers.dev");
const to = option("to", shiftDate(nzDate(Date.now()), -1));
const from = option("from", shiftDate(to, -13));
const periodDays = Number(option("period", "14"));
const minShare = Number(option("min-share", "0.1"));
const outPath = option("out", "");
const weatherSource = option("weather", "satellite") as WeatherSource;
const [target] = args;
if (!target || from > to || !(periodDays > 0) || !["satellite", "forecast"].includes(weatherSource)) {
	console.error(
		"Usage: npm run backtest:dispatch -- <farms | gxps | GXP,GXP...> [--from date] [--to date] [--period days] [--min-share share] [--weather satellite|forecast] [--api url] [--out file]",
	);
	process.exit(1);
}

const dates: string[] = [];
for (let date = from; date <= to; date = shiftDate(date, 1)) dates.push(date);
// Whole periods only, counted back from the last date.
const periods: [string, string][] = [];
for (let end = to; shiftDate(end, 1 - periodDays) >= from; end = shiftDate(end, -periodDays)) {
	periods.unshift([shiftDate(end, 1 - periodDays), end]);
}
const showPeriods = periods.length >= 2;
const periodOf = (date: string) => periods.findIndex(([start, end]) => date >= start && date <= end);

interface HalfHour {
	start: number;
	date: string;
	day: number; // index into dates
	slot: number; // NZ clock half-hour, 0–47
	weekend: boolean;
}

const clockFormat = new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const halfHours: HalfHour[] = dates.flatMap((date, day) => {
	const weekend = [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
	const steps: HalfHour[] = [];
	for (let start = nzMidnight(date); start < nzMidnight(shiftDate(date, 1)); start += HALF_HOUR_MS) {
		const [hour, minute] = clockFormat.format(start).split(":").map(Number);
		steps.push({ start, date, day, slot: hour * 2 + minute / 30, weekend });
	}
	return steps;
});
const isMidday = (h: HalfHour) => h.slot >= MIDDAY_SLOTS[0] && h.slot < MIDDAY_SLOTS[1];

console.log(`${from} to ${to} (${dates.length} days)`);
const readings = parseDispatch(await fetchAll<DispatchDay>(dates.map((date) => `${DISPATCH_URL}/${date}`)));

if (target === "farms") {
	await backtestFarms();
} else {
	await backtestGxps(target === "gxps" ? null : target.toUpperCase().split(","));
}

interface FarmResult {
	name: string;
	node: string;
	capacityMw: number;
	peakMw: number;
	days: number;
	leftOut: string[];
	observedMwh: number;
	modelMwh: number;
	ratio: number;
	dailySpread: number;
	dailyR: number;
	halfHourR: number;
	// Misses once the model is scaled by the farm's own ratio, as a share of its output.
	shapeError: number;
	dailyMiss: number;
	// Energy-weighted middle of the day, NZ clock time: unlike the peak, not
	// thrown by flat tops at the inverter limit.
	centres: { observed: string; model: string };
	skies: { name: string; days: number; ratio: number; miss: number; observedMwh: number }[];
	periodRatios: (number | null)[];
}

async function backtestFarms() {
	const generators = (await (await fetch("https://api.electricitymap.frenchsta.gg/v1/generators")).json()) as {
		location: { lat: number; long: number };
		units: { name: string; node: string; capacity: number; fuelCode: string }[];
	}[];
	const results: FarmResult[] = [];
	const skipped: string[] = [];
	for (const generator of generators) {
		for (const unit of generator.units) {
			if (unit.fuelCode !== "SOL") continue;
			const output = readings.get(unit.node);
			if (!output || highest(output.values()) < 0.05 * unit.capacity) {
				skipped.push(`${unit.name} (not generating)`);
				continue;
			}
			const location = generator.location;
			const weather = await fetchWeather({ forecast: location, pixels: [{ ...location, weight: 1 }] }, from, to, { source: weatherSource });
			results.push(compareFarm(unit, output, weather));
			process.stdout.write(".");
		}
	}

	console.log(`\n\nWeather: ${weatherSource === "satellite" ? "satellite readings (as the API uses them)" : "forecast only"}`);
	console.log("farm                       MW   peak  days  metered  modelled  ratio  ±day  daily r  hh r  shape  daily miss  centre met/mod  left out");
	for (const r of results) {
		console.log(
			`${r.name.slice(0, 22).padEnd(22)} ${r.capacityMw.toFixed(1).padStart(6)} ${r.peakMw.toFixed(1).padStart(6)}  ${String(r.days).padStart(4)}  ${r.observedMwh.toFixed(0).padStart(7)}  ${r.modelMwh.toFixed(0).padStart(8)}  ${r.ratio.toFixed(2).padStart(5)}  ${r.dailySpread.toFixed(2)}  ${r.dailyR.toFixed(2).padStart(7)}  ${r.halfHourR.toFixed(2)}  ${pct(r.shapeError).padStart(5)}  ${pct(r.dailyMiss).padStart(10)}  ${r.centres.observed}/${r.centres.model}     ${r.leftOut.map((date) => date.slice(5)).join(" ")}`,
		);
	}
	const ratios = results.map((r) => r.ratio).sort((a, b) => a - b);
	const metered = results.reduce((total, r) => total + r.observedMwh, 0);
	const modelled = results.reduce((total, r) => total + r.modelMwh, 0);
	console.log(`\n${results.length} farms: ${metered.toFixed(0)} MWh metered of ${modelled.toFixed(0)} MWh modelled, a ratio of ${(metered / modelled).toFixed(2)}`);
	console.log(`  By farm: median ${median(ratios).toFixed(2)}, range ${ratios[0].toFixed(2)}–${ratios[ratios.length - 1].toFixed(2)}`);
	console.log(`  Median daily r ${median(results.map((r) => r.dailyR)).toFixed(2)}, half-hour r ${median(results.map((r) => r.halfHourR)).toFixed(2)}, shape error ${pct(median(results.map((r) => r.shapeError)))}, daily miss ${pct(median(results.map((r) => r.dailyMiss)))}`);
	console.log("  Left out: days a farm peaked under 60% of its capacity while the model had it over 80% (outages, curtailment), or had no readings.");
	if (skipped.length > 0) console.log(`  Skipped ${skipped.length}: ${skipped.join(", ")}`);

	// Against each farm's own ratio, so layout drops out and the weather's
	// errors are left.
	console.log("\n  All farms by sky   farm-days  ratio vs own  daily miss");
	for (const { name } of SKIES) {
		const skies = results.flatMap((r) => r.skies.filter((sky) => sky.name === name).map((sky) => ({ sky, own: r.ratio })));
		if (skies.length === 0) continue;
		const observed = skies.reduce((total, { sky }) => total + sky.observedMwh, 0);
		const weighted = (pick: (s: (typeof skies)[number]) => number) => skies.reduce((total, s) => total + pick(s) * s.sky.observedMwh, 0) / observed;
		console.log(
			`    ${name.padEnd(14)} ${String(skies.reduce((total, { sky }) => total + sky.days, 0)).padStart(11)}  ${weighted((s) => s.sky.ratio / s.own).toFixed(2).padStart(12)}  ${pct(weighted((s) => s.sky.miss)).padStart(10)}`,
		);
	}

	if (showPeriods) {
		console.log(`\n  Metered / modelled by period${periodHeader(23)}`);
		for (const r of results) console.log(`    ${r.name.slice(0, 22).padEnd(22)}${r.periodRatios.map((ratio) => (ratio === null ? "–" : ratio.toFixed(2)).padStart(13)).join("")}`);
		// Each farm against its own average over the periods, so a change with
		// the season shows apart from any farm's layout.
		const complete = results.filter((r) => r.periodRatios.every((ratio) => ratio !== null)).map((r) => r.periodRatios as number[]);
		if (complete.length > 0) {
			const relative = complete.map((row) => row.map((ratio) => ratio / mean(row)));
			console.log(`    ${`median vs own (${complete.length} farms)`.padEnd(22)}${periods.map((_, i) => median(relative.map((row) => row[i])).toFixed(2).padStart(13)).join("")}`);
		}
	}

	if (outPath) {
		writeCsv(
			["farm", "node", "capacity_mw", "peak_mw", "days", "metered_mwh", "modelled_mwh", "ratio", "daily_r", "half_hour_r", "shape_error", "daily_miss"],
			results.map((r) => [`"${r.name}"`, r.node, r.capacityMw, r.peakMw.toFixed(2), r.days, r.observedMwh.toFixed(1), r.modelMwh.toFixed(1), r.ratio.toFixed(4), r.dailyR.toFixed(4), r.halfHourR.toFixed(4), r.shapeError.toFixed(4), r.dailyMiss.toFixed(4)]),
			results.map((r) => r.periodRatios),
		);
	}
}

function compareFarm(unit: { name: string; node: string; capacity: number }, output: Readings, weather: Weather): FarmResult {
	const capacity = { rooftopMw: 0, farmMw: unit.capacity };
	const all = halfHours.flatMap((h) => {
		const observedMw = averageMw(output, h.start, h.start + HALF_HOUR_MS);
		// kWh in half an hour, as MW.
		return observedMw === null ? [] : [{ ...h, observedMw, modelMw: modelKwh(weather, h.start, h.start + HALF_HOUR_MS, capacity) / 500 }];
	});
	const leftOut = dates.filter((date) => {
		const day = all.filter((h) => h.date === date);
		return (
			day.length === 0 ||
			(highest(day.map((h) => h.observedMw)) < OUTAGE_PEAK_SHARE * unit.capacity && highest(day.map((h) => h.modelMw)) > 0.8 * unit.capacity)
		);
	});
	const rows = all.filter((h) => !leftOut.includes(h.date) && (h.modelMw > 0 || h.observedMw > 0.01 * unit.capacity));

	const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
	const observed = sum(rows.map((h) => h.observedMw));
	const model = sum(rows.map((h) => h.modelMw));
	const ratio = observed / model;
	const days = [...new Set(rows.map((h) => h.date))].map((date) => {
		const day = rows.filter((h) => h.date === date);
		return { date, observed: sum(day.map((h) => h.observedMw)), model: sum(day.map((h) => h.modelMw)) };
	});
	const clearness = new Map(days.map(({ date }) => [date, clearnessIndex(weather, date)]));
	const centre = (pick: (h: (typeof rows)[number]) => number) => clock(sum(rows.map((h) => (h.slot * 30 + 15) * pick(h))) / sum(rows.map(pick)));
	const periodRatios = periods.map((_, i) => {
		const inPeriod = days.filter((day) => periodOf(day.date) === i);
		return inPeriod.length * 2 >= periodDays ? sum(inPeriod.map((day) => day.observed)) / sum(inPeriod.map((day) => day.model)) : null;
	});

	return {
		name: unit.name,
		node: unit.node,
		capacityMw: unit.capacity,
		peakMw: highest(all.map((h) => h.observedMw)),
		days: days.length,
		leftOut,
		observedMwh: observed / 2,
		modelMwh: model / 2,
		ratio,
		dailySpread: stdDev(days.map((day) => day.observed / day.model)),
		dailyR: correlation(days.map((day) => day.observed), days.map((day) => day.model)),
		halfHourR: correlation(rows.map((h) => h.observedMw), rows.map((h) => h.modelMw)),
		shapeError: sum(rows.map((h) => Math.abs(h.observedMw - h.modelMw * ratio))) / observed,
		dailyMiss: sum(days.map((day) => Math.abs(day.observed - day.model * ratio))) / observed,
		centres: { observed: centre((h) => h.observedMw), model: centre((h) => h.modelMw) },
		skies: SKIES.map(({ name }) => {
			const inSky = days.filter((day) => skyOf(clearness.get(day.date)!) === name);
			const skyObserved = sum(inSky.map((day) => day.observed));
			return {
				name,
				days: inSky.length,
				ratio: skyObserved / sum(inSky.map((day) => day.model)),
				miss: sum(inSky.map((day) => Math.abs(day.observed - day.model * ratio))) / skyObserved,
				observedMwh: skyObserved / 2,
			};
		}).filter((sky) => sky.days > 0),
		periodRatios,
	};
}

interface StoredDay {
	profileTimes: string[];
	gxps: { gxp: string; name: string; distributedMw: number; farmMw: number; profileMw: number[] }[];
}

interface GxpRow extends HalfHour {
	loadMw: number;
	solarMw: number;
}

async function backtestGxps(only: string[] | null) {
	const stored = await fetchAll<{ result: StoredDay }>(dates.map((date) => `${apiUrl}/solar-production/${date}`));
	const estimates = new Map<string, Map<number, number>>(); // each GXP's estimate at each 10-minute instant
	const gxps = new Map<string, StoredDay["gxps"][number]>(); // as on the last date
	for (const { result } of stored) {
		const times = result.profileTimes.map((time) => Date.parse(time));
		for (const gxp of result.gxps) {
			const estimate = estimates.get(gxp.gxp) ?? new Map<number, number>();
			gxp.profileMw.forEach((mw, i) => estimate.set(times[i], mw));
			estimates.set(gxp.gxp, estimate);
			gxps.set(gxp.gxp, gxp);
		}
	}

	const candidates: { gxp: StoredDay["gxps"][number]; rows: GxpRow[]; share: number }[] = [];
	const skipped: string[] = [];
	for (const code of only ?? [...gxps.keys()].sort()) {
		const gxp = gxps.get(code);
		const estimate = estimates.get(code);
		if (!gxp || !estimate) {
			skipped.push(`${code} (no estimates)`);
			continue;
		}
		const load = netLoad(readings, code);
		const rows = halfHours.flatMap((h) => {
			const loadMw = averageMw(load, h.start, h.start + HALF_HOUR_MS);
			if (loadMw === null) return [];
			// The 10-minute estimates, by the trapezoid rule; none after the last date.
			const at = (k: number) => estimate.get(h.start + k * TEN_MINUTES_MS) ?? 0;
			return [{ ...h, loadMw, solarMw: (at(0) / 2 + at(1) + at(2) + at(3) / 2) / 3 }];
		});
		if (rows.length < 0.8 * halfHours.length) {
			if (only) skipped.push(`${code} (${load.size === 0 ? "no load buses" : "too few load readings"})`);
			continue;
		}
		const midday = rows.filter(isMidday);
		const solar = mean(midday.map((h) => h.solarMw));
		// Of the demand there'd be without the solar, if the estimate's right.
		const share = solar / mean(midday.map((h) => h.loadMw + h.solarMw));
		if (only || (gxp.distributedMw >= MIN_GXP_MW && share >= minShare)) candidates.push({ gxp, rows, share });
	}
	if (candidates.length === 0) {
		console.log(`No GXPs to compare. ${skipped.join(", ")}`);
		process.exit(1);
	}

	const temperatures = await fetchTemperatures(candidates.map(({ gxp }) => gxp.gxp));
	const results = candidates
		.map(({ gxp, rows, share }) => {
			const heating = rows.map((h) => Math.max(0, HEATING_BASE_C - temperatures.get(gxp.gxp)!(h.start + HALF_HOUR_MS / 2)));
			const inPeriod = (i: number) => rows.map((h, j) => ({ h, j })).filter(({ h }) => periodOf(h.date) === i);
			return {
				gxp,
				share,
				fit: fitGxp(rows, null),
				heatingFit: fitGxp(rows, heating),
				periodFits: periods.map((_, i) => {
					const subset = inPeriod(i);
					return subset.length >= 0.5 * periodDays * 48 ? fitGxp(subset.map(({ h }) => h), subset.map(({ j }) => heating[j])) : null;
				}),
			};
		})
		.sort((a, b) => b.share - a.share);

	console.log(`\nEstimates from ${apiUrl}. Slope: MW of load gone per estimated MW of solar (1 = the grid saw the estimate).`);
	console.log("GXP  name                    MW   farm  share        slope   with heating");
	for (const r of results) {
		console.log(
			`${r.gxp.gxp}  ${r.gxp.name.slice(0, 20).padEnd(20)} ${r.gxp.distributedMw.toFixed(1).padStart(6)} ${r.gxp.farmMw.toFixed(1).padStart(6)}  ${r.share.toFixed(2).padStart(5)}  ${formatSlope(r.fit).padStart(11)}  ${formatSlope(r.heatingFit).padStart(13)}`,
		);
	}
	const heavy = results.filter((r) => r.share >= 0.3);
	if (heavy.length > 1) {
		console.log(`\n${heavy.length} GXPs with solar at least 30% of midday demand: median slope ${median(heavy.map((r) => r.fit.slope)).toFixed(2)}, ${median(heavy.map((r) => r.heatingFit.slope)).toFixed(2)} with heating`);
	}
	console.log("  Farm is the farm-sized steps modelled as a farm. Share is estimated solar over midday demand (10am–3pm).");
	console.log("  A slope well off 1 at a solar-heavy GXP usually means its capacity is wrong: a farm-sized step that isn't local generation, or local generation the registry doesn't attribute to it.");
	if (skipped.length > 0) console.log(`  Skipped ${skipped.length}: ${skipped.join(", ")}`);

	if (showPeriods) {
		console.log(`\n  Slope with heating, by period${periodHeader(9)}`);
		for (const r of results) {
			console.log(`    ${r.gxp.gxp.padEnd(8)}${r.periodFits.map((fit) => (fit === null ? "–" : formatSlope(fit)).padStart(13)).join("")}`);
		}
	}

	if (outPath) {
		writeCsv(
			["gxp", "name", "distributed_mw", "farm_mw", "share", "slope", "slope_se", "heating_slope", "heating_slope_se"],
			results.map((r) => [r.gxp.gxp, `"${r.gxp.name}"`, r.gxp.distributedMw, r.gxp.farmMw, r.share.toFixed(4), r.fit.slope.toFixed(4), r.fit.standardError.toFixed(4), r.heatingFit.slope.toFixed(4), r.heatingFit.standardError.toFixed(4)]),
			results.map((r) => r.periodFits.map((fit) => fit?.slope ?? null)),
		);
	}
}

// Net load on a level for each day, a weekday and a weekend time-of-day shape
// that drift over the rows' days, heating by time of day if given, and the
// estimate. Load falls as solar rises, so the slope is turned round.
function fitGxp(rows: GxpRow[], heating: number[] | null): Slope {
	const middleDay = mean(rows.map((h) => h.day));
	const controls: number[][] = [];
	for (let slot = 0; slot < 48; slot++) {
		for (const weekend of [false, true]) controls.push(rows.map((h) => (h.slot === slot && h.weekend === weekend ? 1 : 0)));
		controls.push(rows.map((h) => (h.slot === slot ? (h.day - middleDay) / 14 : 0)));
	}
	if (heating) {
		// In 4-hour blocks.
		for (let block = 0; block < 6; block++) controls.push(rows.map((h, i) => (Math.floor(h.slot / 8) === block ? heating[i] : 0)));
	}
	const fit = fitSlope({ y: rows.map((h) => h.loadMw), x: rows.map((h) => h.solarMw), groups: rows.map((h) => h.day), controls });
	return { slope: -fit.slope, standardError: fit.standardError };
}

// Hourly temperature where each GXP's customers live, as a function of time.
async function fetchTemperatures(codes: string[]): Promise<Map<string, (time: number) => number>> {
	const locations: Record<string, GxpLocation> = gxpLocations.gxps;
	const substations = codes.every((code) => locations[code])
		? []
		: ((await (await fetch("https://api.electricitymap.frenchsta.gg/v1/substations")).json()) as { siteId: string; lat: number; long: number }[]);
	const points = codes.map((code) => {
		const location = locations[code];
		return location ? { lat: location.centre[0], long: location.centre[1] } : substations.find((s) => s.siteId === code)!;
	});
	const temperatures = new Map<string, (time: number) => number>();
	for (let i = 0; i < codes.length; i += 25) {
		const series = await getSeries(
			"https://api.open-meteo.com/v1/forecast",
			"hourly",
			points.slice(i, i + 25),
			{ hourly: "temperature_2m", start_date: from, end_date: shiftDate(to, 1), timezone: "GMT", timeformat: "unixtime" },
			0,
		);
		series.forEach((point, j) => {
			const times = point.time.map((seconds) => seconds * 1000);
			const values = point.temperature_2m as number[];
			temperatures.set(codes[i + j], (time) => {
				const k = Math.min(Math.max(Math.floor((time - times[0]) / HOUR_MS) + 1, 1), times.length - 1);
				return values[k - 1] + ((time - times[k - 1]) / (times[k] - times[k - 1])) * (values[k] - values[k - 1]);
			});
		});
	}
	return temperatures;
}

// JSON from each URL, a few at a time.
async function fetchAll<T>(urls: string[]): Promise<T[]> {
	const results: T[] = new Array(urls.length);
	let next = 0;
	const worker = async () => {
		while (next < urls.length) {
			const i = next++;
			const res = await fetch(urls[i]);
			if (!res.ok) throw new Error(`${urls[i]}: ${res.status}`);
			results[i] = (await res.json()) as T;
		}
	};
	await Promise.all(Array.from({ length: 6 }, worker));
	return results;
}

function writeCsv(columns: string[], rows: (string | number)[][], byPeriod: (number | null)[][]) {
	const periodColumns = showPeriods ? periods.map(([start]) => `from_${start}`) : [];
	writeFileSync(
		outPath,
		[
			[...columns, ...periodColumns].join(","),
			...rows.map((row, i) => [...row, ...(showPeriods ? byPeriod[i].map((value) => value?.toFixed(4) ?? "") : [])].join(",")),
		].join("\n") + "\n",
	);
	console.log(`\nWrote ${rows.length} rows to ${outPath}`);
}

function periodHeader(indent: number): string {
	return `\n${" ".repeat(indent)}${periods.map(([start, end]) => `${start.slice(5)}–${end.slice(5)}`.padStart(13)).join("")}`;
}

function formatSlope({ slope, standardError }: Slope): string {
	return `${slope.toFixed(2)} ± ${standardError.toFixed(2)}`;
}

function highest(values: Iterable<number>): number {
	let peak = -Infinity;
	for (const value of values) peak = Math.max(peak, value);
	return peak;
}

function pct(share: number): string {
	return `${(share * 100).toFixed(0)}%`;
}

function clock(minutes: number): string {
	const rounded = Math.round(minutes);
	return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}
