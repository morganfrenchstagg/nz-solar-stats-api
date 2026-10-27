import { type GxpCapacities, type GxpCapacityMonth, gxpCapacities, NoCapacityError } from "../production/job";
import { addMonths } from "./periods";

// Every GXP's month-end snapshots, loaded once, so a run can work out the
// capacities on any number of days the way estimateDay does on one.
export class CapacityHistory {
	private constructor(private histories: GxpCapacityMonth[][]) {}

	static async load(db: D1Database): Promise<CapacityHistory> {
		const { results } = await db
			.prepare(
				`SELECT c.gxp, g.name, g.lat, g.long, c.month_end AS monthEnd,
					round(sum(c.distributed_mw), 3) AS distributedMw, round(sum(c.step_mw), 3) AS stepMw
				FROM solar_capacity c JOIN gxps g ON g.site_id = c.gxp
				GROUP BY c.gxp, c.month_end
				ORDER BY c.gxp, c.month_end`,
			)
			.all<GxpCapacityMonth>();
		const histories = new Map<string, GxpCapacityMonth[]>();
		for (const month of results) histories.set(month.gxp, [...(histories.get(month.gxp) ?? []), month]);
		return new CapacityHistory([...histories.values()]);
	}

	// The first month end with any capacity, or null before the capacity job has run.
	get firstMonthEnd(): string | null {
		const firsts = this.histories.map((history) => history[0].monthEnd).sort();
		return firsts[0] ?? null;
	}

	// Each GXP with solar's capacity on the date, or null if none had any.
	on(date: string): GxpCapacities | null {
		const after = addMonths(date, -14);
		const months: GxpCapacityMonth[] = [];
		const farmMw = new Map<string, number>();
		for (const history of this.histories) {
			let steps = 0;
			for (const month of history) {
				if (month.monthEnd > date) break;
				steps += month.stepMw;
				if (month.monthEnd > after) months.push(month);
			}
			farmMw.set(history[0].gxp, steps);
		}
		try {
			return gxpCapacities(months, farmMw, date);
		} catch (error) {
			if (error instanceof NoCapacityError) return null;
			throw error;
		}
	}
}
