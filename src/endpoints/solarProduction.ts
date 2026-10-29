import { contentJson, NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { tenMinuteKey } from "../aggregates/store";
import { estimateKey } from "../production/job";
import { nzDate, previousDate } from "../production/weather";
import { AppContext } from "../types";
import { cacheUntilStale } from "./cacheControl";

const production = z.object({
	distributedMw: z
		.number()
		.describe("Distributed solar capacity estimated for the date, in MW AC: the capacityMonthEnd snapshot plus recent growth since"),
	farmMw: z
		.number()
		.describe(
			"The part of distributedMw that arrived in farm-sized steps (solar farms too small to be dispatched), modelled as farms rather than rooftops",
		),
	productionMw: z
		.number()
		.nullable()
		.describe("Estimated output at time, when the estimate was made, in MW AC. Null for other days."),
	profileMw: z.array(z.number()).describe("Estimated output at each of profileTimes, in MW AC"),
});

const gxpProduction = production.extend({
	gxp: z.string(),
	name: z.string(),
	irradianceWm2: z
		.number()
		.nullable()
		.describe("Irradiance on the average rooftop panel at time. Null for other days."),
	temperatureC: z.number().nullable().describe("Air temperature at time. Null for other days."),
	growthMwPerMonth: z
		.number()
		.describe(
			"Recent growth in distributed capacity, MW a month: a weighted average of month-on-month changes (each counting half as much as one three months newer), leaving out farm-sized one-offs",
		),
});

const description =
	"A scheduled job estimates yesterday and today every 10 minutes and stores each NZ date's estimate as a file; this serves the latest. Each GXP's rooftop solar is modelled as arrays tilted 20° facing the ways NZ roofs do (61% north, 19% north-east or north-west, 20% east or west), converting dim light less efficiently, as fitted to NZ rooftop systems on PVOutput. Farm-sized steps in its capacity, solar farms too small to be dispatched, are modelled as a fixed north-facing farm. Weather is taken where its customers live (from Kontur's population grid) rather than at the substation. Direct and diffuse sunlight are from Himawari satellite readings (averaged over the GXP's most-populated pixels, by population) every 10 minutes for any time that has already happened, and Open-Meteo's forecast after that (hourly, interpolated), and are worked onto each array's panels; temperature is from the forecast.";

const responses = {
	"200": {
		description: "Every GXP with distributed solar, largest first",
		...contentJson({
			success: Boolean,
			result: z.object({
				time: z.string().describe("When the estimate was made"),
				date: z.string().describe("The NZ date estimated"),
				capacityMonthEnd: z.string().describe("The latest month-end snapshot the capacities are grown from"),
				weatherFetchedAt: z.string(),
				observedUntil: z
					.string()
					.nullable()
					.describe("Irradiance up to this instant is from satellite readings, after it from the forecast"),
				attribution: z.string(),
				profileTimes: z.array(z.string()).describe("The day's 10-minute instants, in UTC"),
				total: production,
				gxps: z.array(gxpProduction),
			}),
		}),
	},
	...NotFoundException.schema(),
};

export class SolarProductionToday extends OpenAPIRoute {
	public schema = {
		tags: ["Solar production"],
		summary: "Latest estimate of distributed solar output at every GXP today",
		description,
		responses,
	};

	public async handle(c: AppContext) {
		return storedEstimate(c, "today");
	}
}

export class SolarProductionForDate extends OpenAPIRoute {
	public schema = {
		tags: ["Solar production"],
		summary: "Estimate of distributed solar output at every GXP on an NZ date",
		description: `${description} Days before yesterday are backfilled from July 2015 (when the satellite's readings start), and estimated again whenever the model, their capacities or their weather change; days the production job didn't see take their temperature from Copernicus ERA5. Future days have none. Capacities are as at the last month end on or before the date, plus growth since, and only today has live values.`,
		request: {
			params: z.object({
				date: z
					.string()
					.regex(/^(today|yesterday|\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01]))$/)
					.describe("An NZ date as YYYY-MM-DD, or today or yesterday"),
			}),
		},
		responses,
	};

	public async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		return storedEstimate(c, data.params.date);
	}
}

// The day's estimate as the production job last stored it, or for a day
// it's done with, as the aggregate job did: that's estimated again whenever
// the model changes, and goes back before the production job started.
async function storedEstimate(c: AppContext, requested: string) {
	const now = new Date();
	const today = nzDate(now);
	const yesterday = previousDate(today);
	const date = requested === "today" ? today : requested === "yesterday" ? yesterday : requested;
	const live = date >= yesterday;
	const keys = live ? [estimateKey(date), tenMinuteKey(date)] : [tenMinuteKey(date), estimateKey(date)];
	for (const key of keys) {
		const stored = await c.env.DATASET.get(key);
		if (stored) {
			cacheUntilStale(c, live ? "production" : "history", now);
			return { success: true, result: await stored.json() };
		}
	}
	throw new NotFoundException(`No estimate for ${date}`);
}
