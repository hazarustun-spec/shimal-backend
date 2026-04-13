'use strict';

const { buildNatalChart } = require('../services/natal-chart');
const { calculateDailyTransits } = require('../services/transit-calculator');
const { buildWhyTodayFeelsDifferent } = require('../services/cosmic-context');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');

// In-memory store for demo mode (no Supabase or Claude API required)
const demoUsers = new Map();
const demoInsights = new Map();

async function handleDemoUserRegister(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId, birthDate, birthTime, gender, relationshipStatus, workStatus } = body;

    if (!deviceId || !birthDate) {
      return badRequest(res, 'deviceId and birthDate are required');
    }

    const natalChart = buildNatalChart(birthDate, birthTime);
    const user = {
      id: deviceId,
      device_id: deviceId,
      birth_date: birthDate,
      birth_time: birthTime || '12:00',
      gender: gender || 'not_specified',
      relationship_status: relationshipStatus || 'not_specified',
      work_status: workStatus || 'not_specified',
      sun_sign: natalChart.sunSign,
      moon_sign: natalChart.moonSign,
      natal_planets: natalChart.planets,
      is_premium: false,
    };

    demoUsers.set(deviceId, user);
    writeJson(res, 200, {
      success: true,
      user: {
        id: deviceId,
        sunSign: natalChart.sunSign,
        moonSign: natalChart.moonSign,
        natalSummary: natalChart.summary,
      },
    });
  } catch (error) {
    internalError(res, error, '[Demo] Registration error:', error.message || 'Demo registration failed');
  }
}

