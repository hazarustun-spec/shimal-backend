// Astrological aspects — major and minor
const ASPECTS = [
  // Major aspects
  { name: 'Conjunction',     angle: 0,   orb: 8,  symbol: '☌', nature: 'major' },
  { name: 'Sextile',         angle: 60,  orb: 6,  symbol: '⚹', nature: 'harmonious' },
  { name: 'Square',          angle: 90,  orb: 7,  symbol: '□', nature: 'challenging' },
  { name: 'Trine',           angle: 120, orb: 8,  symbol: '△', nature: 'harmonious' },
  { name: 'Quincunx',        angle: 150, orb: 3,  symbol: '⚻', nature: 'adjustment' },
  { name: 'Opposition',      angle: 180, orb: 8,  symbol: '☍', nature: 'challenging' },
  // Minor aspects
  { name: 'Semi-sextile',    angle: 30,  orb: 2,  symbol: '⚺', nature: 'subtle' },
  { name: 'Semi-square',     angle: 45,  orb: 2,  symbol: '∠', nature: 'friction' },
  { name: 'Sesquiquadrate',  angle: 135, orb: 2,  symbol: '⚼', nature: 'tension' },
];

/**
 * Calculate the shortest angular distance between two ecliptic longitudes
 */
function angularDistance(lon1, lon2) {
  let diff = Math.abs(lon1 - lon2) % 360;
  if (diff > 180) diff = 360 - diff;
  return diff;
}

/**
 * Find the aspect between two planet positions, if any.
 * Returns null if no aspect within orb.
 *
 * @param {string} planet1 - Name of first planet
 * @param {number} lon1 - Longitude of first planet
 * @param {string} planet2 - Name of second planet
 * @param {number} lon2 - Longitude of second planet
 * @param {number|null} speed1 - Speed of first planet (degrees/day), optional
 * @param {number|null} speed2 - Speed of second planet (degrees/day), optional
 */
function findAspect(planet1, lon1, planet2, lon2, speed1 = null, speed2 = null) {
  const dist = angularDistance(lon1, lon2);

  for (const aspect of ASPECTS) {
    const deviation = Math.abs(dist - aspect.angle);
    if (deviation <= aspect.orb) {
      // Determine applying/separating
      let applying = deviation < aspect.orb / 2; // default heuristic

      if (speed1 !== null && speed2 !== null) {
        // Proper detection: if the angular distance is shrinking, it's applying
        // Calculate what distance would be a tiny time later
        const futureLon1 = lon1 + speed1 * 0.01; // 0.01 day later
        const futureLon2 = lon2 + speed2 * 0.01;
        const futureDist = angularDistance(futureLon1, futureLon2);
        const futureDeviation = Math.abs(futureDist - aspect.angle);
        applying = futureDeviation < deviation;
      }

      return {
        planet1,
        planet2,
        aspect: aspect.name,
        symbol: aspect.symbol,
        nature: aspect.nature,
        exactAngle: aspect.angle,
        actualAngle: dist,
        orb: Math.round(deviation * 100) / 100,
        applying,
      };
    }
  }

  return null;
}

/**
 * Find all aspects between two sets of planet positions
 * (e.g., transit planets vs natal planets)
 */
function findAllAspects(transitPositions, natalPositions) {
  const aspects = [];

  for (const [tPlanet, tData] of Object.entries(transitPositions)) {
    const tLon = typeof tData === 'number' ? tData : tData.longitude || tData;
    const tSpeed = (typeof tData === 'object' && tData.speed) ? tData.speed : null;

    for (const [nPlanet, nData] of Object.entries(natalPositions)) {
      const nLon = typeof nData === 'number' ? nData : nData.longitude || nData;
      const nSpeed = (typeof nData === 'object' && nData.speed) ? nData.speed : null;

      const aspect = findAspect(
        `Transit ${tPlanet}`, tLon,
        `Natal ${nPlanet}`, nLon,
        tSpeed, nSpeed
      );
      if (aspect) {
        aspects.push(aspect);
      }
    }
  }

  return aspects;
}

/**
 * Find all aspects between natal planets (within a single chart).
 * Checks all unique planet pairs.
 *
 * @param {object} planets - { Sun: { longitude, speed, ... }, Moon: { ... }, ... }
 * @returns {Array} aspects sorted by orb (tightest first)
 */
function findNatalAspects(planets) {
  const aspects = [];
  const names = Object.keys(planets);

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const p1 = names[i];
      const p2 = names[j];
      const d1 = planets[p1];
      const d2 = planets[p2];

      if (!d1 || !d2 || d1.longitude == null || d2.longitude == null) continue;

      const aspect = findAspect(
        p1, d1.longitude,
        p2, d2.longitude,
        d1.speed || null, d2.speed || null
      );
      if (aspect) {
        aspects.push(aspect);
      }
    }
  }

  // Sort by tightness (smallest orb first)
  aspects.sort((a, b) => a.orb - b.orb);
  return aspects;
}

module.exports = { findAspect, findAllAspects, findNatalAspects };
