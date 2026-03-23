'use strict';

const { calcAllPlanets } = require('../services/ephemeris');
const { calculateCompatibility } = require('../services/transit-timeline');
const { findAspect } = require('../utils/aspects');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');
const { isValidBirthDate, isValidBirthTime } = require('../utils/validate');
const { toTR } = require('../utils/zodiac-tr');

const SYNASTRY_PLANETS = ['Sun', 'Moon', 'Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'];

const PLANET_TR = {
  Sun: 'Güneş',
  Moon: 'Ay',
  Mercury: 'Merkür',
  Venus: 'Venüs',
  Mars: 'Mars',
  Jupiter: 'Jüpiter',
  Saturn: 'Satürn',
  Uranus: 'Uranüs',
  Neptune: 'Neptün',
  Pluto: 'Plüton',
};

function parseBirthDateTime(birthDate, birthTime = '12:00') {
  const [year, month, day] = birthDate.split('-').map(Number);
  const [hour, minute] = birthTime.split(':').map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
}

function normalizeNature(nature) {
  if (nature === 'harmonious') return 'harmonious';
  if (nature === 'challenging') return 'challenging';
  return 'neutral';
}

function computeSynastryAspects(positions1, positions2) {
  const aspects = [];

  for (const p1 of SYNASTRY_PLANETS) {
    if (!positions1[p1]) continue;
    for (const p2 of SYNASTRY_PLANETS) {
      if (!positions2[p2]) continue;
      const result = findAspect(p1, positions1[p1].longitude, p2, positions2[p2].longitude);
      if (result) {
        aspects.push({
          planet1: p1,
          planet1Tr: PLANET_TR[p1] || p1,
          planet2: p2,
          planet2Tr: PLANET_TR[p2] || p2,
          aspect: result.aspect,
          symbol: result.symbol,
          nature: normalizeNature(result.nature),
          orb: result.orb,
          applying: result.applying,
        });
      }
    }
  }

  aspects.sort((a, b) => a.orb - b.orb);
  return aspects;
}

function extractPlanets(positions) {
  const out = {};
  for (const p of SYNASTRY_PLANETS) {
    if (positions[p]) {
      out[p] = {
        sign: positions[p].sign,
        degree: Math.round(positions[p].degree * 10) / 10,
        longitude: positions[p].longitude,
        isRetrograde: positions[p].isRetrograde,
      };
    }
  }
  return out;
}

async function handleCompatibility(req, res) {
  try {
    const body = await readJsonBody(req);
    const { birthDate1, birthTime1, birthDate2, birthTime2, name2 } = body;
    if (!birthDate1 || !isValidBirthDate(birthDate1)) {
      return badRequest(res, 'Valid birthDate1 is required (YYYY-MM-DD)');
    }
    if (!birthDate2 || !isValidBirthDate(birthDate2)) {
      return badRequest(res, 'Valid birthDate2 is required (YYYY-MM-DD)');
    }
    if (birthTime1 && !isValidBirthTime(birthTime1)) {
      return badRequest(res, 'Geçersiz doğum saati 1 (SS:DD)');
    }
    if (birthTime2 && !isValidBirthTime(birthTime2)) {
      return badRequest(res, 'Geçersiz doğum saati 2 (SS:DD)');
    }

    const chart1 = calcAllPlanets(parseBirthDateTime(birthDate1, birthTime1));
    const chart2 = calcAllPlanets(parseBirthDateTime(birthDate2, birthTime2));
    const compat = calculateCompatibility(chart1, chart2);
    const synastryAspects = computeSynastryAspects(chart1, chart2);

    writeJson(res, 200, {
      overallScore: compat.overallScore,
      emotionalAlignment: compat.categories.emotional,
      communicationFlow: compat.categories.communication,
      romanticPotential: compat.categories.romantic,
      friendshipScore: compat.categories.friendship,
      person1: {
        sunSign: toTR(chart1.Sun.sign),
        moonSign: toTR(chart1.Moon.sign),
        planets: extractPlanets(chart1),
      },
      person2: {
        name: name2 || '',
        sunSign: toTR(chart2.Sun.sign),
        moonSign: toTR(chart2.Moon.sign),
        planets: extractPlanets(chart2),
      },
      synastryAspects,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    internalError(res, error, '[Compatibility] Error:', 'Uyumluluk hesaplanamadı');
  }
}

module.exports = [
  ['POST', /^\/api\/compatibility$/, handleCompatibility],
];