async function handleDemoDaily(_req, res, params) {
  try {
    const user = demoUsers.get(params.deviceId);
    if (!user) {
      writeJson(res, 404, { error: 'User not found. Register first via POST /api/demo/user/register' });
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `${params.deviceId}-${today}`;
    if (demoInsights.has(cacheKey)) {
      writeJson(res, 200, demoInsights.get(cacheKey));
      return;
    }

    const transitData = calculateDailyTransits(user.natal_planets);
    const topAspects = transitData.aspects.slice(0, 3);
    const insight = generateTemplateInsight(user, transitData, topAspects);
    demoInsights.set(cacheKey, insight);
    writeJson(res, 200, insight);
  } catch (error) {
    internalError(res, error, '[Demo] Daily insight error:', error.message || 'Demo daily failed');
  }
}

async function handleDemoPushToken(req, res) {
  const body = await readJsonBody(req);
  const { deviceId, pushToken } = body;
  const user = demoUsers.get(deviceId);
  if (user) user.push_token = pushToken;
  writeJson(res, 200, { success: true });
}

function generateTemplateInsight(user, transitData, topAspects) {
  const today = new Date().toISOString().split('T')[0];
  const retrogrades = transitData.retrogrades;
  const hasRetrograde = retrogrades.length > 0;
  const retroNames = retrogrades.map((r) => r.planet).join(', ');

  const challengingAspects = topAspects.filter((a) => a.nature === 'challenging');
  const harmoniousAspects = topAspects.filter((a) => a.nature === 'harmonious');

  const loveTemplates = {
    single: {
      title: harmoniousAspects.length > 0 ? 'Hearts Opening' : 'Gentle Patience',
      short: harmoniousAspects.length > 0
        ? 'The cosmic energy today favors meaningful connections. Stay open to unexpected encounters.'
        : 'Today invites reflection on what you truly desire in partnership. Clarity comes from within.',
      detail: harmoniousAspects.length > 0
        ? `With ${harmoniousAspects[0]?.planet1 || 'Venus'} creating a harmonious flow, your natural magnetism is amplified today. This isn't about seeking — it's about radiating. The people who are meant to notice you will be drawn to your authentic energy. Focus on being fully present in social moments, and let connection happen organically.`
        : `Today's celestial configuration suggests a period of inner alignment before outer connection. This is a powerful time to get clear on your emotional needs and boundaries. Journal, reflect, or simply sit with your feelings. The clarity you gain now becomes the foundation for the love you'll attract.`,
    },
    inRelationship: {
      title: challengingAspects.length > 0 ? 'Navigate Together' : 'Deepening Bonds',
      short: challengingAspects.length > 0
        ? "Minor tensions may surface — they're invitations for honest conversation, not conflict."
        : 'A beautiful day for emotional intimacy. Small gestures carry enormous weight.',
      detail: challengingAspects.length > 0
        ? `The ${challengingAspects[0]?.aspect || 'square'} energy today may bring underlying dynamics to the surface. Rather than reacting, pause and ask: "What is this really about?" Often, small irritations point to deeper needs. Approach your partner with curiosity rather than criticism, and you'll transform a potential friction point into a breakthrough moment.`
        : `Today's planetary alignment supports emotional depth and vulnerability. This is an excellent time for the conversations you've been meaning to have — not heavy ones, but the ones that draw you closer. Share something you've been holding onto, or simply express appreciation. Your partner is more receptive to tenderness than you realize.`,
    },
  };

  const relKey = (user.relationship_status === 'single' || user.relationship_status === 'not_specified')
    ? 'single'
    : 'inRelationship';

  return {
    date: today,
    sunSign: user.sun_sign,
    moonSign: user.moon_sign,
    love: loveTemplates[relKey],
    career: {
      title: hasRetrograde ? 'Strategic Pause' : 'Forward Momentum',
      short: hasRetrograde
        ? `With ${retroNames} retrograde, today favors review and refinement over bold new launches.`
        : 'The cosmic winds are at your back. Trust your professional instincts today.',
      detail: hasRetrograde
        ? `${retroNames} retrograde energy suggests this is a time for strategy rather than action. Review your current projects, revisit unfinished business, and refine your approach. The ideas you polish now will shine brighter when the planets station direct. Don't mistake a pause for stagnation — this is preparation for your next leap.`
        : `Today's planetary alignment supports professional growth and confident decision-making. If you've been waiting for the right moment to pitch an idea, have a conversation, or take initiative — the cosmic timing is favorable. Trust the insights that come to you today, especially during quiet moments. Your intuition is particularly sharp.`,
    },
    energy: {
      title: transitData.transits.Moon ? `Lunar ${transitData.transits.Moon.sign} Energy` : 'Inner Rhythms',
      short: `With the Moon in ${transitData.transits.Moon?.sign || 'transit'}, your energy aligns with ${transitData.transits.Moon?.element || 'cosmic'} qualities today.`,
      detail: `The Moon in ${transitData.transits.Moon?.sign || 'its current position'} colors your emotional and physical energy today. ${transitData.transits.Moon?.element === 'Fire' ? 'You may feel a surge of motivation and enthusiasm. Channel it into physical movement or creative expression.' : transitData.transits.Moon?.element === 'Water' ? "Your sensitivity is heightened. Honor your emotional needs and don't push through fatigue. Gentle self-care is productive today." : transitData.transits.Moon?.element === 'Earth' ? "A grounded, steady energy supports practical accomplishments. You'll find satisfaction in completing tangible tasks and creating order." : 'Mental energy is high. Great conversations, insights, and connections are favored. Stay curious and social.'} Listen to what your body tells you — it knows what you need.`,
    },
    daily_focus: {
      title: topAspects.length > 0 ? 'Cosmic Guidance' : 'Trust Your Path',
      short: topAspects.length > 0
        ? `Key aspect today: ${topAspects[0].planet1} ${topAspects[0].aspect} ${topAspects[0].planet2}. This shapes your daily theme.`
        : 'The stars encourage presence and patience today. Not everything needs to happen at once.',
      detail: topAspects.length > 0
        ? `The most significant transit today is ${topAspects[0].planet1} in ${topAspects[0].aspect} to ${topAspects[0].planet2} (orb: ${topAspects[0].orb}°). This ${topAspects[0].nature} aspect suggests ${topAspects[0].nature === 'harmonious' ? "a natural flow of energy that you can ride like a wave. Don't overthink things — your instincts are aligned with the cosmos. Follow what feels right and trust the process." : "creative tension that wants to be expressed constructively. You may feel pulled in two directions. The key is not to choose one over the other, but to find the synthesis. What feels like a challenge is actually an invitation to grow."}`
        : `Today's cosmic weather is relatively calm, which is a gift in itself. Use this space to align with your deeper intentions. What matters most to you right now? Let that question guide your choices today. Sometimes the most powerful thing you can do is simply show up fully for your ordinary life — the magic is already there.`,
      suggestion: hasRetrograde
        ? `With ${retroNames} retrograde, take 10 minutes to review something you started recently. Fresh eyes reveal hidden improvements.`
        : 'Set one clear intention for today and let it guide your decisions. Simplicity creates power.',
    },
    notificationText: `${user.sun_sign}, ${hasRetrograde ? retroNames + ' retrograde invites you to pause and reflect today.' : 'the stars are aligned for a meaningful day ahead.'}`,
    whyTodayFeelsDifferent: buildWhyTodayFeelsDifferent({
      topAspects,
      retrogrades,
      moon: transitData.transits.Moon,
    }),
  };
}

module.exports = [
  ['POST', /^\/api\/demo\/user\/register$/, handleDemoUserRegister],
  ['GET', /^\/api\/demo\/daily\/([^/]+)$/, handleDemoDaily, ['deviceId']],
  ['PUT', /^\/api\/demo\/user\/push-token$/, handleDemoPushToken],
];
