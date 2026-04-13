const { PLANETS, PLANET_NAMES, longitudeToSign } = require('../utils/zodiac');

let swisseph = null;
let swissEphemerisLoadError = null;

try {
  swisseph = require('swisseph');
  // Use Moshier mode so the native module does not depend on external ephemeris files.
  swisseph.swe_set_ephe_path('');
} catch (error) {
  swissEphemerisLoadError = error;
  console.warn(
    `[Ephemeris] Swiss Ephemeris unavailable, using fallback calculations: ${error.message}`
  );
}

const PLANET_ID_TO_NAME = Object.fromEntries(
  Object.entries(PLANETS).map(([name, id]) => [id, name])
);

const JD_UNIX_EPOCH = 2440587.5;
const J2000 = 2451545.0;
const OBLIQUITY = 23.4393; // Mean obliquity of the ecliptic (degrees)

const FALLBACK_MODELS = {
  Sun: { baseLongitude: 280.46646, dailyMotion: 0.98564736, wobble: 1.2 },
  Moon: { baseLongitude: 218.31643, dailyMotion: 13.17639648, wobble: 4.8 },
  Mercury: { baseLongitude: 252.25084, dailyMotion: 4.09233445, wobble: 6.2 },
  Venus: { baseLongitude: 181.97973, dailyMotion: 1.60213034, wobble: 2.8 },
  Mars: { baseLongitude: 355.433, dailyMotion: 0.52402068, wobble: 4.2 },
  Jupiter: { baseLongitude: 34.35152, dailyMotion: 0.083091, wobble: 1.8 },
  Saturn: { baseLongitude: 50.07744, dailyMotion: 0.03345965, wobble: 1.6 },
  Uranus: { baseLongitude: 314.05501, dailyMotion: 0.01173129, wobble: 1.2 },
  Neptune: { baseLongitude: 304.34867, dailyMotion: 0.00598103, wobble: 1.0 },
  Pluto: { baseLongitude: 238.92903, dailyMotion: 0.003964, wobble: 1.4 },
  // New bodies
  TrueNode: { baseLongitude: 125.04, dailyMotion: -0.05295, wobble: 1.5 },
  Chiron: { baseLongitude: 209.0, dailyMotion: 0.01951, wobble: 2.0 },
  Lilith: { baseLongitude: 83.35, dailyMotion: 0.11140, wobble: 3.0 },
};

const RETROGRADE_MODELS = {
  Mercury: { cycleDays: 116, retrogradeDays: 23, offsetDays: 12 },
  Venus: { cycleDays: 584, retrogradeDays: 42, offsetDays: 36 },
  Mars: { cycleDays: 780, retrogradeDays: 70, offsetDays: 120 },
  Jupiter: { cycleDays: 399, retrogradeDays: 120, offsetDays: 40 },
  Saturn: { cycleDays: 378, retrogradeDays: 138, offsetDays: 52 },
  Uranus: { cycleDays: 370, retrogradeDays: 155, offsetDays: 28 },
  Neptune: { cycleDays: 367, retrogradeDays: 158, offsetDays: 64 },
  Pluto: { cycleDays: 366, retrogradeDays: 180, offsetDays: 10 },
  Chiron: { cycleDays: 370, retrogradeDays: 150, offsetDays: 30 },
};

function normalizeLongitude(longitude) {
  return ((longitude % 360) + 360) % 360;
}

/**
 * Convert a JS Date to Julian Day Number.
 */
function dateToJulianDay(date) {
  return date.getTime() / 86400000 + JD_UNIX_EPOCH;
}

function julianDayToDate(julianDay) {
  return new Date((julianDay - JD_UNIX_EPOCH) * 86400000);
}

function daysSinceJ2000(date) {
  return dateToJulianDay(date) - J2000;
}

function oscillation(days, period, amplitude, phase = 0) {
  return Math.sin(((days + phase) / period) * Math.PI * 2) * amplitude;
}

function fallbackRetrogradeState(planetName, days) {
  // TrueNode always "retrogrades" (mean node regresses)
  if (planetName === 'TrueNode') return true;
  // Lilith does not retrograde
  if (planetName === 'Lilith') return false;

  const model = RETROGRADE_MODELS[planetName];
  if (!model) return false;

  const progress = ((days + model.offsetDays) % model.cycleDays + model.cycleDays) % model.cycleDays;
  return progress < model.retrogradeDays;
}

function calcFallbackPlanetPosition(julianDay, planetId) {
  const planetName = PLANET_ID_TO_NAME[planetId];
  const model = FALLBACK_MODELS[planetName];

  if (!planetName || !model) {
    throw new Error(`Fallback ephemeris has no model for planet ID ${planetId}`);
  }

  const date = julianDayToDate(julianDay);
  const days = daysSinceJ2000(date);
  const wobble = oscillation(days, 27 + planetId * 11, model.wobble, planetId * 9.5);
  const longitude = normalizeLongitude(model.baseLongitude + model.dailyMotion * days + wobble);
  const isRetrograde = fallbackRetrogradeState(planetName, days);
  const speed = (isRetrograde ? -1 : 1) * Math.abs(model.dailyMotion);

  return {
    longitude,
    latitude: 0,
    speed,
    isRetrograde,
    ...longitudeToSign(longitude),
  };
}

