import { z } from "zod";

// The registry records nameplate capacity: the lower of the panels' and the
// inverter's rating. That makes it AC capacity, not DC MWp (Kohirā is 23.7 MW
// here, against 33.3 MWp of panels).
export const capacity = z.object({
	icpCount: z.number().int().describe("ICPs with solar"),
	installedMw: z
		.number()
		.describe(
			"All solar nameplate capacity in the Electricity Authority registry, in MW AC (the lower of the panels' and the inverter's rating, not DC MWp)",
		),
	dispatchedMw: z
		.number()
		.describe(
			"The part of installedMw belonging to solar farms the System Operator dispatches, whose output is already in public generation data. This is their registry nameplate, which can exceed their dispatch capacity.",
		),
	distributedMw: z
		.number()
		.describe("installedMw minus dispatchedMw: solar that isn't counted in public generation data, in MW AC"),
});

export type Capacity = z.infer<typeof capacity>;

// Sums a GXP's NSPs into the fields of `capacity`.
export const capacityColumns = `
	sum(icp_count) AS icpCount,
	round(sum(installed_mw), 3) AS installedMw,
	round(sum(dispatched_mw), 3) AS dispatchedMw,
	round(sum(distributed_mw), 3) AS distributedMw`;
