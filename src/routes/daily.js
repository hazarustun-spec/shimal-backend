'use strict';

const supabase = require('../config/supabase');
const { calculateDailyTransits } = require('../services/transit-calculator');
const { generateDailyInsight, buildFallbackInsight } = require('../services/ai-interpreter');
const { buildWhyTodayFeelsDifferent } = require('../services/cosmic-context');
const { buildNatalChart } = require('../services/natal-chart');
const { writeJson, internalError, badRequest, checkOwnership, checkCronKey } = require('../utils/http');
const { isValidDeviceId } = require('../utils/validate');

const { toTR } = require('../utils/zodiac-tr');

/**
 * Always recalculate natal data fresh from birth fields (timezone-aware).
 * This fixes stale `natal_planets` stored before the timezone-aware fix.
 * Also silently updates the DB in the background so future reads are correct.
 */
function getFreshNatalData(user) {
  if (!user.birth_date) {
    return { natalPlanets: user.natal_planets || {}, ascSign: user.natal_planets?._ascendant?.sign || null };
  }

  try {
    const natalChart = buildNatalChart(
      user.birth_date,
      user.birth_time || '12:00',
      user.birth_latitude  || null,
      user.birth_longitude || null,
    );

    const natalPlanets = {
      ...natalChart.planets,
      _ascendant:    natalChart.ascendant    || null,
      _mc:           natalChart.mc           || null,
      _houses:       natalChart.houses       || null,
      _houseSystem:  natalChart.houseSystem  || null,
      _partOfFortune: natalChart.partOfFortune || null,
      _natalAspects: natalChart.natalAspects || null,
    };

    return { natalPlanets, ascSign: natalChart.ascendantSign || null };
  } catch (err) {
    console.warn(`[Daily] Fresh natal chart failed for user ${user.id}, using stored data:`, err.message);
    return {
      natalPlanets: user.natal_planets || {},
      ascSign: user.natal_planets?._ascendant?.sign || null,
    };
  }
}

// ─── Feedback summary (adaptive prompting) ────────────────────────────────────
// Kullanıcının son 14 gündeki feedback'lerini çekip AI için özet döndürür.
// AI bu özeti görerek kullanıcının hangi tür içerikleri "benimle ilgili değil"
// bulduğunu öğrenir ve bir sonraki üretimde daha dikkatli olur.
async function getFeedbackSummary(userId) {
  try {
    const sinceIso = new Date(Date.now() - 14 * 86400000).toISOString();
    const { data, error } = await supabase
      .from('feedback')
      .select('content_type, is_positive, created_at')
      .eq('user_id', userId)
      .gte('created_at', sinceIso);

    if (error || !Array.isArray(data) || data.length === 0) return null;

    // Bölüm bazında pozitif/negatif say
    const tallies = {}; // { content_type: { pos: n, neg: n } }
    for (const row of data) {
      const type = row.content_type || 'unknown';
      if (!tallies[type]) tallies[type] = { pos: 0, neg: 0 };
      if (row.is_positive) tallies[type].pos++;
      else tallies[type].neg++;
    }

    // Türkçe etiket haritası
    const labelMap = {
      daily_focus:         'günlük odak',
      personality_summary: 'kişilik özeti',
      personality_planet:  'kişilik gezegen yorumu',
      love:                'aşk bölümü',
      career:              'kariyer bölümü',
      energy:              'enerji bölümü',
      health:              'sağlık bölümü',
      money:               'para bölümü',
    };

    const negatives = [];
    const positives = [];
    for (const [type, counts] of Object.entries(tallies)) {
      const label = labelMap[type] || type;
      if (counts.neg > 0) negatives.push(`${label} (${counts.neg} kez "benimle ilgili değil")`);
      if (counts.pos >= 2) positives.push(`${label} (${counts.pos} kez "benimle ilgili")`);
    }

    if (negatives.length === 0 && positives.length === 0) return null;

    return { negatives, positives, totalCount: data.length };
  } catch (err) {
    console.warn('[Daily] Feedback summary hatası:', err.message || err);
    return null;
  }
}

