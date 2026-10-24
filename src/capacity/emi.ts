// Installed distributed generation trends report from the Electricity Authority's EMI.
const EMI_REPORT_URL =
	"https://www.emi.ea.govt.nz/Retail/Download/DataReport/CSV/GUEHMT";

export interface EmiSolarRow {
	nsp: string; // root NSP, e.g. ISL0661ORONGN
	monthEnd: string; // YYYY-MM-DD
	icpCount: number;
	capacityMw: number;
	newInstallAvgKw: number | null; // null when there were no new installations
}

export async function fetchEmiSolarCapacity(now: Date): Promise<EmiSolarRow[]> {
	const params = new URLSearchParams({
		DateFrom: "20130101", // earlier than EMI's first month, so we get all of it
		DateTo: now.toISOString().slice(0, 10).replaceAll("-", ""),
		RegionType: "NSP_ROOT",
		MarketSegment: "All",
		FuelType: "solar_all",
	});
	const res = await fetch(`${EMI_REPORT_URL}?${params}`);
	if (!res.ok) throw new Error(`EMI report request failed: ${res.status}`);
	return parseEmiCsv(await res.text());
}

export function parseEmiCsv(csv: string): EmiSolarRow[] {
	// The data is preceded by a block describing the report parameters.
	const lines = csv.split(/\r?\n/);
	const headerAt = lines.findIndex((line) => line.startsWith("Month end,"));
	if (headerAt === -1) throw new Error("EMI CSV has no 'Month end' header");

	const header = lines[headerAt].split(",");
	const column = (name: string) => {
		const index = header.indexOf(name);
		if (index === -1) throw new Error(`EMI CSV has no '${name}' column`);
		return index;
	};
	const monthEnd = column("Month end");
	const nsp = column("Region ID");
	const icpCount = column("ICP count");
	const capacityMw = column("Total capacity installed (MW)");
	const newInstallAvgKw = column("Avg. capacity - new installations (kW)");

	return lines
		.slice(headerAt + 1)
		.filter((line) => line.trim() !== "")
		.map((line) => {
			const cells = line.split(",");
			const [day, month, year] = cells[monthEnd].split("/");
			return {
				nsp: cells[nsp],
				monthEnd: `${year}-${month}-${day}`,
				icpCount: Number(cells[icpCount]),
				capacityMw: Number(cells[capacityMw]),
				newInstallAvgKw:
					cells[newInstallAvgKw] === "" ? null : Number(cells[newInstallAvgKw]),
			};
		});
}
