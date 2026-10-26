const ELECTRICITY_MAP_API = "https://api.electricitymap.frenchsta.gg/v1";

export interface Substation {
	siteId: string;
	description: string;
	type: string;
	island: string;
	lat: number;
	long: number;
}

export interface SolarFarm {
	node: string; // pricing node, e.g. "ISL0661 KPS0"
	name: string;
	capacityMw: number;
	commissioned: string | null;
	location: { lat: number; long: number } | null;
}

interface Generator {
	location?: { lat: number; long: number };
	units: {
		name: string;
		node: string;
		capacity: number;
		fuelCode: string;
		commissioned?: string;
	}[];
}

export async function fetchSubstations(): Promise<Substation[]> {
	return getJson<Substation[]>("/substations");
}

// Solar farms the System Operator dispatches, so their output is already public.
export async function fetchDispatchedSolarFarms(): Promise<SolarFarm[]> {
	const generators = await getJson<Generator[]>("/generators");
	return generators.flatMap((generator) =>
		generator.units
			.filter((unit) => unit.fuelCode === "SOL")
			.map((unit) => ({
				node: unit.node,
				name: unit.name,
				capacityMw: unit.capacity,
				commissioned: unit.commissioned ?? null,
				location: generator.location ?? null,
			})),
	);
}

async function getJson<T>(path: string): Promise<T> {
	const res = await fetch(`${ELECTRICITY_MAP_API}${path}`);
	if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
	return res.json<T>();
}