const PLANET_TR = {
  Sun:'Güneş', Moon:'Ay', Mercury:'Merkür', Venus:'Venüs', Mars:'Mars',
  Jupiter:'Jüpiter', Saturn:'Satürn', Uranus:'Uranüs', Neptune:'Neptün', Pluto:'Plüton',
  TrueNode:'Kuzey Düğüm', Chiron:'Chiron', Lilith:'Lilith',
};

function buildNatalLines(natalPlanets) {
  const lines = [];

  const asc = natalPlanets?._ascendant;
  const mc  = natalPlanets?._mc;
  if (asc) lines.push(`Yükselen ${toTR(asc.sign)} burcunda ${asc.degree}°`);
  if (mc)  lines.push(`MC ${toTR(mc.sign)} burcunda ${mc.degree}°`);

  for (const [planet, data] of Object.entries(natalPlanets)) {
    if (planet.startsWith('_') || !data?.sign) continue;
    const rx    = data.isRetrograde ? ' (Rx)' : '';
    const house = data.house ? ` [Ev ${data.house}]` : '';
    lines.push(`${PLANET_TR[planet] || planet} ${toTR(data.sign)} burcunda ${data.degree}°${rx}${house}`);
  }

  const pof = natalPlanets?._partOfFortune;
  if (pof) lines.push(`Pars Fortuna ${toTR(pof.sign)} burcunda ${pof.degree}°`);

  const aspects = natalPlanets?._natalAspects;
  if (aspects?.length) {
    lines.push('\nNatal Açılar:');
    for (const a of aspects.slice(0, 5)) {
      lines.push(`${a.planet1} ${a.symbol} ${a.planet2} (${a.aspect}, orb ${a.orb}°, ${a.nature})`);
    }
  }

  return lines;
}

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

  // Free users see first 2 paragraphs, 3rd paragraph is premium-only
  const gateDetail = (section) => {
    if (!section) return section;
    const detail = section.detail || '';
    // AI paragrafları \n\n ile ayırıyor
    const paragraphs = detail.split(/\n\n+/).filter(p => p.trim());
    const freeDetail = paragraphs.length >= 2
      ? paragraphs.slice(0, 2).join('\n\n')
      : detail; // 2'den az paragraf varsa olduğu gibi göster
    return {
      ...section,
      detail: freeDetail,
      has_premium_content: paragraphs.length >= 3,
    };
  };

  return {
    ...response,
    is_premium: false,
    love: gateDetail(response.love),
    career: gateDetail(response.career),
    energy: gateDetail(response.energy),
    health: gateDetail(response.health),
    money: gateDetail(response.money),
    daily_focus: gateDetail(response.daily_focus),
  };
}

