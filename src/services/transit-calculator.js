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
  const { toTR } = require('../utils/zodiac-tr');
  const planetTR = (p) => ({ Sun:'Güneş', Moon:'Ay', Mercury:'Merkür', Venus:'Venüs', Mars:'Mars', Jupiter:'Jüpiter', Saturn:'Satürn', Uranus:'Uranüs', Neptune:'Neptün', Pluto:'Plüton', 'Transit Sun':'Transit Güneş', 'Transit Moon':'Transit Ay', 'Transit Mercury':'Transit Merkür', 'Transit Venus':'Transit Venüs', 'Transit Mars':'Transit Mars', 'Transit Jupiter':'Transit Jüpiter', 'Transit Saturn':'Transit Satürn', 'Transit Uranus':'Transit Uranüs', 'Transit Neptune':'Transit Neptün', 'Transit Pluto':'Transit Plüton', 'Natal Sun':'Natal Güneş', 'Natal Moon':'Natal Ay', 'Natal Mercury':'Natal Merkür', 'Natal Venus':'Natal Venüs', 'Natal Mars':'Natal Mars', 'Natal Jupiter':'Natal Jüpiter', 'Natal Saturn':'Natal Satürn', 'Natal Uranus':'Natal Uranüs', 'Natal Neptune':'Natal Neptün', 'Natal Pluto':'Natal Plüton' }[p] || p);
  const aspectTR = (a) => ({ conjunction:'Kavuşum', opposition:'Karşıt', trine:'Üçgen', square:'Kare', sextile:'Altıgen' }[a] || a);
  const natureTR = (n) => ({ harmonious:'uyumlu', challenging:'zorlayıcı', powerful:'güçlü' }[n] || n);

  const lines = [];

  lines.push('=== Güncel Transitler ===');
  for (const [name, data] of Object.entries(transits)) {
    const rx = data.isRetrograde ? ' (Retro)' : '';
    lines.push(`${planetTR(name)} ${toTR(data.sign)} burcunda ${data.degree}°${rx}`);
  }

  if (retrogrades.length > 0) {
    lines.push('\n=== Retrograd Gezegenler ===');
    retrogrades.forEach(r => lines.push(`${planetTR(r.planet)} ${toTR(r.sign)} burcunda retrograd`));
  }

  if (aspects.length > 0) {
    lines.push('\n=== Transit-Natal Açıları ===');
    const topAspects = aspects.slice(0, 10);
    topAspects.forEach(a => {
      lines.push(`${planetTR(a.planet1)} ${a.symbol} ${planetTR(a.planet2)} (${aspectTR(a.aspect)}, orb ${a.orb}°, ${natureTR(a.nature)})`);
    });
  }

  return lines.join('\n');
}

module.exports = { calculateDailyTransits };
