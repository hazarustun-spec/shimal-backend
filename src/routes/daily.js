'use strict';

const supabase = require('../config/supabase');
const { calculateDailyTransits } = require('../services/transit-calculator');
const { generateDailyInsight, buildFallbackInsight } = require('../services/ai-interpreter');
const { buildWhyTodayFeelsDifferent } = require('../services/cosmic-context');
const { writeJson, internalError, badRequest, checkOwnership } = require('../utils/http');
const { isValidDeviceId } = require('../utils/validate');

const { toTR } = require('../utils/zodiac-tr');

async function getUserByDeviceId(deviceId) {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('device_id', deviceId)
    .single();
  if (error || !user) return null;
  return user;
}

function applyPremiumGate(response, isPremium) {
  if (isPremium) return { ...response, is_premium: true };

  // Free users see the teaser (short) but detail is locked
  const lockDetail = (section) => {
    if (!section) return section;
    return {
      title: section.title,
      short: section.short,
      detail: 'Premium içgörü — devamını okumak için Premium\'a geç.',
    };
  };

  return {
    ...response,
    is_premium: false,
    love: lockDetail(response.love),
    career: lockDetail(response.career),
    energy: lockDetail(response.energy),
    health: lockDetail(response.health),
    money: lockDetail(response.money),
  };
}