async function handleDailyGet(req, res, params, url) {
  try {
    if (!isValidDeviceId(params.deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!(await checkOwnership(req, res, params.deviceId))) return;

    const today = new Date().toISOString().split('T')[0];
    const user = await getUserByDeviceId(params.deviceId);

    if (!user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı. Lütfen önce kayıt olun.' });
      return;
    }

    // Timezone sessiz güncelleme — uygulama her açıldığında kendiliğinden düzelir
    const clientTz = url.searchParams.get('tz');
    if (clientTz && typeof clientTz === 'string' && clientTz.length < 60 && clientTz !== user.timezone) {
      supabase.from('users').update({ timezone: clientTz }).eq('id', user.id)
        .then(() => console.log(`[Daily] Timezone güncellendi: ${user.id} → ${clientTz}`))
        .catch((err) => console.error(`[Daily] Timezone güncelleme hatası: ${user.id}`, err?.message)); // non-blocking ama logla
      user.timezone = clientTz; // in-memory güncelle (bu istek için geçerli)
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

    // Always recalculate natal chart fresh (timezone-aware) — fixes stale DB data
    const { natalPlanets, ascSign } = getFreshNatalData(user);
    const transitData = calculateDailyTransits(natalPlanets);
    const natalLines  = buildNatalLines(natalPlanets);

    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const { data: yesterdayInsight } = await supabase
      .from('daily_insights')
      .select('daily_focus')
      .eq('user_id', user.id)
      .eq('date', yesterday)
      .single();

    // Son 14 gündeki feedback özeti — AI adaptive tuning için
    const feedbackSummary = await getFeedbackSummary(user.id);

    let insight;
    try {
      insight = await generateDailyInsight({
        natalSummary:       natalLines.join('\n'),
        transitSummary:     transitData.summary,
        gender:             user.gender,
        relationshipStatus: user.relationship_status,
        workStatus:         user.work_status,
        sunSign:            toTR(user.sun_sign),
        moonSign:           toTR(user.moon_sign),
        ascendantSign:      ascSign,
        preferredName:      url.searchParams.get('preferredName') || '',
        birthPlace:         user.birth_place || null,
        yesterdayFocus:     yesterdayInsight?.daily_focus?.short || null,
        feedbackSummary,
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
    // Outer catch — beklenmeyen hata. Kullanıcıyı 500 ile bırakmak yerine
    // fallback içgörü dön (DB'ye kaydedilmez, bir sonraki istekte yeniden denenecek)
    console.error('[Daily] Unexpected error, serving fallback:', error.message);
    try {
      const deviceId = params?.deviceId;
      const { data: fallbackUser } = deviceId
        ? await supabase.from('users').select('sun_sign, moon_sign, is_premium').eq('device_id', deviceId).maybeSingle()
        : { data: null };
      const fallback = buildFallbackInsight(fallbackUser?.sun_sign || 'Aries');
      const today = new Date().toISOString().split('T')[0];
      writeJson(res, 200, applyPremiumGate({
        date: today,
        sunSign: toTR(fallbackUser?.sun_sign || 'Aries'),
        moonSign: toTR(fallbackUser?.moon_sign || 'Aries'),
        love: fallback.love,
        career: fallback.career,
        energy: fallback.energy,
        health: fallback.health || null,
        money: fallback.money || null,
        daily_focus: fallback.daily_focus,
        notification_text: fallback.notification,
        why_today_feels_different: null,
        generated: false,
        _fallback: true,
      }, !!fallbackUser?.is_premium));
    } catch (fallbackErr) {
      internalError(res, error, '[Daily] Error (fallback also failed):', 'Günlük içgörü oluşturulamadı');
    }
  }
}

async function handleDailyGenerateAll(req, res, _params, url) {
  // Timing-safe + per-IP brute-force lockout (5 hata → 30dk)
  if (!checkCronKey(req, res)) return;

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

        // Always recalculate natal chart fresh (timezone-aware)
        const { natalPlanets: batchNatalPlanets, ascSign: batchAscSign } = getFreshNatalData(user);
        const transitData = calculateDailyTransits(batchNatalPlanets);
        const natalLines  = buildNatalLines(batchNatalPlanets);

        const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
        const { data: yesterdayInsight } = await supabase
          .from('daily_insights')
          .select('daily_focus')
          .eq('user_id', user.id)
          .eq('date', yesterday)
          .single();

        const insight = await generateDailyInsight({
          natalSummary:       natalLines.join('\n'),
          transitSummary:     transitData.summary,
          gender:             user.gender,
          relationshipStatus: user.relationship_status,
          workStatus:         user.work_status,
          sunSign:            toTR(user.sun_sign),
          moonSign:           toTR(user.moon_sign),
          ascendantSign:      batchAscSign,
          preferredName:      user.preferred_name || '',
          birthPlace:         user.birth_place || null,
          yesterdayFocus:     yesterdayInsight?.daily_focus?.short || null,
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

  // Always recalculate natal chart fresh (timezone-aware) — fixes stale DB data
  const { natalPlanets: freshNatalPlanets, ascSign: freshAscSign } = getFreshNatalData(user);
  const transitData = calculateDailyTransits(freshNatalPlanets);
  const natalLines  = buildNatalLines(freshNatalPlanets);

  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
  const { data: yesterdayInsight } = await supabase
    .from('daily_insights')
    .select('daily_focus')
    .eq('user_id', user.id)
    .eq('date', yesterday)
    .maybeSingle();

  // Son 14 gündeki feedback özeti — AI adaptive tuning için
  const feedbackSummary = await getFeedbackSummary(user.id);

  const insight = await generateDailyInsight({
    natalSummary:       natalLines.join('\n'),
    transitSummary:     transitData.summary,
    gender:             user.gender,
    relationshipStatus: user.relationship_status,
    workStatus:         user.work_status,
    sunSign:            toTR(user.sun_sign),
    moonSign:           toTR(user.moon_sign),
    ascendantSign:      freshAscSign,
    preferredName:      user.preferred_name || '',
    birthPlace:         user.birth_place || null,
    yesterdayFocus:     yesterdayInsight?.daily_focus?.short || null,
    feedbackSummary,
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

// ─── Failed Insight Helpers ──────────────────────────────────────────────────

/** Başarısız insight üretimini kaydet (upsert — aynı gün tekrar denenebilir) */
async function recordFailedInsight(userId, date, errorMessage) {
  try {
    const { data: existing } = await supabase
      .from('failed_insights')
      .select('attempt_count')
      .eq('user_id', userId)
      .eq('date', date)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('failed_insights')
        .update({
          attempt_count: (existing.attempt_count || 1) + 1,
          last_error:    String(errorMessage || '').slice(0, 500),
          updated_at:    new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('date', date);
    } else {
      await supabase.from('failed_insights').insert({
        user_id:       userId,
        date,
        attempt_count: 1,
        last_error:    String(errorMessage || '').slice(0, 500),
      });
    }
  } catch (err) {
    console.warn('[FailedInsights] Could not record failure:', err.message);
  }
}

/** Başarılı retry sonrası kaydı temizle */
async function clearFailedInsight(userId, date) {
  try {
    await supabase
      .from('failed_insights')
      .delete()
      .eq('user_id', userId)
      .eq('date', date);
  } catch (err) {
    console.warn('[FailedInsights] Could not clear failure record:', err.message);
  }
}

/**
 * Bugün başarısız olan insight'ları yeniden dene.
 * Maksimum 3 toplam deneme (attempt_count < 3 olan kayıtlar).
 */
async function retryFailedInsights(today) {
  const { data: failedRecords, error } = await supabase
    .from('failed_insights')
    .select('user_id, attempt_count')
    .eq('date', today)
    .lt('attempt_count', 3); // 3. deneme dahil, 3'ten fazlasını atlıyoruz

  if (error) throw error;
  if (!failedRecords?.length) return { retried: 0, recovered: 0, stillFailing: 0 };

  const userIds = failedRecords.map(f => f.user_id);
  const { data: users } = await supabase.from('users').select('*').in('id', userIds);
  if (!users?.length) return { retried: 0, recovered: 0, stillFailing: 0 };

  // attempt_count'a hızlı erişim için map
  const attemptMap = Object.fromEntries(failedRecords.map(f => [f.user_id, f.attempt_count]));

  let recovered = 0, stillFailing = 0;
  const BATCH = 3;
  for (let i = 0; i < users.length; i += BATCH) {
    const batch = users.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async (user) => {
      try {
        const result = await generateInsightForUser(user, today);
        if (result && result !== 'skipped') {
          await clearFailedInsight(user.id, today);
          recovered++;
        }
      } catch (err) {
        stillFailing++;
        const newCount = (attemptMap[user.id] || 1) + 1;
        try {
          await supabase
            .from('failed_insights')
            .update({
              attempt_count: newCount,
              last_error:    String(err.message || '').slice(0, 500),
              updated_at:    new Date().toISOString(),
            })
            .eq('user_id', user.id)
            .eq('date', today);
        } catch (_) { /* ignore update error */ }
      }
    }));
    if (i + BATCH < users.length) await new Promise(r => setTimeout(r, 500));
  }

  return { retried: users.length, recovered, stillFailing };
}

module.exports = [
  ['GET', /^\/api\/daily\/([^/]+)$/, handleDailyGet, ['deviceId']],
  ['POST', /^\/api\/daily\/generate-all$/, handleDailyGenerateAll],
];

module.exports.generateInsightForUser = generateInsightForUser;
module.exports.recordFailedInsight    = recordFailedInsight;
module.exports.retryFailedInsights    = retryFailedInsights;
