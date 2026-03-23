'use strict';

const supabase = require('../config/supabase');
const { calculateDailyTransits } = require('../services/transit-calculator');
const { generateDecisionGuidance } = require('../services/ai-interpreter');
const { readJsonBody, writeJson, badRequest, internalError, checkOwnership } = require('../utils/http');
const { isValidDeviceId, isValidText } = require('../utils/validate');
const { toTR } = require('../utils/zodiac-tr');
const { checkContent } = require('../utils/content-guard');

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

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Valid deviceId is required');
    }
    if (!checkOwnership(req, res, deviceId)) return;
    if (!category) {
      return badRequest(res, 'category is required');
    }
    if (question && !isValidText(question, 500)) {
      return badRequest(res, 'question must be under 500 characters');
    }

    // Content moderation
    if (question) {
      const guard = checkContent(question);
      if (!guard.safe) {
        writeJson(res, 400, { error: guard.reason });
        return;
      }
    }

    const validCategories = ['love', 'career', 'money', 'communication', 'personal'];
    if (!validCategories.includes(category)) {
      return badRequest(res, `Invalid category. Must be one of: ${validCategories.join(', ')}`);
    }

    const user = await getUserByDeviceId(deviceId);
    if (!user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı. Lütfen önce kayıt olun.' });
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
      sunSign: toTR(user.sun_sign),
      moonSign: toTR(user.moon_sign),
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
    internalError(res, error, '[Guidance] Decision guidance error:', 'Karar rehberliği oluşturulamadı');
  }
}

module.exports = [
  ['POST', /^\/api\/guidance\/decision$/, handleDecisionGuidance],
];
