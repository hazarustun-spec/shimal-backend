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

  // Build transit data map for aspect calculation (includes speed for applying/separating)
  const transitData = {};
  for (const [name, data] of Object.entries(transits)) {
    transitData[name] = data; // pass full object with longitude + speed
  }

  // Calculate aspects between current transits and natal chart
  const aspects = findAllAspects(transitData, natalPlanets);

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
  const { toTR } = require('../utils/zodiac-tr');

  const PLANET_TR = {
    Sun: 'Güneş', Moon: 'Ay', Mercury: 'Merkür', Venus: 'Venüs', Mars: 'Mars',
    Jupiter: 'Jüpiter', Saturn: 'Satürn', Uranus: 'Uranüs', Neptune: 'Neptün', Pluto: 'Plüton',
    TrueNode: 'Kuzey Düğüm', Chiron: 'Chiron', Lilith: 'Lilith',
  };

  const prefixedPlanetTR = {};
  for (const [en, tr] of Object.entries(PLANET_TR)) {
    prefixedPlanetTR[en] = tr;
    prefixedPlanetTR[`Transit ${en}`] = `Transit ${tr}`;
    prefixedPlanetTR[`Natal ${en}`] = `Natal ${tr}`;
  }

  const planetTR = (p) => prefixedPlanetTR[p] || p;

  const ASPECT_TR = {
    Conjunction: 'Kavuşum', Opposition: 'Karşıt', Trine: 'Üçgen',
    Square: 'Kare', Sextile: 'Altıgen', Quincunx: 'Kuinkünks',
    'Semi-sextile': 'Yarı Altıgen', 'Semi-square': 'Yarı Kare',
    Sesquiquadrate: 'Oturmuş Kare',
  };
  const aspectTR = (a) => ASPECT_TR[a] || a;

  const NATURE_TR = {
    harmonious: 'uyumlu', challenging: 'zorlayıcı', major: 'güçlü',
    adjustment: 'uyum gerektiren', subtle: 'ince', friction: 'sürtüşme', tension: 'gerilim',
  };
  const natureTR = (n) => NATURE_TR[n] || n;

  const lines = [];

  lines.push('=== Güncel Transitler ===');
  for (const [name, data] of Object.entries(transits)) {
    if (!data) continue;
    const rx = data.isRetrograde ? ' (Retro)' : '';
    lines.push(`${planetTR(name)} ${toTR(data.sign)} burcunda ${data.degree}°${rx}`);
  }

  if (retrogrades.length > 0) {
    lines.push('\n=== Retrograd Gezegenler ===');
    retrogrades.forEach(r => lines.push(`${planetTR(r.planet)} ${toTR(r.sign)} burcunda retrograd`));
  }

  if (aspects.length > 0) {
    lines.push('\n=== Transit-Natal Açıları ===');
    const topAspects = aspects.slice(0, 12);
    topAspects.forEach(a => {
      const applyStr = a.applying ? 'yaklaşan' : 'ayrılan';
      lines.push(`${planetTR(a.planet1)} ${a.symbol} ${planetTR(a.planet2)} (${aspectTR(a.aspect)}, orb ${a.orb}°, ${natureTR(a.nature)}, ${applyStr})`);
    });
  }

  return lines.join('\n');
}

module.exports = { calculateDailyTransits };
