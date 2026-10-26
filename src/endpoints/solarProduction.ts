import { ApiException, contentJson, NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { capacityAt, type CapacityMonth } from "../production/capacity";
import { estimateProduction, round } from "../production/estimate";
import { gxpWeatherPoints, POPULATION_SOURCE } from "../production/locations";
import {
	getWeather,
	nzDate,
	previousDate,
	WeatherFetchError,
	WeatherUnavailableError,
} from "../production/weather";
import { AppContext } from "../types";

// Open-Meteo failed or sent incomplete weather; the request can be retried.
class BadGatewayException extends ApiException {
	isVisible = true;
	default_message = "Bad Gateway";
	status = 502;
	code = 7003;
}

const production = z.object({
	distributedMw: z
		.number()
		.describe("Distributed solar capacity estimated for the date, in MW AC: the capacityMonthEnd snapshot plus recent growth since"),
	productionMw: z.number().nullable().describe("Estimated output now, in MW AC. Null for other days."),
	profileMw: z.array(z.number()).describe("Estimated output at each of profileTimes, in MW AC"),
});

const gxpProduction = production.extend({
	gxp: z.string(),
	name: z.string(),
	irradianceWm2: z
		.number()
		.nullable()
		.describe("Irradiance now on a north-facing panel tilted 20°. Null for other days."),
	temperatureC: z.number().nullable().describe("Air temperature now. Null for other days."),
	growthMwPerMonth: z
		.number()
		.describe(
			"Recent growth in distributed capacity, MW a month: a weighted average of month-on-month changes (each counting half as much as one three months newer), leaving out farm-sized one-offs",
		),
});

const description =
	"A first-cut model. Each GXP's distributed solar is treated as one north-facing array tilted 20°, with weather taken where its customers live (from Kontur's population grid) rather than at the substation. Irradiance is from Himawari satellite readings (averaged over the GXP's most-populated pixels, by population) for any time that has already happened, and Open-Meteo's 15-minute forecast after that; temperature is from the forecast.";

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
				profileTimes: z.array(z.string()).describe("The day's 15-minute instants, in UTC"),
				total: production,
				gxps: z.array(gxpProduction),
			}),
		}),
	},
	...NotFoundException.schema(),
	...BadGatewayException.schema(),
};

export class SolarProductionToday extends OpenAPIRoute {
	public schema = {
		tags: ["Solar production"],
		summary: "Live estimate of distributed solar output at every GXP today",
		description,
		responses,
	};

	public async handle(c: AppContext) {
		return estimateDay(c.env.DB, "today");
	}
}

export class SolarProductionForDate extends OpenAPIRoute {
	public schema = {
		tags: ["Solar production"],
		summary: "Estimate of distributed solar output at every GXP on an NZ date",
		description: `${description} Dates can be from about three months ago to two weeks ahead, as far as Open-Meteo has weather. Capacities are as at the last month end on or before the date, and only today has live values.`,
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
		return estimateDay(c.env.DB, data.params.date);
	}
}

async function estimateDay(db: D1Database, requested: string) {
	const now = new Date();
	const today = nzDate(now);
	const date =
		requested === "today" ? today : requested === "yesterday" ? previousDate(today) : requested;
	const isToday = date === today;

	// Each GXP's recent month-end snapshots: its capacity on the date is the
	// latest plus growth since at its recent rate (see production/capacity.ts).
	const { results: months } = await db
		.prepare(
			`SELECT c.gxp, g.name, g.lat, g.long, c.month_end AS monthEnd,
				round(sum(c.distributed_mw), 3) AS distributedMw, round(sum(c.step_mw), 3) AS stepMw
			FROM solar_capacity c JOIN gxps g ON g.site_id = c.gxp
			WHERE c.month_end <= ?1 AND c.month_end > date(?1, '-14 months')
			GROUP BY c.gxp, c.month_end
			ORDER BY c.gxp, c.month_end`,
		)
		.bind(date)
		.all<CapacityMonth & { gxp: string; name: string; lat: number; long: number }>();
	const capacityMonthEnd = months.reduce((latest, month) => (month.monthEnd > latest ? month.monthEnd : latest), "");
	const histories = new Map<string, typeof months>();
	for (const month of months) histories.set(month.gxp, [...(histories.get(month.gxp) ?? []), month]);
	const gxps = [...histories.values()]
		// A GXP missing from the latest snapshot has left EMI's data.
		.filter((history) => history[history.length - 1].monthEnd === capacityMonthEnd)
		.map((history) => {
			const { gxp, name, lat, long } = history[0];
			const estimate = capacityAt(history, date)!;
			return { gxp, name, lat, long, distributedMw: round(estimate.capacityMw), growthMwPerMonth: round(estimate.growthMwPerMonth) };
		})
		.filter((gxp) => gxp.distributedMw > 0)
		.sort((a, b) => b.distributedMw - a.distributedMw);
	if (gxps.length === 0) {
		throw new NotFoundException(`No solar capacity as at ${date}`);
	}

	let weather;
	try {
		weather = await getWeather(
			db,
			gxps.map(({ gxp, lat, long, distributedMw }) => ({ id: gxp, ...gxpWeatherPoints(gxp, { lat, long }, distributedMw) })),
			date,
			now,
		);
	} catch (error) {
		if (error instanceof WeatherUnavailableError) throw new NotFoundException(error.message);
		if (error instanceof WeatherFetchError) throw new BadGatewayException(error.message);
		throw error;
	}
	const estimates = estimateProduction(
		gxps.map(({ gxp, name, distributedMw }) => ({ gxp, name, distributedMw })),
		weather,
		isToday ? now : null,
	);
	const sum = (values: number[]) => round(values.reduce((total, value) => total + value, 0));

	return {
		success: true,
		result: {
			time: now.toISOString(),
			date,
			capacityMonthEnd,
			weatherFetchedAt: weather.fetchedAt,
			observedUntil: weather.observedUntil === null ? null : new Date(weather.observedUntil).toISOString(),
			attribution: `Weather data by Open-Meteo.com (CC BY 4.0); satellite data from JMA/JAXA Himawari; population from ${POPULATION_SOURCE}`,
			profileTimes: weather.times.map((time) => new Date(time).toISOString()),
			total: {
				distributedMw: sum(estimates.map((estimate) => estimate.distributedMw)),
				productionMw: isToday ? sum(estimates.map((estimate) => estimate.productionMw ?? 0)) : null,
				profileMw: weather.times.map((_, index) =>
					sum(estimates.map((estimate) => estimate.profileMw[index])),
				),
			},
			gxps: estimates.map((estimate, i) => ({ ...estimate, growthMwPerMonth: gxps[i].growthMwPerMonth })),
		},
	};
}