async function handleDailyGet(req, res, params, url) {
  try {
    if (!isValidDeviceId(params.deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!checkOwnership(req, res, params.deviceId)) return;

    const today = new Date().toISOString().split('T')[0];
    const user = await getUserByDeviceId(params.deviceId);

    if (!user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı. Lütfen önce kayıt olun.' });
      return;
    }

    const { data: existing } = await supabase
      .from('daily_insights')
      .select('*')
      .eq('user_id', user.id)
      .eq('date', today)
      .single();

    if (existing) {
      writeJson(res, 200, applyPremiumGate({
        date: today,
        sunSign: toTR(user.sun_sign),
        moonSign: toTR(user.moon_sign),
        love: existing.love,
        career: existing.career,
        energy: existing.energy,
        health: existing.health || null,
        money: existing.money || null,
        daily_focus: existing.daily_focus,
        notification_text: existing.notification_text,
        why_today_feels_different: buildWhyTodayFeelsDifferent(existing.transits_used || {}),
        generated: false,
      }, !!user.is_premium));
      return;
    }

    console.log(`[Daily] Generating insight for user ${user.id} (${user.sun_sign})`);
    const transitData = calculateDailyTransits(user.natal_planets);

    const PLANET_TR = {
      Sun:'Güneş', Moon:'Ay', Mercury:'Merkür', Venus:'Venüs', Mars:'Mars',
      Jupiter:'Jüpiter', Saturn:'Satürn', Uranus:'Uranüs', Neptune:'Neptün', Pluto:'Plüton',
      TrueNode:'Kuzey Düğüm', Chiron:'Chiron', Lilith:'Lilith',
    };

    const natalLines = [];

    // Ascendant / MC from stored natal data
    const natalAsc = user.natal_planets?._ascendant;
    const natalMC = user.natal_planets?._mc;
    if (natalAsc) natalLines.push(`Yükselen ${toTR(natalAsc.sign)} burcunda ${natalAsc.degree}°`);
    if (natalMC) natalLines.push(`MC ${toTR(natalMC.sign)} burcunda ${natalMC.degree}°`);

    // Planet positions with house placements
    for (const [planet, data] of Object.entries(user.natal_planets)) {
      if (planet.startsWith('_')) continue; // skip metadata keys
      if (!data || !data.sign) continue;
      const rx = data.isRetrograde ? ' (Rx)' : '';
      const house = data.house ? ` [Ev ${data.house}]` : '';
      const planetTR = PLANET_TR[planet] || planet;
      natalLines.push(`${planetTR} ${toTR(data.sign)} burcunda ${data.degree}°${rx}${house}`);
    }

    // Part of Fortune
    const pof = user.natal_planets?._partOfFortune;
    if (pof) natalLines.push(`Pars Fortuna ${toTR(pof.sign)} burcunda ${pof.degree}°`);

    // Top natal aspects
    const natalAspects = user.natal_planets?._natalAspects;
    if (natalAspects && natalAspects.length > 0) {
      natalLines.push('\nNatal Açılar:');
      const top5 = natalAspects.slice(0, 5);
      for (const a of top5) {
        natalLines.push(`${a.planet1} ${a.symbol} ${a.planet2} (${a.aspect}, orb ${a.orb}°, ${a.nature})`);
      }
    }

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const { data: yesterdayInsight } = await supabase
      .from('daily_insights')
      .select('daily_focus')
      .eq('user_id', user.id)
      .eq('date', yesterday)
      .single();

    let insight;
    try {
      insight = await generateDailyInsight({
        natalSummary: natalLines.join('\n'),
        transitSummary: transitData.summary,
        gender: user.gender,
        relationshipStatus: user.relationship_status,
        workStatus: user.work_status,
        sunSign: toTR(user.sun_sign),
        moonSign: toTR(user.moon_sign),
        ascendantSign: natalAsc?.sign || null,
        preferredName: url.searchParams.get('preferredName') || '',
        yesterdayFocus: yesterdayInsight?.daily_focus?.short || null,
      });
    } catch (aiError) {
      console.error(`[Daily] AI generation failed, using fallback. Error: ${aiError.message}\nStack: ${aiError.stack}`);
      insight = buildFallbackInsight(user.sun_sign);
      insight._isFallback = true;
    }

    // Only save to Supabase if AI actually generated content (not fallback)
    // This way, next app open will retry AI instead of serving stale fallback
    if (!insight._isFallback) {
      const { error: insertError } = await supabase
        .from('daily_insights')
        .insert({
          user_id: user.id,
          date: today,
          love: insight.love,
          career: insight.career,
          energy: insight.energy,
          health: insight.health || null,
          money: insight.money || null,
          daily_focus: insight.daily_focus,
          notification_text: insight.notification,
          transits_used: {
            retrogrades: transitData.retrogrades,
            topAspects: transitData.aspects.slice(0, 5),
          },
        });

      if (insertError) {
        console.error('[Daily] Insert error:', insertError.message);
      }
    } else {
      console.log('[Daily] Fallback served — NOT saving to DB so next request retries AI');
    }
    delete insight._isFallback;

    writeJson(res, 200, applyPremiumGate({
      date: today,
      sunSign: toTR(user.sun_sign),
      moonSign: toTR(user.moon_sign),
      love: insight.love,
      career: insight.career,
      energy: insight.energy,
      health: insight.health || null,
      money: insight.money || null,
      daily_focus: insight.daily_focus,
      notification_text: insight.notification,
      why_today_feels_different: buildWhyTodayFeelsDifferent(transitData),
      generated: true,
    }, !!user.is_premium));
  } catch (error) {
    internalError(res, error, '[Daily] Error:', 'Günlük içgörü oluşturulamadı');
  }
}

async function handleDailyGenerateAll(req, res, _params, url) {
  // Only accept cron key via header (never query param — appears in logs)
  const apiKey = req.headers['x-cron-key'] || '';
  if (!process.env.CRON_API_KEY || apiKey !== process.env.CRON_API_KEY) {
    writeJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const { data: users, error } = await supabase.from('users').select('*');
    if (error) throw error;

    let generated = 0;
    let skipped = 0;
    let errors = 0;

    // Process users in parallel batches of 3 (respects Anthropic rate limits)
    const BATCH_SIZE = 3;
    for (let i = 0; i < users.length; i += BATCH_SIZE) {
      const batch = users.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(batch.map(async (user) => {
        const { data: existing } = await supabase
          .from('daily_insights')
          .select('id')
          .eq('user_id', user.id)
          .eq('date', today)
          .single();

        if (existing) {
          skipped += 1;
          return 'skipped';
        }

        const transitData = calculateDailyTransits(user.natal_planets);

        const BATCH_PLANET_TR = {
          Sun:'Güneş', Moon:'Ay', Mercury:'Merkür', Venus:'Venüs', Mars:'Mars',
          Jupiter:'Jüpiter', Saturn:'Satürn', Uranus:'Uranüs', Neptune:'Neptün', Pluto:'Plüton',
          TrueNode:'Kuzey Düğüm', Chiron:'Chiron', Lilith:'Lilith',
        };

        const natalLines = [];
        const batchAsc = user.natal_planets?._ascendant;
        const batchMC = user.natal_planets?._mc;
        if (batchAsc) natalLines.push(`Yükselen ${toTR(batchAsc.sign)} burcunda ${batchAsc.degree}°`);
        if (batchMC) natalLines.push(`MC ${toTR(batchMC.sign)} burcunda ${batchMC.degree}°`);

        for (const [planet, data] of Object.entries(user.natal_planets)) {
          if (planet.startsWith('_')) continue;
          if (!data || !data.sign) continue;
          const rx = data.isRetrograde ? ' (Rx)' : '';
          const house = data.house ? ` [Ev ${data.house}]` : '';
          const planetTR = BATCH_PLANET_TR[planet] || planet;
          natalLines.push(`${planetTR} ${toTR(data.sign)} burcunda ${data.degree}°${rx}${house}`);
        }

        const batchPof = user.natal_planets?._partOfFortune;
        if (batchPof) natalLines.push(`Pars Fortuna ${toTR(batchPof.sign)} burcunda ${batchPof.degree}°`);

        const batchNatalAspects = user.natal_planets?._natalAspects;
        if (batchNatalAspects && batchNatalAspects.length > 0) {
          natalLines.push('\nNatal Açılar:');
          for (const a of batchNatalAspects.slice(0, 5)) {
            natalLines.push(`${a.planet1} ${a.symbol} ${a.planet2} (${a.aspect}, orb ${a.orb}°, ${a.nature})`);
          }
        }

        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const { data: yesterdayInsight } = await supabase
          .from('daily_insights')
          .select('daily_focus')
          .eq('user_id', user.id)
          .eq('date', yesterday)
          .single();

        const insight = await generateDailyInsight({
          natalSummary: natalLines.join('\n'),
          transitSummary: transitData.summary,
          gender: user.gender,
          relationshipStatus: user.relationship_status,
          workStatus: user.work_status,
          sunSign: toTR(user.sun_sign),
          moonSign: toTR(user.moon_sign),
          ascendantSign: batchAsc?.sign || null,
          preferredName: user.preferred_name || '',
          yesterdayFocus: yesterdayInsight?.daily_focus?.short || null,
        });

        await supabase.from('daily_insights').insert({
          user_id: user.id,
          date: today,
          love: insight.love,
          career: insight.career,
          energy: insight.energy,
          health: insight.health || null,
          money: insight.money || null,
          daily_focus: insight.daily_focus,
          notification_text: insight.notification,
          transits_used: {
            retrogrades: transitData.retrogrades,
            topAspects: transitData.aspects.slice(0, 5),
          },
        });

        generated += 1;
        return 'generated';
      }));

      for (const result of results) {
        if (result.status === 'rejected') {
          console.error(`[Daily] Batch user failed:`, result.reason?.message || result.reason);
          errors += 1;
        }
      }
    }

    writeJson(res, 200, { date: today, generated, skipped, errors, total: users.length });
  } catch (error) {
    internalError(res, error, '[Daily] Generate all error:', 'Günlük içgörüler oluşturulamadı');
  }
}

// ─── Shared helper: generate + save insight for one user ─────────────────────

async function generateInsightForUser(user, today) {
  // Skip if already generated today
  const { data: existing } = await supabase
    .from('daily_insights')
    .select('id')
    .eq('user_id', user.id)
    .eq('date', today)
    .maybeSingle();

  if (existing) return 'skipped';

  const PLANET_TR = {
    Sun:'Güneş', Moon:'Ay', Mercury:'Merkür', Venus:'Venüs', Mars:'Mars',
    Jupiter:'Jüpiter', Saturn:'Satürn', Uranus:'Uranüs', Neptune:'Neptün', Pluto:'Plüton',
    TrueNode:'Kuzey Düğüm', Chiron:'Chiron', Lilith:'Lilith',
  };

  const transitData = calculateDailyTransits(user.natal_planets);
  const natalLines = [];
  const natalAsc = user.natal_planets?._ascendant;
  const natalMC  = user.natal_planets?._mc;
  if (natalAsc) natalLines.push(`Yükselen ${toTR(natalAsc.sign)} burcunda ${natalAsc.degree}°`);
  if (natalMC)  natalLines.push(`MC ${toTR(natalMC.sign)} burcunda ${natalMC.degree}°`);

  for (const [planet, data] of Object.entries(user.natal_planets)) {
    if (planet.startsWith('_') || !data?.sign) continue;
    const rx    = data.isRetrograde ? ' (Rx)' : '';
    const house = data.house ? ` [Ev ${data.house}]` : '';
    natalLines.push(`${PLANET_TR[planet] || planet} ${toTR(data.sign)} burcunda ${data.degree}°${rx}${house}`);
  }

  const pof = user.natal_planets?._partOfFortune;
  if (pof) natalLines.push(`Pars Fortuna ${toTR(pof.sign)} burcunda ${pof.degree}°`);

  const natalAspects = user.natal_planets?._natalAspects;
  if (natalAspects?.length) {
    natalLines.push('\nNatal Açılar:');
    for (const a of natalAspects.slice(0, 5)) {
      natalLines.push(`${a.planet1} ${a.symbol} ${a.planet2} (${a.aspect}, orb ${a.orb}°, ${a.nature})`);
    }
  }

  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const { data: yesterdayInsight } = await supabase
    .from('daily_insights')
    .select('daily_focus')
    .eq('user_id', user.id)
    .eq('date', yesterday)
    .maybeSingle();

  const insight = await generateDailyInsight({
    natalSummary:       natalLines.join('\n'),
    transitSummary:     transitData.summary,
    gender:             user.gender,
    relationshipStatus: user.relationship_status,
    workStatus:         user.work_status,
    sunSign:            toTR(user.sun_sign),
    moonSign:           toTR(user.moon_sign),
    ascendantSign:      natalAsc?.sign || null,
    preferredName:      user.preferred_name || '',
    yesterdayFocus:     yesterdayInsight?.daily_focus?.short || null,
  });

  await supabase.from('daily_insights').insert({
    user_id:           user.id,
    date:              today,
    love:              insight.love,
    career:            insight.career,
    energy:            insight.energy,
    health:            insight.health || null,
    money:             insight.money || null,
    daily_focus:       insight.daily_focus,
    notification_text: insight.notification,
    transits_used: {
      retrogrades: transitData.retrogrades,
      topAspects:  transitData.aspects.slice(0, 5),
    },
  });

  return insight.notification || 'Bugünkü kozmik rehberliğin hazır.';
}

module.exports = [
  ['GET', /^\/api\/daily\/([^/]+)$/, handleDailyGet, ['deviceId']],
  ['POST', /^\/api\/daily\/generate-all$/, handleDailyGenerateAll],
];

module.exports.generateInsightForUser = generateInsightForUser;
