const { calcCurrentTransits, getRetrogradePlanets } = require('./ephemeris');
const { findAllAspects } = require('../utils/aspects');

/**
 * Calculate today's transits and their aspects to a user's natal chart
 *
 * @param {object} natalPlanets - User's natal planet positions (from natal chart)
 * @returns {object} Transit data with aspects
 */
function calculateDailyTransits(natalPlanets) {
  // Get current planet positions
  const transits = calcCurrentTransits();

  // Get current retrogrades
  const retrogrades = getRetrogradePlanets();

  // Build transit longitude map for aspect calculation
  const transitLongitudes = {};
  for (const [name, data] of Object.entries(transits)) {
    transitLongitudes[name] = data.longitude;
  }

  // Build natal longitude map
  const natalLongitudes = {};
  for (const [name, data] of Object.entries(natalPlanets)) {
    natalLongitudes[name] = data.longitude;
  }

  // Calculate aspects between current transits and natal chart
  const aspects = findAllAspects(transitLongitudes, natalLongitudes);

  // Sort aspects by significance (tighter orb = more significant)
  aspects.sort((a, b) => a.orb - b.orb);

  // Build human-readable summary for AI
  const summary = buildTransitSummary(transits, retrogrades, aspects);

  return {
    date: new Date().toISOString().split('T')[0],
    transits,
    retrogrades,
    aspects,
    summary,
  };
}

/**
 * Build a text summary of transits for AI interpretation
 */
function buildTransitSummary(transits, retrogrades, aspects) {
  const lines = [];

  // Current planet positions
  lines.push('=== Current Transits ===');
  for (const [name, data] of Object.entries(transits)) {
    const rx = data.isRetrograde ? ' (Retrograde)' : '';
    lines.push(`${name} in ${data.sign} ${data.degree}°${rx}`);
  }

  // Retrogrades
  if (retrogrades.length > 0) {
    lines.push('\n=== Currently Retrograde ===');
    retrogrades.forEach(r => lines.push(`${r.planet} retrograde in ${r.sign}`));
  }

  // Significant aspects to natal chart
  if (aspects.length > 0) {
    lines.push('\n=== Transit-to-Natal Aspects ===');
    const topAspects = aspects.slice(0, 10); // Top 10 tightest aspects
    topAspects.forEach(a => {
      lines.push(`${a.planet1} ${a.symbol} ${a.planet2} (${a.aspect}, orb ${a.orb}°, ${a.nature})`);
    });
  }

  return lines.join('\n');
}

module.exports = { calculateDailyTransits };
