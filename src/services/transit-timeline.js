const { calcAllPlanets, dateToJulianDay } = require('./ephemeris');
const { longitudeToSign, SIGNS } = require('../utils/zodiac');

/**
 * Calculate upcoming significant transit events over the next N days.
 * Returns sign ingresses, retrograde station changes, and lunar phases.
 */
function buildTransitTimeline(days = 14) {
  const events = [];
  const now = new Date();
  const todayPositions = calcAllPlanets(now);

  // Track each planet's current sign to detect ingresses
  const currentSigns = {};
  for (const [planet, data] of Object.entries(todayPositions)) {
    currentSigns[planet] = data.sign;
  }

  // Track retrograde status to detect stations
  const currentRetrograde = {};
  for (const [planet, data] of Object.entries(todayPositions)) {
    currentRetrograde[planet] = data.isRetrograde;
  }

  // Scan each day forward
  for (let d = 1; d <= days; d++) {
    const date = new Date(now.getTime() + d * 86400000);
    const dateStr = date.toISOString().split('T')[0];

    let positions;
    try {
      positions = calcAllPlanets(date);
    } catch {
      continue;
    }

    for (const [planet, data] of Object.entries(positions)) {
      // Detect sign ingress
      if (data.sign !== currentSigns[planet]) {
        events.push({
          type: 'ingress',
          planet,
          date: dateStr,
          daysFromNow: d,
          fromSign: currentSigns[planet],
          toSign: data.sign,
          description: `${planet} enters ${data.sign}`,
        });
        currentSigns[planet] = data.sign;
      }

      // Detect retrograde station changes (direct ↔ retrograde)
      if (data.isRetrograde !== currentRetrograde[planet]) {
        const stationType = data.isRetrograde ? 'retrograde' : 'direct';
        events.push({
          type: 'station',
          planet,
          date: dateStr,
          daysFromNow: d,
          station: stationType,
          sign: data.sign,
          description: `${planet} stations ${stationType} in ${data.sign}`,
        });
        currentRetrograde[planet] = data.isRetrograde;
      }

      // Detect lunar phases (New Moon ≈ Sun-Moon conjunction, Full Moon ≈ opposition)
      if (planet === 'Moon') {
        const sunLon = positions.Sun.longitude;
        const moonLon = data.longitude;
        const diff = ((moonLon - sunLon + 360) % 360);

        // New Moon: within 12° of conjunction
        if (diff < 12 || diff > 348) {
          // Check we didn't already add a new moon within 2 days
          const recentNew = events.find(
            e => e.type === 'lunar_phase' && e.phase === 'new_moon' && Math.abs(e.daysFromNow - d) < 2
          );
          if (!recentNew) {
            events.push({
              type: 'lunar_phase',
              phase: 'new_moon',
              date: dateStr,
              daysFromNow: d,
              sign: data.sign,
              description: `New Moon in ${data.sign}`,
            });
          }
        }

        // Full Moon: within 12° of opposition
        if (diff > 168 && diff < 192) {
          const recentFull = events.find(
            e => e.type === 'lunar_phase' && e.phase === 'full_moon' && Math.abs(e.daysFromNow - d) < 2
          );
          if (!recentFull) {
            events.push({
              type: 'lunar_phase',
              phase: 'full_moon',
              date: dateStr,
              daysFromNow: d,
              sign: data.sign,
              description: `Full Moon in ${data.sign}`,
            });
          }
        }
      }
    }
  }

  // Sort by date
  events.sort((a, b) => a.daysFromNow - b.daysFromNow);

  return events;
}

/**
 * Calculate the current moon phase based on Sun-Moon angular distance.
 * Returns phase name, illumination percentage, and emoji.
 */
function getCurrentMoonPhase() {
  const now = new Date();
  const positions = calcAllPlanets(now);
  const sunLon = positions.Sun.longitude;
  const moonLon = positions.Moon.longitude;
  const diff = ((moonLon - sunLon + 360) % 360);

  let phaseName, phaseEmoji;
  let illumination;

  if (diff < 11.25) {
    phaseName = 'Yeni Ay'; phaseEmoji = '🌑'; illumination = 0;
  } else if (diff < 33.75) {
    phaseName = 'Hilal (Büyüyen)'; phaseEmoji = '🌒'; illumination = 0.08;
  } else if (diff < 56.25) {
    phaseName = 'Hilal (Büyüyen)'; phaseEmoji = '🌒'; illumination = 0.16;
  } else if (diff < 78.75) {
    phaseName = 'İlk Dördün'; phaseEmoji = '🌓'; illumination = 0.25;
  } else if (diff < 101.25) {
    phaseName = 'Şişkin Ay (Büyüyen)'; phaseEmoji = '🌔'; illumination = 0.40;
  } else if (diff < 123.75) {
    phaseName = 'Şişkin Ay (Büyüyen)'; phaseEmoji = '🌔'; illumination = 0.55;
  } else if (diff < 146.25) {
    phaseName = 'Şişkin Ay (Büyüyen)'; phaseEmoji = '🌔'; illumination = 0.70;
  } else if (diff < 168.75) {
    phaseName = 'Şişkin Ay (Büyüyen)'; phaseEmoji = '🌔'; illumination = 0.85;
  } else if (diff < 191.25) {
    phaseName = 'Dolunay'; phaseEmoji = '🌕'; illumination = 1.0;
  } else if (diff < 213.75) {
    phaseName = 'Şişkin Ay (Küçülen)'; phaseEmoji = '🌖'; illumination = 0.85;
  } else if (diff < 236.25) {
    phaseName = 'Şişkin Ay (Küçülen)'; phaseEmoji = '🌖'; illumination = 0.70;
  } else if (diff < 258.75) {
    phaseName = 'Son Dördün'; phaseEmoji = '🌗'; illumination = 0.50;
  } else if (diff < 281.25) {
    phaseName = 'Hilal (Küçülen)'; phaseEmoji = '🌘'; illumination = 0.35;
  } else if (diff < 303.75) {
    phaseName = 'Hilal (Küçülen)'; phaseEmoji = '🌘'; illumination = 0.20;
  } else if (diff < 326.25) {
    phaseName = 'Hilal (Küçülen)'; phaseEmoji = '🌘'; illumination = 0.08;
  } else if (diff < 348.75) {
    phaseName = 'Hilal (Küçülen)'; phaseEmoji = '🌘'; illumination = 0.02;
  } else {
    phaseName = 'Yeni Ay'; phaseEmoji = '🌑'; illumination = 0;
  }

  return {
    phaseName,
    phaseNameEn: getMoonPhaseEnglish(diff),
    phaseEmoji,
    illumination: Math.round(illumination * 100),
    angle: Math.round(diff * 100) / 100,
    moonSign: positions.Moon.sign,
    moonDegree: positions.Moon.degree,
  };
}

