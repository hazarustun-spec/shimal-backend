const { calcNatalChart } = require('./ephemeris');

/**
 * Build a full natal chart from user birth data
 *
 * @param {string} birthDate - ISO date string (e.g., "1995-03-15")
 * @param {string} birthTime - Time string (e.g., "14:30") in 24h format
 * @returns {object} Full natal chart data
 */
function buildNatalChart(birthDate, birthTime) {
  // Parse birth date and time into a UTC Date
  // Note: For a more accurate chart, we'd need birth location for timezone conversion
  // For MVP, we treat the entered time as UTC (close enough for sign-level accuracy)
  const [year, month, day] = birthDate.split('-').map(Number);
  const [hour, minute] = (birthTime || '12:00').split(':').map(Number);

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  const chart = calcNatalChart(date);

  // Build a human-readable summary for AI interpretation
  const summary = buildChartSummary(chart);

  return {
    ...chart,
    birthDate,
    birthTime: birthTime || '12:00',
    summary,
  };
}

/**
 * Create a concise text summary of the natal chart for AI consumption
 */
function buildChartSummary(chart) {
  const lines = [];
  lines.push(`Sun in ${chart.planets.Sun.sign} (${chart.planets.Sun.degree}°)`);
  lines.push(`Moon in ${chart.planets.Moon.sign} (${chart.planets.Moon.degree}°)`);
  lines.push(`Mercury in ${chart.planets.Mercury.sign}`);
  lines.push(`Venus in ${chart.planets.Venus.sign}`);
  lines.push(`Mars in ${chart.planets.Mars.sign}`);
  lines.push(`Jupiter in ${chart.planets.Jupiter.sign}`);
  lines.push(`Saturn in ${chart.planets.Saturn.sign}`);
  lines.push(`Uranus in ${chart.planets.Uranus.sign}`);
  lines.push(`Neptune in ${chart.planets.Neptune.sign}`);
  lines.push(`Pluto in ${chart.planets.Pluto.sign}`);

  // Note retrogrades at birth
  const retrogrades = Object.entries(chart.planets)
    .filter(([, data]) => data.isRetrograde)
    .map(([name]) => name);

  if (retrogrades.length > 0) {
    lines.push(`Retrograde at birth: ${retrogrades.join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = { buildNatalChart };
