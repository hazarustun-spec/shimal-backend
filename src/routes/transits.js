'use strict';

const {
  calcCurrentTransits,
  getRetrogradePlanets,
  calcAllPlanets,
  calcNatalChart,
} = require('../services/ephemeris');
const {
  buildTransitTimeline,
  getCurrentMoonPhase,
  calculateCompatibility,
} = require('../services/transit-timeline');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');

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
    internalError(res, error, '[Transits] Error:', 'Failed to calculate transits');
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
    internalError(res, error, '[Transits] Timeline error:', 'Failed to build transit timeline');
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
    internalError(res, error, '[Transits] Moon phase error:', 'Failed to calculate moon phase');
  }
}

async function handleNatalChart(_req, res, _params, url) {
  try {
    const birthDate = url.searchParams.get('birthDate');
    const birthTime = url.searchParams.get('birthTime') || '12:00';
    if (!birthDate) {
      return badRequest(res, 'birthDate is required');
    }

    const chart = calcNatalChart(parseBirthDateTime(birthDate, birthTime));
    const planets = {};
    for (const [name, data] of Object.entries(chart.planets)) {
      planets[name] = {
        sign: data.sign,
        degree: data.degree,
        longitude: data.longitude,
        symbol: data.symbol,
        element: data.element,
        isRetrograde: data.isRetrograde,
      };
    }

    writeJson(res, 200, {
      sunSign: chart.sunSign,
      moonSign: chart.moonSign,
      planets,
    });
  } catch (error) {
    internalError(res, error, '[Transits] Natal chart error:', 'Failed to calculate natal chart');
  }
}

async function handleTransitsCompatibility(req, res) {
  try {
    const body = await readJsonBody(req);
    const { birthDate1, birthTime1, birthDate2, birthTime2 } = body;
    if (!birthDate1 || !birthDate2) {
      return badRequest(res, 'Both birth dates are required');
    }

    const chart1 = calcAllPlanets(parseBirthDateTime(birthDate1, birthTime1));
    const chart2 = calcAllPlanets(parseBirthDateTime(birthDate2, birthTime2));
    const compatibility = calculateCompatibility(chart1, chart2);
    compatibility.person1 = { sunSign: chart1.Sun.sign, moonSign: chart1.Moon.sign };
    compatibility.person2 = { sunSign: chart2.Sun.sign, moonSign: chart2.Moon.sign };

    writeJson(res, 200, compatibility);
  } catch (error) {
    internalError(res, error, '[Transits] Compatibility error:', 'Failed to calculate compatibility');
  }
}

module.exports = [
  ['GET', /^\/api\/transits\/today$/, handleTransitsToday],
  ['GET', /^\/api\/transits\/timeline$/, handleTransitsTimeline],
  ['GET', /^\/api\/transits\/moon-phase$/, handleMoonPhase],
  ['GET', /^\/api\/transits\/natal-chart$/, handleNatalChart],
  ['POST', /^\/api\/transits\/compatibility$/, handleTransitsCompatibility],
];
