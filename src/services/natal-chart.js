const { calcNatalChart } = require('./ephemeris');
const { findNatalAspects } = require('../utils/aspects');

// Try to load geo-tz for timezone conversion
let geoTz = null;
try {
  geoTz = require('geo-tz');
} catch (err) {
  console.warn('[NatalChart] geo-tz unavailable, timezone conversion disabled:', err.message);
}

/**
 * Convert local birth time to UTC using birth location coordinates.
 *
 * @param {number} year
 * @param {number} month - 1-based
 * @param {number} day
 * @param {number} hour - 24h format
 * @param {number} minute
 * @param {number} latitude
 * @param {number} longitude
 * @returns {Date} UTC Date
 */
function localTimeToUTC(year, month, day, hour, minute, latitude, longitude) {
  if (!geoTz) {
    console.warn('[NatalChart] geo-tz not available, treating birth time as UTC');
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  }

  try {
    const timezones = geoTz.find(latitude, longitude);
    if (!timezones || timezones.length === 0) {
      console.warn(`[NatalChart] No timezone found for ${latitude},${longitude}, using UTC`);
      return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
    }

    const tz = timezones[0];

    // Build a local datetime string and find the UTC offset for this timezone
    // Strategy: create a UTC date, format it in the target timezone, measure the difference
    const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false,
    });

    const parts = formatter.formatToParts(utcGuess);
    const get = (type) => parseInt(parts.find(p => p.type === type)?.value || '0', 10);

    const localYear = get('year');
    const localMonth = get('month');
    const localDay = get('day');
    let localHour = get('hour');
    if (localHour === 24) localHour = 0; // Intl may return 24 for midnight
    const localMinute = get('minute');

    // The UTC guess shows as this local time in the target timezone
    // So the offset = localTime - utcTime
    const localAsUTC = new Date(Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, 0));
    const offsetMs = localAsUTC.getTime() - utcGuess.getTime();

    // The actual UTC time for the user's local birth time is:
    // birthUTC = localBirthTime - offset
    const birthLocalMs = new Date(Date.UTC(year, month - 1, day, hour, minute, 0)).getTime();
    const birthUTCMs = birthLocalMs - offsetMs;

    console.log(`[NatalChart] Timezone: ${tz}, offset: ${offsetMs / 3600000}h, local: ${hour}:${String(minute).padStart(2, '0')} → UTC: ${new Date(birthUTCMs).toISOString()}`);

    return new Date(birthUTCMs);
  } catch (err) {
    console.warn(`[NatalChart] Timezone conversion failed: ${err.message}, using UTC`);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  }
}

/**
 * Build a full natal chart from user birth data
 *
 * @param {string} birthDate - ISO date string (e.g., "1995-03-15")
 * @param {string} birthTime - Time string (e.g., "14:30") in 24h format
 * @param {number|null} latitude - Birth latitude for timezone + houses
 * @param {number|null} longitude - Birth longitude for timezone + houses
 * @returns {object} Full natal chart data
 */
function buildNatalChart(birthDate, birthTime, latitude = null, longitude = null) {
  const [year, month, day] = birthDate.split('-').map(Number);
  const [hour, minute] = (birthTime || '12:00').split(':').map(Number);

  // Convert local birth time to UTC using location
  let date;
  if (latitude != null && longitude != null) {
    date = localTimeToUTC(year, month, day, hour, minute, latitude, longitude);
  } else {
    // No location: treat as UTC (legacy behavior)
    // Note: Date.UTC month is 0-based, so subtract 1
    date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  }

  // Calculate natal chart with optional house system
  const chart = calcNatalChart(date, latitude, longitude);

  // Calculate natal aspects (planet-to-planet within the chart)
  const natalAspects = findNatalAspects(chart.planets);

  // Build a human-readable summary for AI interpretation
  const summary = buildChartSummary(chart, natalAspects);

  return {
    ...chart,
    birthDate,
    birthTime: birthTime || '12:00',
    natalAspects,
    summary,
  };
}

/**
 * Create a concise text summary of the natal chart for AI consumption.
 * Includes planets, houses, ascendant, nodes, and natal aspects.
 */
function buildChartSummary(chart, natalAspects = []) {
  const lines = [];

  // Ascendant / Rising Sign
  if (chart.ascendant) {
    lines.push(`Ascendant (Yükselen): ${chart.ascendant.sign} (${chart.ascendant.degree}°)`);
  }
  if (chart.mc) {
    lines.push(`MC (Gökyüzü Ortası): ${chart.mc.sign} (${chart.mc.degree}°)`);
  }

  lines.push('');
  lines.push('--- Gezegen Yerleşimleri ---');

  // Planets with house placements
  for (const [name, data] of Object.entries(chart.planets)) {
    if (!data) continue;
    const rx = data.isRetrograde ? ' (R)' : '';
    const house = data.house ? ` [Ev ${data.house}]` : '';
    lines.push(`${name} in ${data.sign} (${data.degree}°)${rx}${house}`);
  }

  // Part of Fortune
  if (chart.partOfFortune) {
    lines.push(`Part of Fortune in ${chart.partOfFortune.sign} (${chart.partOfFortune.degree}°)`);
  }

  // Retrogrades at birth
  const retrogrades = Object.entries(chart.planets)
    .filter(([, data]) => data && data.isRetrograde)
    .map(([name]) => name);

  if (retrogrades.length > 0) {
    lines.push(`\nRetrograde at birth: ${retrogrades.join(', ')}`);
  }

  // House system info
  if (chart.houseSystem) {
    lines.push(`House system: ${chart.houseSystem}`);
  }

  // Natal aspects (top 10)
  if (natalAspects.length > 0) {
    lines.push('\n--- Natal Açılar (Karakter Yapısı) ---');
    const top = natalAspects.slice(0, 10);
    for (const a of top) {
      const applying = a.applying ? 'applying' : 'separating';
      lines.push(`${a.planet1} ${a.symbol} ${a.planet2} (${a.aspect}, orb ${a.orb}°, ${a.nature}, ${applying})`);
    }
  }

  return lines.join('\n');
}

module.exports = { buildNatalChart };
