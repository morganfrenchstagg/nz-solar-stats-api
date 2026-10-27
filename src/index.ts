import { ApiException, fromHono } from "chanfana";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { tasksRouter } from "./endpoints/tasks/router";
import { ContentfulStatusCode } from "hono/utils/http-status";
import { DummyEndpoint } from "./endpoints/dummyEndpoint";
import { runWeatherArchiveJob } from "./aggregates/archive";
import { runAggregateJob } from "./aggregates/job";
import { runCapacityJob } from "./capacity/job";
import { solarCapacityRouter } from "./endpoints/solarCapacity/router";
import {
	SolarEnergyAnnual,
	SolarEnergyCoverage,
	SolarEnergyDaily,
	SolarEnergyMonthly,
	SolarEnergyWeekly,
} from "./endpoints/solarEnergy";
import { SolarProductionForDate, SolarProductionToday } from "./endpoints/solarProduction";
import { runProductionJob } from "./production/job";

// Start a Hono app
const app = new Hono<{ Bindings: Env }>();

// Any site can read the API from a browser, but not write to it.
app.use("*", cors({ origin: "*", allowMethods: ["GET", "HEAD", "OPTIONS"] }));

app.onError((err, c) => {
	if (err instanceof ApiException) {
		// If it's a Chanfana ApiException, let Chanfana handle the response
		return c.json(
			{ success: false, errors: err.buildResponse() },
			err.status as ContentfulStatusCode,
		);
	}

	console.error("Global error handler caught:", err); // Log the error if it's not known

	// For other errors, return a generic 500 response
	return c.json(
		{
			success: false,
			errors: [{ code: 7000, message: "Internal Server Error" }],
		},
		500,
	);
});

// Setup OpenAPI registry
const openapi = fromHono(app, {
	docs_url: "/",
	schema: {
		info: {
			title: "NZ Solar Stats API",
			version: "2.0.0",
			description:
				"Distributed solar in New Zealand, per GXP. Capacities are nameplate MW AC from the Electricity Authority registry, not DC MWp.",
		},
	},
});

openapi.route("/solar-capacity", solarCapacityRouter);
openapi.get("/solar-production", SolarProductionToday);
openapi.get("/solar-production/:date", SolarProductionForDate);
openapi.get("/solar-energy", SolarEnergyCoverage);
openapi.get("/solar-energy/daily/:month", SolarEnergyDaily);
openapi.get("/solar-energy/weekly/:year", SolarEnergyWeekly);
openapi.get("/solar-energy/monthly/:year", SolarEnergyMonthly);
openapi.get("/solar-energy/annual", SolarEnergyAnnual);

// Register Tasks Sub router
openapi.route("/tasks", tasksRouter);

// Register other endpoints
openapi.post("/dummy/:slug", DummyEndpoint);

export default {
	fetch: app.fetch,
	// The crons are wrangler.jsonc's.
	async scheduled(controller, env) {
		switch (controller.cron) {
			case "0 18 * * *":
				await runCapacityJob(env);
				break;
			case "*/10 * * * *":
				// As at the time it was due rather than when it started, a few
				// seconds late, so weather that's refreshed every half hour is
				// refreshed on the half hour and not one run later.
				await runProductionJob(env, new Date(controller.scheduledTime));
				break;
			case "5,15,25,35,45,55 * * * *":
				await runAggregateJob(env, new Date(controller.scheduledTime));
				break;
			case "35 10,14 * * *":
				await runWeatherArchiveJob(env, new Date(controller.scheduledTime));
				break;
			default:
				throw new Error(`No job for cron ${controller.cron}`);
		}
	},
} satisfies ExportedHandler<Env>;
