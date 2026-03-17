// Major aspects in astrology and their angular separations
const ASPECTS = [
  { name: 'Conjunction', angle: 0,   orb: 8,  symbol: '☌', nature: 'major' },
  { name: 'Sextile',    angle: 60,  orb: 6,  symbol: '⚹', nature: 'harmonious' },
  { name: 'Square',     angle: 90,  orb: 7,  symbol: '□', nature: 'challenging' },
  { name: 'Trine',      angle: 120, orb: 8,  symbol: '△', nature: 'harmonious' },
  { name: 'Opposition', angle: 180, orb: 8,  symbol: '☍', nature: 'challenging' },
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
 * Find the aspect between two planet positions, if any
 * Returns null if no aspect within orb
 */
function findAspect(planet1, lon1, planet2, lon2) {
  const dist = angularDistance(lon1, lon2);

  for (const aspect of ASPECTS) {
    const deviation = Math.abs(dist - aspect.angle);
    if (deviation <= aspect.orb) {
      return {
        planet1,
        planet2,
        aspect: aspect.name,
        symbol: aspect.symbol,
        nature: aspect.nature,
        exactAngle: aspect.angle,
        actualAngle: dist,
        orb: Math.round(deviation * 100) / 100,
        applying: deviation < aspect.orb / 2, // rough approximation
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

  for (const [tPlanet, tLon] of Object.entries(transitPositions)) {
    for (const [nPlanet, nData] of Object.entries(natalPositions)) {
      const nLon = typeof nData === 'number' ? nData : nData.longitude;
      const aspect = findAspect(`Transit ${tPlanet}`, tLon, `Natal ${nPlanet}`, nLon);
      if (aspect) {
        aspects.push(aspect);
      }
    }
  }

  return aspects;
}

module.exports = { ASPECTS, angularDistance, findAspect, findAllAspects };
