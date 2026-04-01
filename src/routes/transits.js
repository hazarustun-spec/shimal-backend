'use strict';

const {
  calcCurrentTransits,
  getRetrogradePlanets,
  calcAllPlanets,
  calcNatalChart,
} = require('../services/ephemeris');
const { toTR } = require('../utils/zodiac-tr');
const {
  buildTransitTimeline,
  getCurrentMoonPhase,
  calculateCompatibility,
} = require('../services/transit-timeline');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');
const { isValidBirthDate, isValidBirthTime } = require('../utils/validate');

function parseBirthDateTime(birthDate, birthTime = '12:00') {
  const [year, month, day] = birthDate.split('-').map(Number);
  const [hour, minute] = birthTime.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
}

async function handleTransitsToday(_req, res) {
  try {
    const transits = calcCurrentTransits();
    const retrogrades = getRetrogradePlanets();
    const positions = {};

    for (const [planet, data] of Object.entries(transits)) {
      positions[planet] = {
        sign: data.sign,
        degree: data.degree,
        isRetrograde: data.isRetrograde,
      };
    }

    writeJson(res, 200, {
      date: new Date().toISOString().split('T')[0],
      positions,
      retrogrades: retrogrades.map((item) => item.planet),
    });
  } catch (error) {
    internalError(res, error, '[Transits] Error:', 'Transit hesaplaması başarısız');
  }
}

async function handleTransitsTimeline(_req, res, _params, url) {
  try {
    const days = Math.min(Number.parseInt(url.searchParams.get('days'), 10) || 14, 30);
    const events = buildTransitTimeline(days);
    writeJson(res, 200, {
      generatedAt: new Date().toISOString(),
      lookAheadDays: days,
      events,
    });
  } catch (error) {
    internalError(res, error, '[Transits] Timeline error:', 'Transit zaman çizelgesi oluşturulamadı');
  }
}

async function handleMoonPhase(_req, res) {
  try {
    const moonPhase = getCurrentMoonPhase();
    writeJson(res, 200, {
      date: new Date().toISOString().split('T')[0],
      ...moonPhase,
    });
  } catch (error) {
    internalError(res, error, '[Transits] Moon phase error:', 'Ay fazı hesaplanamadı');
  }
}

async function handleNatalChart(_req, res, _params, url) {
  try {
    const birthDate = url.searchParams.get('birthDate');
    const birthTime = url.searchParams.get('birthTime') || '12:00';
    const lat = parseFloat(url.searchParams.get('lat')) || null;
    const lon = parseFloat(url.searchParams.get('lon')) || null;
    if (!birthDate || !isValidBirthDate(birthDate)) {
      return badRequest(res, 'Valid birthDate is required (YYYY-MM-DD)');
    }
    if (birthTime !== '12:00' && !isValidBirthTime(birthTime)) {
      return badRequest(res, 'Geçersiz doğum saati (SS:DD)');
    }

    const chart = calcNatalChart(parseBirthDateTime(birthDate, birthTime), lat, lon);
    const planets = {};
    for (const [name, data] of Object.entries(chart.planets)) {
      planets[name] = {
        sign: data.sign,
        degree: data.degree,
        longitude: data.longitude,
        symbol: data.symbol,
        element: data.element,
        isRetrograde: data.isRetrograde,
        house: data.house || null,
      };
    }

    const response = {
      sunSign: toTR(chart.sunSign),
      moonSign: toTR(chart.moonSign),
      planets,
    };

    // Add house system data if available (requires lat/lon)
    if (chart.ascendant) {
      response.ascendant = {
        sign: chart.ascendant.sign,
        degree: chart.ascendant.degree,
        longitude: chart.ascendant.longitude,
      };
    }
    if (chart.mc) {
      response.mc = {
        sign: chart.mc.sign,
        degree: chart.mc.degree,
        longitude: chart.mc.longitude,
      };
    }
    if (chart.houses) {
      response.houses = chart.houses;
    }
    if (chart.ascendantSign) {
      response.ascendantSign = toTR(chart.ascendantSign);
    }

    writeJson(res, 200, response);
  } catch (error) {
    internalError(res, error, '[Transits] Natal chart error:', 'Doğum haritası hesaplanamadı');
  }
}

async function handleTransitsCompatibility(req, res) {
  try {
    const body = await readJsonBody(req);
    const { birthDate1, birthTime1, birthDate2, birthTime2 } = body;
    if (!birthDate1 || !isValidBirthDate(birthDate1)) {
      return badRequest(res, 'Valid birthDate1 is required (YYYY-MM-DD)');
    }
    if (!birthDate2 || !isValidBirthDate(birthDate2)) {
      return badRequest(res, 'Valid birthDate2 is required (YYYY-MM-DD)');
    }

    const chart1 = calcAllPlanets(parseBirthDateTime(birthDate1, birthTime1));
    const chart2 = calcAllPlanets(parseBirthDateTime(birthDate2, birthTime2));
    const compatibility = calculateCompatibility(chart1, chart2);
    compatibility.person1 = { sunSign: toTR(chart1.Sun.sign), moonSign: toTR(chart1.Moon.sign) };
    compatibility.person2 = { sunSign: toTR(chart2.Sun.sign), moonSign: toTR(chart2.Moon.sign) };

    writeJson(res, 200, compatibility);
  } catch (error) {
    internalError(res, error, '[Transits] Compatibility error:', 'Uyumluluk hesaplanamadı');
  }
}

module.exports = [
  ['GET', /^\/api\/transits\/today$/, handleTransitsToday],
  ['GET', /^\/api\/transits\/timeline$/, handleTransitsTimeline],
  ['GET', /^\/api\/transits\/moon-phase$/, handleMoonPhase],
  ['GET', /^\/api\/transits\/natal-chart$/, handleNatalChart],
  // Compatibility moved to /api/compatibility (compatibility.js) — single source of truth
];
