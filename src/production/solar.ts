// Where the sun is, and how much of the sky's light lands on a panel facing
// any way. Kept free of imports so the backtest scripts can run it under Node
// too.

const RADIANS = Math.PI / 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const J2000_MS = Date.UTC(2000, 0, 1, 12);
const SOLAR_CONSTANT_WM2 = 1361;
// Grass and roads reflect about a fifth of the light that reaches them.
const GROUND_ALBEDO = 0.2;
// Below this the sun's direct light along a panel is too oblique to trust.
const MIN_COS_ZENITH = Math.cos(85 * RADIANS);

// Sunlight at an instant: on flat ground, straight from the sun, and from the
// rest of the sky.
export interface Sky {
	ghiWm2: number; // global horizontal
	dniWm2: number; // direct normal
	dhiWm2: number; // diffuse horizontal
}

export interface Sun {
	elevationDeg: number;
	azimuthDeg: number; // compass bearing: 0° north, 90° east
	extraterrestrialWm2: number; // above the atmosphere, facing the sun
}

export interface Facing {
	tiltDeg: number;
	azimuthDeg: number; // compass bearing the panel faces
}

// The sun's position from an observer's latitude and longitude, accurate to
// about a hundredth of a degree this century (the Astronomical Almanac's
// low-precision formulae).
export function sunAt(time: number, lat: number, long: number): Sun {
	const days = (time - J2000_MS) / DAY_MS;
	const meanAnomaly = (357.529 + 0.98560028 * days) * RADIANS;
	const meanLongitude = 280.459 + 0.98564736 * days;
	const eclipticLongitude =
		(meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RADIANS;
	const obliquity = (23.439 - 0.00000036 * days) * RADIANS;
	const rightAscension = Math.atan2(
		Math.cos(obliquity) * Math.sin(eclipticLongitude),
		Math.cos(eclipticLongitude),
	);
	const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
	const siderealHours = 18.697374558 + 24.06570982441908 * days;
	const hourAngle = (siderealHours * 15 + long) * RADIANS - rightAscension;

	const latitude = lat * RADIANS;
	const elevation = Math.asin(
		Math.sin(latitude) * Math.sin(declination) +
			Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
	);
	const azimuth = Math.atan2(
		-Math.sin(hourAngle),
		Math.tan(declination) * Math.cos(latitude) - Math.sin(latitude) * Math.cos(hourAngle),
	);
	return {
		elevationDeg: elevation / RADIANS,
		azimuthDeg: (azimuth / RADIANS + 360) % 360,
		// The Earth is nearest the sun in early January.
		extraterrestrialWm2: SOLAR_CONSTANT_WM2 * (1 + 0.033 * Math.cos(meanAnomaly)),
	};
}

// Irradiance on a tilted panel, by the Hay–Davies model: the direct beam at
// its angle to the panel, the diffuse light split between a part around the
// sun (in proportion to how clear it is) and an even sky, and some light off
// the ground.
export function planeOfArrayWm2(sky: Sky, sun: Sun, facing: Facing): number {
	const tilt = facing.tiltDeg * RADIANS;
	const sunUp = sun.elevationDeg > 0;
	const cosZenith = Math.sin(sun.elevationDeg * RADIANS);
	const cosIncidence = sunUp
		? Math.max(
				cosZenith * Math.cos(tilt) +
					Math.cos(sun.elevationDeg * RADIANS) *
						Math.sin(tilt) *
						Math.cos((sun.azimuthDeg - facing.azimuthDeg) * RADIANS),
				0,
			)
		: 0;
	const direct = sunUp ? Math.max(sky.dniWm2, 0) : 0;
	const anisotropy = Math.min(direct / sun.extraterrestrialWm2, 1);
	const beamRatio = cosIncidence / Math.max(cosZenith, MIN_COS_ZENITH);

	const beam = direct * cosIncidence;
	const diffuse = Math.max(sky.dhiWm2, 0) * (anisotropy * beamRatio + (1 - anisotropy) * ((1 + Math.cos(tilt)) / 2));
	const ground = Math.max(sky.ghiWm2, 0) * GROUND_ALBEDO * ((1 - Math.cos(tilt)) / 2);
	return beam + diffuse + ground;
}
