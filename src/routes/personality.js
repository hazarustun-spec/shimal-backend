'use strict';

const supabase = require('../config/supabase');
const { generatePersonalityAnalysis } = require('../services/ai-interpreter');
const { writeJson, internalError, badRequest, checkOwnership } = require('../utils/http');
const { isValidDeviceId } = require('../utils/validate');
const { toTR } = require('../utils/zodiac-tr');

const PLANET_TR = {
  Sun: 'Güneş', Moon: 'Ay', Mercury: 'Merkür', Venus: 'Venüs', Mars: 'Mars',
  Jupiter: 'Jüpiter', Saturn: 'Satürn', Uranus: 'Uranüs', Neptune: 'Neptün', Pluto: 'Plüton',
  TrueNode: 'Kuzey Düğüm', Chiron: 'Chiron', Lilith: 'Lilith',
};

// Element mapping for zodiac signs
const SIGN_ELEMENT = {
  Aries: 'fire', Taurus: 'earth', Gemini: 'air', Cancer: 'water',
  Leo: 'fire', Virgo: 'earth', Libra: 'air', Scorpio: 'water',
  Sagittarius: 'fire', Capricorn: 'earth', Aquarius: 'air', Pisces: 'water',
};

// Planet weights for element balance (luminaries + personal = heavier)
const PLANET_WEIGHT = {
  Sun: 3, Moon: 3, Mercury: 2, Venus: 2, Mars: 2,
  Jupiter: 1.5, Saturn: 1.5, Uranus: 1, Neptune: 1, Pluto: 1,
  TrueNode: 0.5, Chiron: 0.5, Lilith: 0.5,
};

/**
 * Calculate element balance from natal planets (algorithmic, no AI needed)
 */
function calcElementBalance(natalPlanets) {
  const totals = { fire: 0, earth: 0, air: 0, water: 0 };
  let totalWeight = 0;

  for (const [planet, data] of Object.entries(natalPlanets)) {
    if (planet.startsWith('_') || !data?.sign) continue;
    const element = SIGN_ELEMENT[data.sign];
    const weight = PLANET_WEIGHT[planet] || 1;
    if (element) {
      totals[element] += weight;
      totalWeight += weight;
    }
  }

  // Also count ascendant
  const asc = natalPlanets?._ascendant;
  if (asc?.sign) {
    const element = SIGN_ELEMENT[asc.sign];
    if (element) {
      totals[element] += 3; // Ascendant has high weight
      totalWeight += 3;
    }
  }

  if (totalWeight === 0) return { fire: 25, earth: 25, air: 25, water: 25 };

  return {
    fire: Math.round((totals.fire / totalWeight) * 100),
    earth: Math.round((totals.earth / totalWeight) * 100),
    air: Math.round((totals.air / totalWeight) * 100),
    water: Math.round((totals.water / totalWeight) * 100),
  };
}

/**
 * Build natal summary text for AI prompt (same pattern as daily.js)
 */
function buildNatalSummaryForPersonality(user) {
  const lines = [];
  const np = user.natal_planets;
  if (!np) return 'Natal harita verisi bulunamadı.';

  const natalAsc = np._ascendant;
  const natalMC = np._mc;
  if (natalAsc) lines.push(`Yükselen ${toTR(natalAsc.sign)} burcunda ${natalAsc.degree}°`);
  if (natalMC) lines.push(`MC ${toTR(natalMC.sign)} burcunda ${natalMC.degree}°`);

  for (const [planet, data] of Object.entries(np)) {
    if (planet.startsWith('_')) continue;
    if (!data || !data.sign) continue;
    const rx = data.isRetrograde ? ' (Rx)' : '';
    const house = data.house ? ` [Ev ${data.house}]` : '';
    const planetTR = PLANET_TR[planet] || planet;
    lines.push(`${planetTR} ${toTR(data.sign)} burcunda ${data.degree}°${rx}${house}`);
  }

  const pof = np._partOfFortune;
  if (pof) lines.push(`Pars Fortuna ${toTR(pof.sign)} burcunda ${pof.degree}°`);

  const natalAspects = np._natalAspects;
  if (natalAspects && natalAspects.length > 0) {
    lines.push('\nNatal Açılar:');
    for (const a of natalAspects.slice(0, 15)) {
      lines.push(`${a.planet1} ${a.symbol} ${a.planet2} (${a.aspect}, orb ${a.orb}°, ${a.nature})`);
    }
  }

  return lines.join('\n');
}

/**
 * GET /api/user/:deviceId/personality
 */
async function handleGetPersonality(req, res, params) {
  try {
    const { deviceId } = params;
    if (!isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!(await checkOwnership(req, res, deviceId))) return;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('device_id', deviceId)
      .single();

    if (error || !user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı.' });
      return;
    }

    // Always compute element balance (algorithmic, free)
    const elementBalance = calcElementBalance(user.natal_planets || {});

    // If already generated, return cached
    if (user.personality_analysis && user.personality_analysis.summary) {
      console.log(`[Personality] Returning cached analysis for ${deviceId}`);
      writeJson(res, 200, {
        ...user.personality_analysis,
        elementBalance,
        cached: true,
      });
      return;
    }

    // Generate with AI
    console.log(`[Personality] Generating analysis for ${deviceId} (${user.sun_sign})`);

    if (!user.natal_planets) {
      writeJson(res, 400, { error: 'Natal harita verisi bulunamadı. Lütfen tekrar kayıt olun.' });
      return;
    }

    const natalSummary = buildNatalSummaryForPersonality(user);
    const natalAsc = user.natal_planets?._ascendant;

    let analysis;
    try {
      analysis = await generatePersonalityAnalysis({
        natalSummary,
        gender: user.gender,
        relationshipStatus: user.relationship_status,
        workStatus: user.work_status,
        sunSign: user.sun_sign,
        moonSign: user.moon_sign,
        ascendantSign: natalAsc?.sign || null,
        preferredName: user.preferred_name || '',
        // Anketten yalnızca kişilik metnini etkileyen ikisi kullanılıyor:
        // terim yoğunluğu ve doğum saatinin güvenilirliği.
        quiz: {
          astrologyLevel:    user.quiz_astrology_level || null,
          birthTimeAccuracy: user.quiz_birth_time_accuracy || null,
        },
      });
    } catch (aiError) {
      console.error(`[Personality] AI generation failed: ${aiError.message}`);
      writeJson(res, 503, { error: 'Kişilik analizi şu an oluşturulamıyor. Lütfen daha sonra tekrar deneyin.' });
      return;
    }

    // Save to DB
    const { error: updateError } = await supabase
      .from('users')
      .update({ personality_analysis: analysis })
      .eq('id', user.id);

    if (updateError) {
      console.error('[Personality] DB save error:', updateError.message);
      // Still return the analysis even if save fails
    }

    console.log(`[Personality] Analysis generated and saved for ${deviceId}`);
    writeJson(res, 200, {
      ...analysis,
      elementBalance,
      cached: false,
    });
  } catch (error) {
    internalError(res, error, '[Personality] Error:', 'Kişilik analizi alınamadı');
  }
}

module.exports = [
  ['GET', /^\/api\/user\/([^/]+)\/personality$/, handleGetPersonality, ['deviceId']],
];
