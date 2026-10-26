import { contentJson, NotFoundException, OpenAPIRoute } from "chanfana";
import { z } from "zod";
import { AppContext } from "../../types";
import { type Capacity, capacity, capacityColumns } from "./base";

const gxpCapacity = capacity.extend({
	gxp: z.string(),
	name: z.string().nullable(),
});

export class SolarCapacityList extends OpenAPIRoute {
	public schema = {
		tags: ["Solar capacity"],
		summary: "Solar installed at every GXP at a month end",
		request: {
			query: z.object({
				month: z
					.string()
					.regex(/^\d{4}-\d{2}$/)
					.optional()
					.describe("YYYY-MM. Defaults to the latest month EMI has published."),
			}),
		},
		responses: {
			"200": {
				description: "Every GXP with solar, most distributed solar first",
				...contentJson({
					success: Boolean,
					result: z.object({
						monthEnd: z.string(),
						total: capacity,
						gxps: z.array(gxpCapacity),
					}),
				}),
			},
			...NotFoundException.schema(),
		},
	};

	public async handle(c: AppContext) {
		const data = await this.getValidatedData<typeof this.schema>();

		// With no month given, the LIKE pattern is "%" and matches the latest.
		const { results } = await c.env.DB.prepare(
			`SELECT c.month_end AS monthEnd, c.gxp, g.name, ${capacityColumns}
			FROM solar_capacity c LEFT JOIN gxps g ON g.site_id = c.gxp
			WHERE c.month_end = (SELECT max(month_end) FROM solar_capacity WHERE month_end LIKE ?)
			GROUP BY c.gxp
			ORDER BY distributedMw DESC`,
		)
			.bind(`${data.query.month ?? ""}%`)
			.all<z.infer<typeof gxpCapacity> & { monthEnd: string }>();
		if (results.length === 0) {
			throw new NotFoundException("No solar capacity for that month");
		}

		return {
			success: true,
			result: {
				monthEnd: results[0].monthEnd,
				total: sumCapacity(results),
				gxps: results.map(({ monthEnd, ...gxp }) => gxp),
			},
		};
	}
}

function sumCapacity(rows: Capacity[]): Capacity {
	const sum = (field: keyof Capacity) =>
		Math.round(rows.reduce((total, row) => total + row[field], 0) * 1000) / 1000;
	return {
		icpCount: sum("icpCount"),
		installedMw: sum("installedMw"),
		dispatchedMw: sum("dispatchedMw"),
		distributedMw: sum("distributedMw"),
		stepMw: sum("stepMw"),
	};
}
