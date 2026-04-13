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
    console.log(`[Feedback] POST from device=${deviceId?.substring(0, 8)}...`);

    if (!isValidDeviceId(deviceId)) {
      console.warn(`[Feedback] ✗ Invalid deviceId: ${deviceId}`);
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    // Strict mode: feedback bir mutation, session token zorunlu
    if (!(await checkOwnership(req, res, deviceId, { strict: true }))) {
      console.warn(`[Feedback] ✗ Ownership check failed for device=${deviceId.substring(0, 8)}...`);
      return;
    }

    const body = await readJsonBody(req);
    const { contentType, contentId, isPositive } = body;
    console.log(`[Feedback] type=${contentType} id=${contentId} positive=${isPositive}`);

    // Validate
    if (!contentType || !VALID_CONTENT_TYPES.includes(contentType)) {
      console.warn(`[Feedback] ✗ Invalid contentType: ${contentType}`);
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

      console.log(`[Feedback] ✓ Updated existing feedback id=${existing.id}`);
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
        console.error('[Feedback] ✗ Insert error:', insertError.message);
        writeJson(res, 500, { error: 'Feedback kaydedilemedi.' });
        return;
      }

      console.log(`[Feedback] ✓ New feedback saved for user=${user.id.substring(0, 8)}...`);
      writeJson(res, 201, { success: true, updated: false });
    }
  } catch (error) {
    console.error('[Feedback] ✗ Unhandled error:', error.message);
    internalError(res, error, '[Feedback] Error:', 'Feedback kaydedilemedi');
  }
}

module.exports = [
  ['POST', /^\/api\/user\/([^/]+)\/feedback$/, handlePostFeedback, ['deviceId']],
];
