'use strict';

const supabase = require('../config/supabase');
const { calculateDailyTransits } = require('../services/transit-calculator');
const { generateDecisionGuidance } = require('../services/ai-interpreter');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');

async function getUserByDeviceId(deviceId) {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('device_id', deviceId)
    .single();
  if (error || !user) return null;
  return user;
}

async function handleDecisionGuidance(req, res) {
  try {
    const body = await readJsonBody(req);
    const {
      deviceId,
      category,
      question = '',
      preferredName = '',
    } = body;

    if (!deviceId || !category) {
      return badRequest(res, 'deviceId and category are required');
    }

    const validCategories = ['love', 'career', 'money', 'communication', 'personal'];
    if (!validCategories.includes(category)) {
      return badRequest(res, `Invalid category. Must be one of: ${validCategories.join(', ')}`);
    }

    if (question && typeof question === 'string' && question.length > 500) {
      return badRequest(res, 'Question must be 500 characters or fewer.');
    }

    const user = await getUserByDeviceId(deviceId);
    if (!user) {
      writeJson(res, 404, { error: 'User not found. Please complete onboarding first.' });
      return;
    }

    const transitData = calculateDailyTransits(user.natal_planets);
    const natalLines = [];
    for (const [planet, data] of Object.entries(user.natal_planets)) {
      const rx = data.isRetrograde ? ' (Rx)' : '';
      natalLines.push(`${planet} in ${data.sign} ${data.degree}°${rx}`);
    }

    const guidance = await generateDecisionGuidance({
      natalSummary: natalLines.join('\n'),
      transitSummary: transitData.summary,
      category,
      question,
      gender: user.gender,
      relationshipStatus: user.relationship_status,
      workStatus: user.work_status,
      sunSign: user.sun_sign,
      moonSign: user.moon_sign,
      preferredName,
    });

    writeJson(res, 200, {
      category,
      status: guidance.status,
      headline: guidance.headline,
      explanation: guidance.explanation,
      practical_advice: guidance.practical_advice,
      best_approach_now: guidance.best_approach_now || null,
      generated_at: new Date().toISOString(),
    });
  } catch (error) {
    internalError(res, error, '[Guidance] Decision guidance error:', 'Failed to generate decision guidance');
  }
}

module.exports = [
  ['POST', /^\/api\/guidance\/decision$/, handleDecisionGuidance],
];
