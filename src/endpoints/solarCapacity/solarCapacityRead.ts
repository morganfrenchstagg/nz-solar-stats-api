import { contentJson, NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { cacheUntilStale } from "../cacheControl";
import { capacity, capacityColumns } from "./base";

const monthCapacity = capacity.extend({ monthEnd: z.string() });

const dispatchedStep = z.object({
	node: z.string().describe("The farm's pricing node, e.g. ISL0661 KPS0"),
	name: z.string(),
	nsp: z.string(),
	monthEnd: z.string().describe("When this capacity first appeared in EMI"),
	mw: z.number().describe("Registry nameplate capacity that appeared, in MW AC"),
});

export class SolarCapacityRead extends OpenAPIRoute {
	public schema = {
		tags: ["Solar capacity"],
		summary: "Monthly history of solar installed at a GXP",
		request: {
			params: z.object({
				gxp: z
					.string()
					.regex(/^[A-Za-z]{3}$/)
					.describe("GXP site ID, e.g. ISL"),
			}),
		},
		responses: {
			"200": {
				description: "The GXP's solar at each month end since EMI's records began",
				...contentJson({
					success: Boolean,
					result: z.object({
						gxp: z.string(),
						name: z.string().nullable(),
						months: z.array(monthCapacity),
						dispatchedSteps: z
							.array(dispatchedStep)
							.describe("The EMI capacity counted as dispatched solar farms"),
					}),
				}),
			},
			...NotFoundException.schema(),
		},
	};

	public async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();
		const gxp = data.params.gxp.toUpperCase();
		const db = c.env.DB;

		const [name, months, dispatchedSteps] = await Promise.all([
			db.prepare("SELECT name FROM gxps WHERE site_id = ?").bind(gxp).first<string>("name"),
			db
				.prepare(
					`SELECT month_end AS monthEnd, ${capacityColumns}
					FROM solar_capacity WHERE gxp = ?
					GROUP BY month_end ORDER BY month_end`,
				)
				.bind(gxp)
				.all<z.infer<typeof monthCapacity>>(),
			db
				.prepare(
					`SELECT node, name, nsp, month_end AS monthEnd, mw
					FROM dispatched_solar_steps WHERE substr(nsp, 1, 3) = ?
					ORDER BY month_end`,
				)
				.bind(gxp)
				.all<z.infer<typeof dispatchedStep>>(),
		]);
		if (months.results.length === 0) {
			throw new NotFoundException(`No solar capacity for GXP ${gxp}`);
		}

		cacheUntilStale(c, "capacity");
		return {
			success: true,
			result: {
				gxp,
				name,
				months: months.results,
				dispatchedSteps: dispatchedSteps.results,
			},
		};
	}
}
