/**
 * Cosmic Weather Builder
 * Computes a real-time "cosmic weather" snapshot from current sky positions.
 * Uses sky-to-sky aspects between major planets (no natal chart required).
 */

const { calcAllPlanets, getRetrogradePlanets } = require('./ephemeris');
const { findAspect } = require('../utils/aspects');

// Only major planets participate in sky-to-sky aspect search
const MAJOR_PLANETS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

// Lower priority index = higher significance in scoring
const PLANET_PRIORITY = {
  Moon: 0, Sun: 1, Mars: 2, Mercury: 3,
  Venus: 4, Jupiter: 5, Saturn: 6,
};

const ASPECT_TR = {
  Conjunction: 'kavuşumu',
  Sextile:     'sekstili',
  Square:      'karesi',
  Trine:       'trinesi',
  Opposition:  'karşıtlığı',
};

const PLANET_TR = {
  Sun: 'Güneş', Moon: 'Ay', Mercury: 'Merkür', Venus: 'Venüs',
  Mars: 'Mars', Jupiter: 'Jüpiter', Saturn: 'Satürn',
  Uranus: 'Uranüs', Neptune: 'Neptün', Pluto: 'Plüton',
};

const ENERGY_TR    = { calm: 'Sakin', moderate: 'Dengeli', intense: 'Yoğun', transformative: 'Dönüşümsel' };
const CLIMATE_TR   = { clear: 'Net',  moderate: 'Makul',   unstable: 'Kararsız', volatile: 'Çalkantılı' };

// Normalise the raw nature value from aspects.js ('major' → 'neutral')
function normalizeNature(nature) {
  if (nature === 'harmonious') return 'harmonious';
  if (nature === 'challenging') return 'challenging';
  return 'neutral';
}

/**
 * Scan all major-planet pairs and return the most "felt" aspect today.
 * Scoring: challenging aspects and Sun/Moon/Mars involvement win ties.
 */
function findDominantSkyAspect(positions) {
  let best = null;
  let bestScore = Infinity;

  const available = MAJOR_PLANETS.filter(p => positions[p]);

  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const p1 = available[i];
      const p2 = available[j];
      const result = findAspect(p1, positions[p1].longitude, p2, positions[p2].longitude);
      if (!result) continue;

      // Lower score → more prominent
      const naturePenalty  = result.nature === 'challenging' ? -2 : result.nature === 'major' ? 0 : 1;
      const priorityBonus  = ((PLANET_PRIORITY[p1] ?? 7) + (PLANET_PRIORITY[p2] ?? 7)) * 0.3;
      const score = result.orb + naturePenalty + priorityBonus;

      if (score < bestScore) {
        bestScore = score;
        best = { ...result, planet1: p1, planet2: p2 };
      }
    }
  }

  return best;
}

function calcEnergyLevel(dominant, retrogrades) {
  let score = 0;
  if (dominant) {
    const n = normalizeNature(dominant.nature);
    if (n === 'challenging') score += 2;
    else if (n === 'neutral') score += 1;
    if (['Mars', 'Saturn', 'Pluto'].includes(dominant.planet1) ||
        ['Mars', 'Saturn', 'Pluto'].includes(dominant.planet2)) score += 1;
  }
  score += Math.min(retrogrades.length, 2);
  if (score <= 0) return 'calm';
  if (score <= 1) return 'moderate';
  if (score <= 3) return 'intense';
  return 'transformative';
}

function calcDecisionClimate(dominant, retrogrades) {
  let score = 0;
  if (dominant) {
    const n = normalizeNature(dominant.nature);
    if (n === 'challenging') score += 2;
    if (dominant.aspect === 'Opposition') score += 1;
    if (dominant.aspect === 'Square')     score += 1;
    if (n === 'harmonious') score -= 1;
  }
  if (retrogrades.some(r => r.planet === 'Mercury')) score += 2;
  if (score <= 0) return 'clear';
  if (score <= 2) return 'moderate';
  if (score <= 4) return 'unstable';
  return 'volatile';
}

function buildSummaryText(dominant, retrogrades, moonSign) {
  const parts = [];

  if (dominant) {
    const p1 = PLANET_TR[dominant.planet1] || dominant.planet1;
    const p2 = PLANET_TR[dominant.planet2] || dominant.planet2;
    const asp = ASPECT_TR[dominant.aspect] || dominant.aspect;
    const n = normalizeNature(dominant.nature);

    if (n === 'challenging') {
      parts.push(`${p1}-${p2} ${asp} bugüne gergin bir titreşim katıyor; kararlar için sabır ve gözlem önemli.`);
    } else if (n === 'harmonious') {
      parts.push(`${p1}-${p2} ${asp} günün akışına yumuşak bir ivme ekliyor; bağlantılar ve ifade için elverişli zaman.`);
    } else {
      parts.push(`${p1}-${p2} kavuşumu odağı yoğunlaştırıyor; bu enerjiyi bilinçli kullanmak güç katıyor.`);
    }
  }

  if (retrogrades.length > 0) {
    const names = retrogrades.map(r => PLANET_TR[r.planet] || r.planet).join(', ');
    parts.push(`${names} retro sürecinde — revizyonlar ve geçmişe dönük değerlendirmeler öne çıkabilir.`);
  }

  if (moonSign) {
    parts.push(`Ay ${moonSign} burcunda ilerliyor.`);
  }

  return parts.join(' ') || 'Gökyüzü bugün sakin bir enerji taşıyor.';
}

/**
 * Main entry point — returns the full cosmic weather object.
 * Pure computation: no DB calls, no async needed.
 */
function buildCosmicWeather() {
  const now        = new Date();
  const positions  = calcAllPlanets(now);
  const retrogrades = getRetrogradePlanets(now);

  const dominant        = findDominantSkyAspect(positions);
  const energyLevel     = calcEnergyLevel(dominant, retrogrades);
  const decisionClimate = calcDecisionClimate(dominant, retrogrades);
  const moonSign        = positions.Moon?.sign || null;

  const dominantTransit = dominant ? {
    planet1:   PLANET_TR[dominant.planet1] || dominant.planet1,
    planet1En: dominant.planet1,
    aspect:    dominant.aspect,
    aspectTr:  ASPECT_TR[dominant.aspect] || dominant.aspect,
    planet2:   PLANET_TR[dominant.planet2] || dominant.planet2,
    planet2En: dominant.planet2,
    nature:    normalizeNature(dominant.nature),
  } : null;

  return {
    generatedAt:       now.toISOString(),
    energyLevel,
    energyLevelTr:     ENERGY_TR[energyLevel],
    decisionClimate,
    decisionClimateTr: CLIMATE_TR[decisionClimate],
    dominantTransit,
    retrogrades: retrogrades.map(r => ({
      planet:   PLANET_TR[r.planet] || r.planet,
      planetEn: r.planet,
      sign:     r.sign,
    })),
    moonPhase: moonSign ? {
      sign:   moonSign,
      degree: positions.Moon ? Math.round(positions.Moon.degree * 10) / 10 : 0,
    } : null,
    summaryText: buildSummaryText(dominant, retrogrades, moonSign),
  };
}

module.exports = { buildCosmicWeather };
