'use strict';

const supabase = require('../config/supabase');
const { calculateDailyTransits } = require('../services/transit-calculator');
const { generateDailyInsight, buildFallbackInsight } = require('../services/ai-interpreter');
const { buildWhyTodayFeelsDifferent } = require('../services/cosmic-context');
const { writeJson, internalError, badRequest } = require('../utils/http');

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

async function handleDailyGet(_req, res, params, url) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const user = await getUserByDeviceId(params.deviceId);

    if (!user) {
      writeJson(res, 404, { error: 'User not found. Please complete onboarding first.' });
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
        sunSign: user.sun_sign,
        moonSign: user.moon_sign,
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

    const natalLines = [];
    for (const [planet, data] of Object.entries(user.natal_planets)) {
      const rx = data.isRetrograde ? ' (Rx)' : '';
      natalLines.push(`${planet} in ${data.sign} ${data.degree}°${rx}`);
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
        sunSign: user.sun_sign,
        moonSign: user.moon_sign,
        preferredName: url.searchParams.get('preferredName') || '',
        yesterdayFocus: yesterdayInsight?.daily_focus?.short || null,
      });
    } catch (aiError) {
      console.error(`[Daily] AI generation failed, using fallback. Error: ${aiError.message}\nStack: ${aiError.stack}`);
      insight = buildFallbackInsight(user.sun_sign);
      insight._aiError = aiError.message; // Include error in response for debugging
    }

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

    writeJson(res, 200, applyPremiumGate({
      date: today,
      sunSign: user.sun_sign,
      moonSign: user.moon_sign,
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
    internalError(res, error, '[Daily] Error:', 'Failed to generate daily insight');
  }
}

async function handleDailyGenerateAll(req, res, _params, url) {
  const apiKey = req.headers['x-cron-key'] || url.searchParams.get('key');
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

    for (const user of users) {
      const { data: existing } = await supabase
        .from('daily_insights')
        .select('id')
        .eq('user_id', user.id)
        .eq('date', today)
        .single();

      if (existing) {
        skipped += 1;
        continue;
      }

      try {
        const transitData = calculateDailyTransits(user.natal_planets);
        const natalLines = [];
        for (const [planet, data] of Object.entries(user.natal_planets)) {
          const rx = data.isRetrograde ? ' (Rx)' : '';
          natalLines.push(`${planet} in ${data.sign} ${data.degree}°${rx}`);
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
          sunSign: user.sun_sign,
          moonSign: user.moon_sign,
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
      } catch (err) {
        console.error(`[Daily] Failed for user ${user.id}:`, err.message);
        errors += 1;
      }
    }

    writeJson(res, 200, { date: today, generated, skipped, errors, total: users.length });
  } catch (error) {
    internalError(res, error, '[Daily] Generate all error:', 'Failed to generate daily insights');
  }
}

module.exports = [
  ['GET', /^\/api\/daily\/([^/]+)$/, handleDailyGet, ['deviceId']],
  ['POST', /^\/api\/daily\/generate-all$/, handleDailyGenerateAll],
];
