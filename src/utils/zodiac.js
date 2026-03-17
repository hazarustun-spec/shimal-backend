/**
 * Zodiac sign utilities
 * Maps ecliptic longitude to zodiac signs.
 *
 * Keep Swiss Ephemeris planet IDs as plain numeric constants so the rest of the
 * backend can continue working even when the native `swisseph` module is not
 * available for the current Node.js version.
 */

const PLANETS = {
  Sun: 0,
  Moon: 1,
  Mercury: 2,
  Venus: 3,
  Mars: 4,
  Jupiter: 5,
  Saturn: 6,
  Uranus: 7,
  Neptune: 8,
  Pluto: 9,
};

const PLANET_NAMES = Object.keys(PLANETS);

const SIGNS = [
  { name: 'Aries',       symbol: '♈', element: 'Fire',  modality: 'Cardinal', startDeg: 0 },
  { name: 'Taurus',      symbol: '♉', element: 'Earth', modality: 'Fixed',    startDeg: 30 },
  { name: 'Gemini',      symbol: '♊', element: 'Air',   modality: 'Mutable',  startDeg: 60 },
  { name: 'Cancer',      symbol: '♋', element: 'Water', modality: 'Cardinal', startDeg: 90 },
  { name: 'Leo',         symbol: '♌', element: 'Fire',  modality: 'Fixed',    startDeg: 120 },
  { name: 'Virgo',       symbol: '♍', element: 'Earth', modality: 'Mutable',  startDeg: 150 },
  { name: 'Libra',       symbol: '♎', element: 'Air',   modality: 'Cardinal', startDeg: 180 },
  { name: 'Scorpio',     symbol: '♏', element: 'Water', modality: 'Fixed',    startDeg: 210 },
  { name: 'Sagittarius', symbol: '♐', element: 'Fire',  modality: 'Mutable',  startDeg: 240 },
  { name: 'Capricorn',   symbol: '♑', element: 'Earth', modality: 'Cardinal', startDeg: 270 },
  { name: 'Aquarius',    symbol: '♒', element: 'Air',   modality: 'Fixed',    startDeg: 300 },
  { name: 'Pisces',      symbol: '♓', element: 'Water', modality: 'Mutable',  startDeg: 330 },
];

/**
 * Convert ecliptic longitude (0-360) to zodiac sign and degree within sign
 */
function longitudeToSign(longitude) {
  const lon = ((longitude % 360) + 360) % 360;
  const signIndex = Math.floor(lon / 30);
  const degreeInSign = Math.round((lon % 30) * 100) / 100;
  const sign = SIGNS[signIndex];

  return {
    sign: sign.name,
    degree: degreeInSign,
    symbol: sign.symbol,
    element: sign.element,
    modality: sign.modality,
  };
}

function getSignInfo(signName) {
  return SIGNS.find(s => s.name.toLowerCase() === signName.toLowerCase()) || null;
}

module.exports = { SIGNS, PLANETS, PLANET_NAMES, longitudeToSign, getSignInfo };