function getMoonPhaseEnglish(diff) {
  if (diff < 11.25 || diff >= 348.75) return 'New Moon';
  if (diff < 78.75) return 'Waxing Crescent';
  if (diff < 101.25) return 'First Quarter';
  if (diff < 168.75) return 'Waxing Gibbous';
  if (diff < 191.25) return 'Full Moon';
  if (diff < 258.75) return 'Waning Gibbous';
  if (diff < 281.25) return 'Last Quarter';
  return 'Waning Crescent';
}

/**
 * Calculate compatibility/synastry between two natal charts.
 * Compares planetary positions and returns category scores.
 */
function calculateCompatibility(chart1, chart2) {
  const aspects = [];
  const planetPairs = [
    ['Sun', 'Sun'], ['Sun', 'Moon'], ['Moon', 'Moon'],
    ['Venus', 'Mars'], ['Venus', 'Venus'], ['Mars', 'Mars'],
    ['Mercury', 'Mercury'], ['Sun', 'Venus'], ['Moon', 'Venus'],
  ];

  for (const [p1, p2] of planetPairs) {
    if (!chart1[p1] || !chart2[p2]) continue;
    const lon1 = chart1[p1].longitude;
    const lon2 = chart2[p2].longitude;
    const diff = Math.abs(((lon1 - lon2 + 180 + 360) % 360) - 180);

    let aspectName = null;
    let harmony = 0;

    if (diff <= 10) { aspectName = 'conjunction'; harmony = 8; }
    else if (Math.abs(diff - 60) <= 8) { aspectName = 'sextile'; harmony = 7; }
    else if (Math.abs(diff - 90) <= 8) { aspectName = 'square'; harmony = 3; }
    else if (Math.abs(diff - 120) <= 8) { aspectName = 'trine'; harmony = 9; }
    else if (Math.abs(diff - 180) <= 10) { aspectName = 'opposition'; harmony = 4; }

    if (aspectName) {
      aspects.push({ planet1: p1, planet2: p2, aspect: aspectName, harmony });
    }
  }

  // Element compatibility
  const elements1 = Object.values(chart1).map(p => p.element).filter(Boolean);
  const elements2 = Object.values(chart2).map(p => p.element).filter(Boolean);
  const sharedElements = elements1.filter(e => elements2.includes(e)).length;
  const elementScore = Math.min(Math.round((sharedElements / Math.max(elements1.length, 1)) * 100), 100);

  // Calculate category scores
  const loveAspects = aspects.filter(a => ['Venus', 'Mars'].includes(a.planet1) || ['Venus', 'Mars'].includes(a.planet2));
  const commAspects = aspects.filter(a => a.planet1 === 'Mercury' || a.planet2 === 'Mercury');
  const emotionalAspects = aspects.filter(a => a.planet1 === 'Moon' || a.planet2 === 'Moon');

  const avgHarmony = aspects.length > 0 ? aspects.reduce((s, a) => s + a.harmony, 0) / aspects.length : 5;
  const loveHarmony = loveAspects.length > 0 ? loveAspects.reduce((s, a) => s + a.harmony, 0) / loveAspects.length : 5;
  const commHarmony = commAspects.length > 0 ? commAspects.reduce((s, a) => s + a.harmony, 0) / commAspects.length : 5;
  const emotionalHarmony = emotionalAspects.length > 0 ? emotionalAspects.reduce((s, a) => s + a.harmony, 0) / emotionalAspects.length : 5;

  return {
    overallScore: Math.round(Math.min(avgHarmony * 10 + elementScore * 0.1, 100)),
    categories: {
      romantic: Math.round(Math.min(loveHarmony * 11, 100)),
      emotional: Math.round(Math.min(emotionalHarmony * 11, 100)),
      communication: Math.round(Math.min(commHarmony * 11, 100)),
      friendship: Math.round(Math.min((avgHarmony * 8 + elementScore * 0.2), 100)),
    },
    aspects: aspects.slice(0, 6),
    elementCompatibility: elementScore,
  };
}

module.exports = { buildTransitTimeline, getCurrentMoonPhase, calculateCompatibility };
