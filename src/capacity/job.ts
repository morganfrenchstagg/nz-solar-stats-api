import {
	attributeStepsToFarms,
	findCapacitySteps,
	type FarmStep,
} from "./dispatchedSolar";
import { fetchDispatchedSolarFarms, fetchSubstations } from "./electricityMap";
import { type EmiSolarRow, fetchEmiSolarCapacity } from "./emi";

// D1 limits the size of a single value, so big inserts are split up.
const INSERT_CHUNK_ROWS = 1000;

export interface CapacityJobResult {
	latestMonthEnd: string;
	changed: boolean;
	farmSteps: FarmStep[];
	farmsNotInEmi: string[];
}

// Rebuilds the installed solar capacity history for every GXP, separating out
// the dispatched solar farms that EMI's distributed generation figures include.
export async function runCapacityJob(
	env: Env,
	now = new Date(),
): Promise<CapacityJobResult> {
	const [emiRows, substations, farms] = await Promise.all([
		fetchEmiSolarCapacity(now),
		fetchSubstations(),
		fetchDispatchedSolarFarms(),
	]);
	// Every table gets replaced, so don't trust an empty upstream response.
	if (emiRows.length === 0 || substations.length === 0 || farms.length === 0) {
		throw new Error(
			`Refusing to update from empty source data (EMI rows: ${emiRows.length}, substations: ${substations.length}, solar farms: ${farms.length})`,
		);
	}

	const latestMonthEnd = emiRows.reduce(
		(latest, row) => (row.monthEnd > latest ? row.monthEnd : latest),
		"",
	);
	// Retired NSPs from years ago are expected; a current one means a missing GXP.
	const siteIds = new Set(substations.map((substation) => substation.siteId));
	const unknownNsps = emiRows
		.filter((row) => row.monthEnd === latestMonthEnd && !siteIds.has(row.nsp.slice(0, 3)))
		.map((row) => row.nsp);
	if (unknownNsps.length > 0) {
		console.warn(`EMI NSPs with no matching GXP: ${unknownNsps.join(", ")}`);
	}

	const farmSteps = attributeStepsToFarms(findCapacitySteps(emiRows), farms);
	const farmsNotInEmi = farms
		.filter((farm) => !farmSteps.some((step) => step.node === farm.node))
		.map((farm) => farm.name);

	const gxpRows = substations.map((s) => [s.siteId, s.description, s.type, s.island, s.lat, s.long]);
	const capacityRows = emiRows.map((row) => [
		row.nsp,
		row.nsp.slice(0, 3),
		row.monthEnd,
		row.icpCount,
		row.capacityMw,
		dispatchedMw(farmSteps, row),
	]);
	const stepRows = farmSteps.map((s) => [s.node, s.name, s.nsp, s.monthEnd, s.mw]);

	// EMI only publishes monthly, so most days there is nothing new to write.
	const fingerprint = await sha256(JSON.stringify([gxpRows, capacityRows, stepRows]));
	const previous = await env.DB.prepare(
		"SELECT fingerprint FROM capacity_job_runs ORDER BY id DESC LIMIT 1",
	).first<string>("fingerprint");
	const changed = fingerprint !== previous;

	const db = env.DB;
	const recordRun = db
		.prepare(
			"INSERT INTO capacity_job_runs (ran_at, latest_month_end, fingerprint, changed) VALUES (?, ?, ?, ?)",
		)
		.bind(now.toISOString(), latestMonthEnd, fingerprint, changed ? 1 : 0);
	if (changed) {
		// A batch is one transaction, so readers never see a half-written history.
		await db.batch([
			db.prepare("DELETE FROM gxps"),
			...insertRows(db, "gxps", ["site_id", "name", "type", "island", "lat", "long"], gxpRows),
			db.prepare("DELETE FROM solar_capacity"),
			...insertRows(
				db,
				"solar_capacity",
				["nsp", "gxp", "month_end", "icp_count", "installed_mw", "dispatched_mw"],
				capacityRows,
			),
			db.prepare("DELETE FROM dispatched_solar_steps"),
			...insertRows(
				db,
				"dispatched_solar_steps",
				["node", "name", "nsp", "month_end", "mw"],
				stepRows,
			),
			recordRun,
		]);
	} else {
		await recordRun.run();
	}

	const result = { latestMonthEnd, changed, farmSteps, farmsNotInEmi };
	console.log(JSON.stringify({ message: "Capacity job finished", ...result }));
	return result;
}

// The dispatched farm capacity included in an NSP's EMI total for that month.
function dispatchedMw(farmSteps: FarmStep[], row: EmiSolarRow): number {
	const mw = farmSteps
		.filter((step) => step.nsp === row.nsp && step.monthEnd <= row.monthEnd)
		.reduce((sum, step) => sum + step.mw, 0);
	return Math.round(mw * 1000) / 1000;
}

// Rows go in as one JSON parameter per chunk, expanded by SQLite, which gets
// around D1's limit of 100 bound parameters per statement.
function insertRows(
	db: D1Database,
	table: string,
	columns: string[],
	rows: unknown[][],
): D1PreparedStatement[] {
	const values = columns.map((_, index) => `value ->> ${index}`).join(", ");
	const sql = `INSERT INTO ${table} (${columns.join(", ")}) SELECT ${values} FROM json_each(?)`;
	const statements: D1PreparedStatement[] = [];
	for (let start = 0; start < rows.length; start += INSERT_CHUNK_ROWS) {
		const chunk = rows.slice(start, start + INSERT_CHUNK_ROWS);
		statements.push(db.prepare(sql).bind(JSON.stringify(chunk)));
	}
	return statements;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