/**
 * Calculate position of a single planet at a given Julian Day.
 * Returns longitude, latitude, speed, and retrograde status.
 */
function calcPlanetPosition(julianDay, planetId) {
  if (!swisseph) {
    return calcFallbackPlanetPosition(julianDay, planetId);
  }

  const flags = swisseph.SEFLG_SPEED | swisseph.SEFLG_MOSEPH;
  const result = swisseph.swe_calc_ut(julianDay, planetId, flags);

  if (result.error) {
    // Fall back to mathematical model for bodies that need extra ephemeris files
    const planetName = PLANET_ID_TO_NAME[planetId];
    if (FALLBACK_MODELS[planetName]) {
      console.warn(`[Ephemeris] SwissEph failed for ${planetName}, using fallback: ${result.error}`);
      return calcFallbackPlanetPosition(julianDay, planetId);
    }
    throw new Error(`Ephemeris error for planet ${planetId}: ${result.error}`);
  }

  const longitude = result.longitude;
  const speed = result.longitudeSpeed;
  const isRetrograde = speed < 0;
  const signInfo = longitudeToSign(longitude);

  return {
    longitude,
    latitude: result.latitude,
    speed,
    isRetrograde,
    ...signInfo,
  };
}

/**
 * Calculate all planet positions for a given date/time.
 */
function calcAllPlanets(date) {
  const julianDay = dateToJulianDay(date);
  const positions = {};

  for (const [name, id] of Object.entries(PLANETS)) {
    try {
      positions[name] = calcPlanetPosition(julianDay, id);
    } catch (err) {
      console.warn(`[Ephemeris] Could not calculate ${name}: ${err.message}`);
    }
  }

  return positions;
}

// ─── House System ─────────────────────────────────────────────────────────────

function toRadians(deg) { return deg * Math.PI / 180; }
function toDegrees(rad) { return rad * 180 / Math.PI; }

/**
 * Calculate houses, Ascendant, and MC for a given moment and location.
 * Uses Placidus house system when Swiss Ephemeris is available,
 * falls back to Equal House with approximate Ascendant from LST.
 *
 * @param {number} julianDay
 * @param {number} latitude - Geographic latitude (degrees, north positive)
 * @param {number} longitude - Geographic longitude (degrees, east positive)
 * @returns {{ ascendant: object, mc: object, cusps: number[], houseSystem: string }}
 */
function calcHouses(julianDay, latitude, longitude) {
  if (swisseph) {
    try {
      const result = swisseph.swe_houses(julianDay, latitude, longitude, 'P'); // Placidus
      const ascLon = result.ascendant;
      const mcLon = result.mc;
      // swe_houses returns cusps[0] unused, cusps[1..12] are the 12 house cusps
      const cusps = [];
      for (let i = 1; i <= 12; i++) {
        cusps.push(normalizeLongitude(result.house[i] || result.cusps?.[i] || 0));
      }

      return {
        ascendant: { longitude: ascLon, ...longitudeToSign(ascLon) },
        mc: { longitude: mcLon, ...longitudeToSign(mcLon) },
        cusps,
        houseSystem: 'Placidus',
      };
    } catch (err) {
      console.warn(`[Ephemeris] swe_houses failed, using fallback: ${err.message}`);
    }
  }

  // Fallback: approximate Ascendant from Local Sidereal Time
  return calcFallbackHouses(julianDay, latitude, longitude);
}

function calcFallbackHouses(julianDay, latitude, longitude) {
  // Greenwich Mean Sidereal Time (degrees)
  const T = (julianDay - J2000) / 36525.0;
  let gmst = 280.46061837 + 360.98564736629 * (julianDay - J2000)
    + 0.000387933 * T * T - T * T * T / 38710000.0;
  gmst = normalizeLongitude(gmst);

  // Local Sidereal Time
  const lst = normalizeLongitude(gmst + longitude);
  const lstRad = toRadians(lst);
  const latRad = toRadians(latitude);
  const oblRad = toRadians(OBLIQUITY);

  // Ascendant calculation
  const y = -Math.cos(lstRad);
  const x = Math.sin(lstRad) * Math.cos(oblRad) + Math.tan(latRad) * Math.sin(oblRad);
  let ascLon = normalizeLongitude(toDegrees(Math.atan2(y, x)));

  // MC calculation (Midheaven)
  const mcY = Math.sin(lstRad);
  const mcX = Math.cos(lstRad) * Math.cos(oblRad);
  let mcLon = normalizeLongitude(toDegrees(Math.atan2(mcY, mcX)));

  // Equal House cusps (each house = 30° from Ascendant)
  const cusps = [];
  for (let i = 0; i < 12; i++) {
    cusps.push(normalizeLongitude(ascLon + i * 30));
  }

  return {
    ascendant: { longitude: ascLon, ...longitudeToSign(ascLon) },
    mc: { longitude: mcLon, ...longitudeToSign(mcLon) },
    cusps,
    houseSystem: 'Equal (fallback)',
  };
}

