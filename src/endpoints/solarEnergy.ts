import { contentJson, NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { ARCHIVE_START } from "../aggregates/archive";
import type { EnergyFile } from "../aggregates/energy";
import { modelFingerprint } from "../aggregates/model";
import { datesBetween } from "../aggregates/periods";
import { type EnergyResolution, energyKey, energyPeriod } from "../aggregates/store";
import { nzDate, previousDate } from "../production/weather";
import { AppContext } from "../types";
import { cacheUntilStale } from "./cacheControl";

const description =
	"Each day's estimate of distributed solar output (the same model as /solar-production, every 10 minutes) added up into energy. Days are backfilled from the satellite's first readings in July 2015, newest first, as Open-Meteo's free limit allows, so a period may not have all its days yet; yesterday is added through the day as the production job refines it. Whenever the model, a day's capacities or its weather change, the days affected are estimated again and their totals with them.";

const energySeries = z.object({
	series: z.array(z.string()).describe("GXPs, the most energy first"),
	data: z.array(
		z.object({
			from: z.string().describe("The period's first NZ date"),
			to: z.string().describe("The period's last NZ date"),
			days: z.number().describe("How many of the period's days have been estimated so far"),
			totalMwh: z.number().describe("Energy at every GXP, in MWh"),
			mwh: z.array(z.number()).describe("Energy at each of series, in MWh"),
		}),
	),
});

const responses = {
	"200": { description: "One entry per period", ...contentJson({ success: Boolean, result: energySeries }) },
	...NotFoundException.schema(),
};

const year = z.string().regex(/^\d{4}$/).describe("A year, YYYY");

export class SolarEnergyDaily extends OpenAPIRoute {
	public schema = {
		tags: ["Solar energy"],
		summary: "Estimated distributed solar energy at every GXP on each day of a month",
		description,
		request: {
			params: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).describe("An NZ month, YYYY-MM") }),
		},
		responses,
	};

	public async handle(c: AppContext) {
		const { params } = await this.getValidatedData<typeof this.schema>();
		return energy(c, "daily", params.month);
	}
}

export class SolarEnergyWeekly extends OpenAPIRoute {
	public schema = {
		tags: ["Solar energy"],
		summary: "Estimated distributed solar energy at every GXP in each ISO week (Monday to Sunday) of a year",
		description: `${description} A week spanning new year belongs to the year its Thursday is in.`,
		request: { params: z.object({ year }) },
		responses,
	};

	public async handle(c: AppContext) {
		const { params } = await this.getValidatedData<typeof this.schema>();
		return energy(c, "weekly", params.year);
	}
}

export class SolarEnergyMonthly extends OpenAPIRoute {
	public schema = {
		tags: ["Solar energy"],
		summary: "Estimated distributed solar energy at every GXP in each month of a year",
		description,
		request: { params: z.object({ year }) },
		responses,
	};

	public async handle(c: AppContext) {
		const { params } = await this.getValidatedData<typeof this.schema>();
		return energy(c, "monthly", params.year);
	}
}

export class SolarEnergyAnnual extends OpenAPIRoute {
	public schema = {
		tags: ["Solar energy"],
		summary: "Estimated distributed solar energy at every GXP in each year",
		description,
		responses,
	};

	public async handle(c: AppContext) {
		return energy(c, "annual", "all");
	}
}

export class SolarEnergyCoverage extends OpenAPIRoute {
	public schema = {
		tags: ["Solar energy"],
		summary: "How far the backfill has got, and how many days are being estimated again",
		description,
		responses: {
			"200": {
				description: "Days estimated so far",
				...contentJson({
					success: Boolean,
					result: z.object({
						backfillFrom: z.string().describe("The first day the backfill goes back to"),
						estimatedFrom: z.string().nullable(),
						estimatedTo: z.string().nullable(),
						estimatedDays: z.number(),
						awaitingWeatherDays: z
							.number()
							.describe("Days up to yesterday with no weather yet, waiting for Open-Meteo's archive"),
						recalculatingDays: z
							.number()
							.describe("Days whose model, capacities or weather have changed since they were estimated"),
					}),
				}),
			},
		},
	};

	public async handle(c: AppContext) {
		const db = c.env.DB;
		const yesterday = previousDate(nzDate(new Date()));
		const [estimated, firstMonthEnd, withWeather, recalculating] = await db.batch<Record<string, unknown>>([
			db.prepare(
				"SELECT min(nz_date) AS estimatedFrom, max(nz_date) AS estimatedTo, count(*) AS estimatedDays FROM production_days WHERE estimated_weather IS NOT NULL",
			),
			db.prepare("SELECT min(month_end) AS monthEnd FROM solar_capacity"),
			db
				.prepare("SELECT count(*) AS days FROM production_days WHERE weather IS NOT NULL AND nz_date BETWEEN ? AND ?")
				.bind(ARCHIVE_START, yesterday),
			db
				.prepare(
					`SELECT count(*) AS days FROM production_days
					WHERE weather IS NOT NULL AND (model IS NOT ? OR capacity IS NULL OR estimated_weather IS NOT weather)`,
				)
				.bind(await modelFingerprint()),
		]);
		const monthEnd = firstMonthEnd.results[0]?.monthEnd as string | null;
		const backfillFrom = monthEnd && monthEnd > ARCHIVE_START ? monthEnd : ARCHIVE_START;
		const dueDays = backfillFrom <= yesterday ? datesBetween(backfillFrom, yesterday).length : 0;

		cacheUntilStale(c, "aggregate");
		return {
			success: true,
			result: {
				backfillFrom,
				...(estimated.results[0] as { estimatedFrom: string | null; estimatedTo: string | null; estimatedDays: number }),
				awaitingWeatherDays: Math.max(dueDays - (withWeather.results[0].days as number), 0),
				recalculatingDays: recalculating.results[0].days as number,
			},
		};
	}
}

// A stored file of energy totals, as a series per GXP.
async function energy(c: AppContext, resolution: EnergyResolution, period: string) {
	const file = await (await c.env.DATASET.get(energyKey(resolution, period)))?.json<EnergyFile>();
	if (!file) {
		throw new NotFoundException(`No ${resolution} energy for ${period === "all" ? "any year" : period}`);
	}
	// Yesterday's energy changes each time its weather's refreshed, and so do
	// the totals of the periods it's in. Periods before it only change when
	// days in them are estimated again.
	const now = new Date();
	const live = period >= energyPeriod(resolution, previousDate(nzDate(now)));
	cacheUntilStale(c, live ? "currentEnergy" : "history", now);
	const totals = new Map<string, number>();
	for (const point of file.data) {
		for (const [gxp, mwh] of Object.entries(point.gxps)) totals.set(gxp, (totals.get(gxp) ?? 0) + mwh);
	}
	const series = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b));
	return {
		success: true,
		result: {
			series,
			data: file.data.map(({ from, to, days, totalMwh, gxps }) => ({
				from,
				to,
				days,
				totalMwh,
				// A GXP without solar yet had none.
				mwh: series.map((gxp) => gxps[gxp] ?? 0),
			})),
		},
	};
}
