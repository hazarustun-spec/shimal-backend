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
  const speed = (isRetrograde ? -1 : 1) * model.dailyMotion;

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
    positions[name] = calcPlanetPosition(julianDay, id);
  }

  return positions;
}

/**
 * Calculate natal chart for a birth date/time.
 */
function calcNatalChart(birthDate) {
  const planets = calcAllPlanets(birthDate);

  return {
    planets,
    sunSign: planets.Sun.sign,
    moonSign: planets.Moon.sign,
    mercurySign: planets.Mercury.sign,
    venusSign: planets.Venus.sign,
    marsSign: planets.Mars.sign,
    calculatedAt: new Date().toISOString(),
  };
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
    if (data.isRetrograde) {
      retrogrades.push({ planet: name, sign: data.sign, degree: data.degree });
    }
  }

  return retrogrades;
}

function getEphemerisStatus() {
  return {
    mode: swisseph ? 'swisseph' : 'fallback',
    loadError: swissEphemerisLoadError ? swissEphemerisLoadError.message : null,
  };
}

module.exports = {
  dateToJulianDay,
  calcPlanetPosition,
  calcAllPlanets,
  calcNatalChart,
  calcCurrentTransits,
  getRetrogradePlanets,
  getEphemerisStatus,
};
