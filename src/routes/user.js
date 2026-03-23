'use strict';

const supabase = require('../config/supabase');
const { buildNatalChart } = require('../services/natal-chart');
const { readJsonBody, writeJson, badRequest, internalError, checkOwnership } = require('../utils/http');
const { isValidDeviceId, isValidBirthDate, isValidBirthTime, isValidText } = require('../utils/validate');

const { toTR } = require('../utils/zodiac-tr');

async function handleUserRegister(req, res) {
  try {
    const body = await readJsonBody(req);
    const {
      deviceId, birthDate, birthTime, gender, relationshipStatus, workStatus,
      birthPlace, birthLatitude, birthLongitude, preferredName,
    } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Valid deviceId is required');
    }
    if (!birthDate || !isValidBirthDate(birthDate)) {
      return badRequest(res, 'Geçerli doğum tarihi gerekli (YYYY-AA-GG, 1900 ile bugün arası)');
    }
    if (birthTime && !isValidBirthTime(birthTime)) {
      return badRequest(res, 'Geçersiz doğum saati (SS:DD)');
    }
    if (preferredName && !isValidText(preferredName, 100)) {
      return badRequest(res, 'preferredName must be under 100 characters');
    }

    const natalChart = buildNatalChart(birthDate, birthTime);

    const userData = {
      device_id: deviceId,
      birth_date: birthDate,
      birth_time: birthTime || '12:00',
      birth_place: birthPlace || null,
      birth_latitude: birthLatitude || null,
      birth_longitude: birthLongitude || null,
      preferred_name: preferredName || null,
      gender: gender || 'not_specified',
      relationship_status: relationshipStatus || 'not_specified',
      work_status: workStatus || 'not_specified',
      sun_sign: natalChart.sunSign,
      moon_sign: natalChart.moonSign,
      natal_planets: natalChart.planets,
      updated_at: new Date().toISOString(),
    };

    const { data: existing } = await supabase
      .from('users')
      .select('id')
      .eq('device_id', deviceId)
      .single();

    let user;
    if (existing) {
      const { data, error } = await supabase
        .from('users')
        .update(userData)
        .eq('device_id', deviceId)
        .select()
        .single();
      if (error) throw error;
      user = data;
    } else {
      const { data, error } = await supabase
        .from('users')
        .insert(userData)
        .select()
        .single();
      if (error) throw error;
      user = data;
    }

    writeJson(res, 200, {
      success: true,
      user: {
        id: user.id,
        sunSign: toTR(natalChart.sunSign),
        moonSign: toTR(natalChart.moonSign),
        natalSummary: natalChart.summary,
      },
    });
  } catch (error) {
    internalError(res, error, '[User] Registration error:', 'Kullanıcı kaydı başarısız');
  }
}

async function handleUserPushToken(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId, pushToken } = body;

    if (!isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!checkOwnership(req, res, deviceId)) return;
    if (!pushToken || typeof pushToken !== 'string' || pushToken.length < 10 || pushToken.length > 200) {
      return badRequest(res, 'Geçersiz bildirim token formatı');
    }

    const { error } = await supabase
      .from('users')
      .update({ push_token: pushToken })
      .eq('device_id', deviceId);

    if (error) throw error;
    writeJson(res, 200, { success: true });
  } catch (error) {
    internalError(res, error, '[User] Push token update error:', 'Bildirim token güncellenemedi');
  }
}

async function handleUserGet(req, res, params) {
  try {
    if (!checkOwnership(req, res, params.deviceId)) return;

    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('device_id', params.deviceId)
      .single();

    if (error || !user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı' });
      return;
    }

    writeJson(res, 200, { user });
  } catch (error) {
    internalError(res, error, '[User] Fetch error:', 'Kullanıcı bilgisi alınamadı');
  }
}

async function handleUserDelete(req, res, params) {
  try {
    if (!isValidDeviceId(params.deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!checkOwnership(req, res, params.deviceId)) return;

    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id')
      .eq('device_id', params.deviceId)
      .single();

    if (findError || !user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı' });
      return;
    }

    // Delete all daily insights for this user
    await supabase.from('daily_insights').delete().eq('user_id', user.id);

    // Delete the user record
    const { error: deleteError } = await supabase.from('users').delete().eq('id', user.id);

    if (deleteError) throw deleteError;

    writeJson(res, 200, { success: true, message: 'Hesabınız ve tüm verileriniz silindi.' });
  } catch (error) {
    internalError(res, error, '[User] Delete error:', 'Hesap silinemedi');
  }
}

// POST-based delete — deviceId in body instead of URL path (privacy: no PII in access logs)
async function handleUserDeletePost(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!checkOwnership(req, res, deviceId)) return;

    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id')
      .eq('device_id', deviceId)
      .single();

    if (findError || !user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı' });
      return;
    }

    await supabase.from('daily_insights').delete().eq('user_id', user.id);
    const { error: deleteError } = await supabase.from('users').delete().eq('id', user.id);

    if (deleteError) throw deleteError;

    writeJson(res, 200, { success: true, message: 'Hesabınız ve tüm verileriniz silindi.' });
  } catch (error) {
    internalError(res, error, '[User] Delete error:', 'Hesap silinemedi');
  }
}

module.exports = [
  ['POST', /^\/api\/user\/register$/, handleUserRegister],
  ['PUT', /^\/api\/user\/push-token$/, handleUserPushToken],
  ['POST', /^\/api\/user\/delete$/, handleUserDeletePost],
  ['GET', /^\/api\/user\/([^/]+)$/, handleUserGet, ['deviceId']],
  ['DELETE', /^\/api\/user\/([^/]+)$/, handleUserDelete, ['deviceId']],
];
