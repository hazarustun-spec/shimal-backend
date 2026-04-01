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

    const natalChart = buildNatalChart(birthDate, birthTime, birthLatitude || null, birthLongitude || null);

    // Store expanded natal data — underscore-prefixed keys for metadata
    const natalPlanetsData = {
      ...natalChart.planets,
      _ascendant: natalChart.ascendant || null,
      _mc: natalChart.mc || null,
      _houses: natalChart.houses || null,
      _houseSystem: natalChart.houseSystem || null,
      _partOfFortune: natalChart.partOfFortune || null,
      _natalAspects: natalChart.natalAspects || null,
    };

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
      ascendant_sign: natalChart.ascendantSign || null,
      natal_planets: natalPlanetsData,
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
        ascendantSign: natalChart.ascendantSign ? toTR(natalChart.ascendantSign) : null,
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

    // Delete all related data for this user
    await supabase.from('feedback').delete().eq('user_id', user.id);
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

    // Delete all related data for this user
    await supabase.from('feedback').delete().eq('user_id', user.id);
    await supabase.from('daily_insights').delete().eq('user_id', user.id);
    const { error: deleteError } = await supabase.from('users').delete().eq('id', user.id);

    if (deleteError) throw deleteError;

    writeJson(res, 200, { success: true, message: 'Hesabınız ve tüm verileriniz silindi.' });
  } catch (error) {
    internalError(res, error, '[User] Delete error:', 'Hesap silinemedi');
  }
}

// ─── Migration: Recalculate natal charts for all users with lat/lon ──────────

async function handleMigrateNatalCharts(req, res) {
  try {
    // Auth: use CRON_API_KEY for admin endpoints
    const cronKey = req.headers['x-cron-key'] || '';
    if (!cronKey || cronKey !== process.env.CRON_API_KEY) {
      writeJson(res, 401, { error: 'Unauthorized' });
      return;
    }

    const { data: users, error } = await supabase
      .from('users')
      .select('id, device_id, birth_date, birth_time, birth_latitude, birth_longitude')
      .not('birth_latitude', 'is', null)
      .not('birth_longitude', 'is', null);

    if (error) throw error;
    if (!users || users.length === 0) {
      writeJson(res, 200, { message: 'No users with coordinates found', migrated: 0 });
      return;
    }

    let migrated = 0;
    let skipped = 0;
    const errors = [];

    for (const user of users) {
      try {
        const natalChart = buildNatalChart(
          user.birth_date,
          user.birth_time,
          user.birth_latitude,
          user.birth_longitude
        );

        const natalPlanetsData = {
          ...natalChart.planets,
          _ascendant: natalChart.ascendant || null,
          _mc: natalChart.mc || null,
          _houses: natalChart.houses || null,
          _houseSystem: natalChart.houseSystem || null,
          _partOfFortune: natalChart.partOfFortune || null,
          _natalAspects: natalChart.natalAspects || null,
        };

        const { error: updateError } = await supabase
          .from('users')
          .update({
            sun_sign: natalChart.sunSign,
            moon_sign: natalChart.moonSign,
            ascendant_sign: natalChart.ascendantSign || null,
            natal_planets: natalPlanetsData,
          })
          .eq('id', user.id);

        if (updateError) throw updateError;
        migrated++;
      } catch (err) {
        skipped++;
        errors.push({ userId: user.id, error: err.message });
      }
    }

    console.log(`[Migration] Natal chart recalculation: ${migrated} migrated, ${skipped} skipped`);
    writeJson(res, 200, { migrated, skipped, total: users.length, errors: errors.slice(0, 10) });
  } catch (error) {
    internalError(res, error, '[Migration] Error:', 'Migration failed');
  }
}

async function handleUserRefreshTime(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId, refreshHour, refreshMinute, timezone } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!checkOwnership(req, res, deviceId)) return;

    const hour   = Number(refreshHour);
    const minute = Number(refreshMinute);
    if (!Number.isInteger(hour)   || hour   < 0 || hour   > 23) return badRequest(res, 'Geçersiz saat (0-23)');
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return badRequest(res, 'Geçersiz dakika (0-59)');

    const tz = (typeof timezone === 'string' && timezone.length > 0 && timezone.length < 60)
      ? timezone
      : 'Europe/Istanbul';

    const { error } = await supabase
      .from('users')
      .update({ refresh_hour: hour, refresh_minute: minute, timezone: tz })
      .eq('device_id', deviceId);

    if (error) throw error;

    console.log(`[User] Refresh time set: ${deviceId} → ${hour}:${String(minute).padStart(2,'0')} (${tz})`);
    writeJson(res, 200, { success: true });
  } catch (error) {
    internalError(res, error, '[User] Refresh time error:', 'Yenileme saati güncellenemedi');
  }
}

module.exports = [
  ['POST', /^\/api\/user\/register$/, handleUserRegister],
  ['PUT', /^\/api\/user\/push-token$/, handleUserPushToken],
  ['PUT', /^\/api\/user\/refresh-time$/, handleUserRefreshTime],
  ['POST', /^\/api\/user\/delete$/, handleUserDeletePost],
  ['POST', /^\/api\/user\/migrate-natal$/, handleMigrateNatalCharts],
  ['GET', /^\/api\/user\/([^/]+)$/, handleUserGet, ['deviceId']],
  ['DELETE', /^\/api\/user\/([^/]+)$/, handleUserDelete, ['deviceId']],
];