/**
 * Determine which house (1-12) a planet falls in, given the 12 house cusps.
 */
function assignPlanetToHouse(planetLongitude, cusps) {
  const lon = normalizeLongitude(planetLongitude);

  for (let i = 0; i < 12; i++) {
    const cusp = cusps[i];
    const nextCusp = cusps[(i + 1) % 12];

    if (nextCusp > cusp) {
      // Normal case: cusp at 30°, next at 60°
      if (lon >= cusp && lon < nextCusp) return i + 1;
    } else {
      // Wrap-around case: cusp at 350°, next at 20°
      if (lon >= cusp || lon < nextCusp) return i + 1;
    }
  }

  return 1; // fallback
}

/**
 * Calculate Part of Fortune (Pars Fortuna).
 * Day chart: ASC + Moon - Sun
 * Night chart: ASC + Sun - Moon
 */
function calcPartOfFortune(ascendantLon, sunLon, moonLon, isDayChart = true) {
  let lon;
  if (isDayChart) {
    lon = ascendantLon + moonLon - sunLon;
  } else {
    lon = ascendantLon + sunLon - moonLon;
  }
  lon = normalizeLongitude(lon);
  return { longitude: lon, ...longitudeToSign(lon) };
}

/**
 * Determine if the Sun is above the horizon (day chart).
 * Simple check: Sun is above horizon if it's in the upper half of the chart
 * (between Ascendant and Descendant going through MC).
 */
function isDayChart(sunLon, ascendantLon) {
  const dsc = normalizeLongitude(ascendantLon + 180);
  // Sun is above horizon if it goes from ASC counter-clockwise to DSC
  if (dsc > ascendantLon) {
    return sunLon >= ascendantLon && sunLon < dsc;
  } else {
    return sunLon >= ascendantLon || sunLon < dsc;
  }
}

// ─── Natal Chart (expanded) ───────────────────────────────────────────────────

/**
 * Calculate natal chart for a birth date/time, optionally with location for houses.
 *
 * @param {Date} birthDate - UTC Date object
 * @param {number|null} latitude - Birth latitude (optional)
 * @param {number|null} longitude - Birth longitude (optional)
 */
function calcNatalChart(birthDate, latitude = null, longitude = null) {
  const julianDay = dateToJulianDay(birthDate);
  const planets = {};

  for (const [name, id] of Object.entries(PLANETS)) {
    try {
      planets[name] = calcPlanetPosition(julianDay, id);
    } catch (err) {
      console.warn(`[Ephemeris] Could not calculate ${name}: ${err.message}`);
    }
  }

  const result = {
    planets,
    sunSign: planets.Sun?.sign,
    moonSign: planets.Moon?.sign,
    calculatedAt: new Date().toISOString(),
  };

  // Calculate houses and ascendant if location provided
  if (latitude != null && longitude != null) {
    const houses = calcHouses(julianDay, latitude, longitude);
    result.ascendant = houses.ascendant;
    result.mc = houses.mc;
    result.houses = houses.cusps;
    result.houseSystem = houses.houseSystem;

    // Assign each planet to a house
    for (const [name, data] of Object.entries(planets)) {
      if (data && data.longitude != null) {
        data.house = assignPlanetToHouse(data.longitude, houses.cusps);
      }
    }

    // Part of Fortune
    if (planets.Sun && houses.ascendant && planets.Moon) {
      const dayChart = isDayChart(planets.Sun.longitude, houses.ascendant.longitude);
      result.partOfFortune = calcPartOfFortune(
        houses.ascendant.longitude,
        planets.Sun.longitude,
        planets.Moon.longitude,
        dayChart
      );
    }

    // Rising sign convenience field
    result.ascendantSign = houses.ascendant.sign;
  }

  return result;
}

/**
 * Calculate current transits (planet positions right now).
 */
function calcCurrentTransits() {
  return calcAllPlanets(new Date());
}

/**
 * Get retrograde planets for a given date.
 */
function getRetrogradePlanets(date = new Date()) {
  const positions = calcAllPlanets(date);
  const retrogrades = [];

  for (const [name, data] of Object.entries(positions)) {
    if (data && data.isRetrograde) {
      retrogrades.push({ planet: name, sign: data.sign, degree: data.degree });
    }
  }

  return retrogrades;
}

module.exports = {
  dateToJulianDay,
  calcPlanetPosition,
  calcAllPlanets,
  calcNatalChart,
  calcCurrentTransits,
  getRetrogradePlanets,
};
