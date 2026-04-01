'use strict';

const supabase = require('../config/supabase');
const { writeJson, internalError, badRequest, checkOwnership, readJsonBody } = require('../utils/http');
const { isValidDeviceId } = require('../utils/validate');

const VALID_CONTENT_TYPES = ['personality_planet', 'personality_summary', 'daily_focus'];

/**
 * POST /api/user/:deviceId/feedback
 * Body: { contentType, contentId, isPositive }
 */
async function handlePostFeedback(req, res, params) {
  try {
    const { deviceId } = params;
    if (!isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!checkOwnership(req, res, deviceId)) return;

    const body = await readJsonBody(req);
    const { contentType, contentId, isPositive } = body;

    // Validate
    if (!contentType || !VALID_CONTENT_TYPES.includes(contentType)) {
      return badRequest(res, 'Geçersiz content_type');
    }
    if (!contentId || typeof contentId !== 'string' || contentId.length > 100) {
      return badRequest(res, 'Geçersiz content_id');
    }
    if (typeof isPositive !== 'boolean') {
      return badRequest(res, 'isPositive boolean olmalı');
    }

    // Get user
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('device_id', deviceId)
      .single();

    if (userError || !user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı.' });
      return;
    }

    // Check if feedback already exists for this content
    const { data: existing } = await supabase
      .from('feedback')
      .select('id')
      .eq('device_id', deviceId)
      .eq('content_type', contentType)
      .eq('content_id', contentId)
      .single();

    if (existing) {
      // Update existing feedback
      await supabase
        .from('feedback')
        .update({ is_positive: isPositive })
        .eq('id', existing.id);

      writeJson(res, 200, { success: true, updated: true });
    } else {
      // Insert new feedback
      const { error: insertError } = await supabase
        .from('feedback')
        .insert({
          user_id: user.id,
          device_id: deviceId,
          content_type: contentType,
          content_id: contentId,
          is_positive: isPositive,
        });

      if (insertError) {
        console.error('[Feedback] Insert error:', insertError.message);
        writeJson(res, 500, { error: 'Feedback kaydedilemedi.' });
        return;
      }

      writeJson(res, 201, { success: true, updated: false });
    }
  } catch (error) {
    internalError(res, error, '[Feedback] Error:', 'Feedback kaydedilemedi');
  }
}

module.exports = [
  ['POST', /^\/api\/user\/([^/]+)\/feedback$/, handlePostFeedback, ['deviceId']],
];
