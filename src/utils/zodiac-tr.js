'use strict';

const ZODIAC_TR = {
  'Aries': 'Koç', 'Taurus': 'Boğa', 'Gemini': 'İkizler', 'Cancer': 'Yengeç',
  'Leo': 'Aslan', 'Virgo': 'Başak', 'Libra': 'Terazi', 'Scorpio': 'Akrep',
  'Sagittarius': 'Yay', 'Capricorn': 'Oğlak', 'Aquarius': 'Kova', 'Pisces': 'Balık'
};

/** Convert English zodiac name to Turkish. Returns input if not found. */
function toTR(sign) {
  return ZODIAC_TR[sign] || sign;
}

module.exports = { toTR, ZODIAC_TR };
