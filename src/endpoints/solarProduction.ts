import { contentJson, NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { estimateKey } from "../production/job";
import { nzDate, previousDate } from "../production/weather";
import { AppContext } from "../types";

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
		return storedEstimate(c.env.DATASET, "today");
	}
}

export class SolarProductionForDate extends OpenAPIRoute {
	public schema = {
		tags: ["Solar production"],
		summary: "Estimate of distributed solar output at every GXP on an NZ date",
		description: `${description} Every day's estimate is kept, from when the job started up to today; future days have none. Capacities are as at the last month end on or before the date, and only today has live values.`,
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
		return storedEstimate(c.env.DATASET, data.params.date);
	}
}

// The day's estimate as the production job last stored it.
async function storedEstimate(bucket: R2Bucket, requested: string) {
	const today = nzDate(new Date());
	const date =
		requested === "today" ? today : requested === "yesterday" ? previousDate(today) : requested;
	const stored = await bucket.get(estimateKey(date));
	if (!stored) {
		throw new NotFoundException(`No estimate for ${date}`);
	}
	return { success: true, result: await stored.json() };
}
