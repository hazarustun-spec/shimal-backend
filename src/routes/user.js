'use strict';

const supabase = require('../config/supabase');
const { buildNatalChart } = require('../services/natal-chart');
const { readJsonBody, writeJson, badRequest, internalError, checkOwnership, checkCronKey } = require('../utils/http');
const { issueNewToken, invalidateTokenCache } = require('../utils/session-token');
const { isValidDeviceId, isValidBirthDate, isValidBirthTime, isValidText, isValidLatitude, isValidLongitude, isValidBirthPlace } = require('../utils/validate');

const { toTR } = require('../utils/zodiac-tr');

async function handleUserRegister(req, res) {
  try {
    const body = await readJsonBody(req);
    const {
      deviceId, birthDate, birthTime, gender, relationshipStatus, workStatus,
      birthPlace, birthLatitude, birthLongitude, preferredName, timezone,
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
    if (!isValidBirthPlace(birthPlace)) {
      return badRequest(res, 'birthPlace en fazla 200 karakter olabilir');
    }
    if (birthLatitude !== undefined && birthLatitude !== null && !isValidLatitude(birthLatitude)) {
      return badRequest(res, 'Geçersiz enlem (-90 ile 90 arası olmalı)');
    }
    if (birthLongitude !== undefined && birthLongitude !== null && !isValidLongitude(birthLongitude)) {
      return badRequest(res, 'Geçersiz boylam (-180 ile 180 arası olmalı)');
    }
    if (typeof gender === 'string' && gender.length > 32) return badRequest(res, 'gender alanı çok uzun');
    if (typeof relationshipStatus === 'string' && relationshipStatus.length > 32) return badRequest(res, 'relationshipStatus alanı çok uzun');
    if (typeof workStatus === 'string' && workStatus.length > 32) return badRequest(res, 'workStatus alanı çok uzun');

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

    const validTz = (typeof timezone === 'string' && timezone.length > 0 && timezone.length < 60)
      ? timezone : null;

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
      ...(validTz && { timezone: validTz }),
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

    // Yeni random session token — DB'ye hash'i yazılır, client raw token saklar
    // Rotation: her register/recover yeni token üretir, eskiyi invalidate eder
    const sessionToken = await issueNewToken(deviceId);

    writeJson(res, 200, {
      success: true,
      sessionToken,
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
    if (!(await checkOwnership(req, res, deviceId))) return;
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
    // Diğer okuma uçları (daily, personality) bu kontrolü yapıyordu, bu yapmıyordu.
    // Sahiplik kontrolü yine de tutuyor ama UUID olmayan girdi buraya kadar
    // gelmemeli — 403 yerine 400 dönmek doğru cevap.
    if (!isValidDeviceId(params.deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!(await checkOwnership(req, res, params.deviceId))) return;

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
    if (!(await checkOwnership(req, res, params.deviceId))) return;

    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id')
      .eq('device_id', params.deviceId)
      .single();

    if (findError || !user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı' });
      return;
    }

    // Token cache'i hemen temizle — silinen kullanıcının cached token'ı geçersiz olmalı
    invalidateTokenCache(params.deviceId);

    // Delete all related data for this user (hata kontrolü ile)
    const { error: fbErr } = await supabase.from('feedback').delete().eq('user_id', user.id);
    if (fbErr) console.error(`[User] feedback silme hatası: ${user.id}`, fbErr.message);
    const { error: insErr } = await supabase.from('daily_insights').delete().eq('user_id', user.id);
    if (insErr) console.error(`[User] insights silme hatası: ${user.id}`, insErr.message);

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
    if (!(await checkOwnership(req, res, deviceId))) return;

    const { data: user, error: findError } = await supabase
      .from('users')
      .select('id')
      .eq('device_id', deviceId)
      .single();

    if (findError || !user) {
      writeJson(res, 404, { error: 'Kullanıcı bulunamadı' });
      return;
    }

    // Token cache'i hemen temizle — silinen kullanıcının cached token'ı geçersiz olmalı
    invalidateTokenCache(deviceId);

    // Delete all related data for this user (hata kontrolü ile)
    const { error: fb2Err } = await supabase.from('feedback').delete().eq('user_id', user.id);
    if (fb2Err) console.error(`[User] feedback silme hatası: ${user.id}`, fb2Err.message);
    const { error: ins2Err } = await supabase.from('daily_insights').delete().eq('user_id', user.id);
    if (ins2Err) console.error(`[User] insights silme hatası: ${user.id}`, ins2Err.message);
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
    // Timing-safe + per-IP brute-force lockout (5 hata → 30dk)
    if (!checkCronKey(req, res)) return;

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

async function handleUpdateProfile(req, res) {
  try {
    const body = await readJsonBody(req);
    const {
      deviceId, birthDate, birthTime, birthPlace,
      birthLatitude, birthLongitude,
      gender, relationshipStatus, workStatus, preferredName,
    } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) return badRequest(res, 'Geçersiz cihaz kimliği');
    if (!(await checkOwnership(req, res, deviceId))) return;

    // Validate optional birth fields if provided
    if (birthDate && !isValidBirthDate(birthDate)) return badRequest(res, 'Geçersiz doğum tarihi');
    if (birthTime && !isValidBirthTime(birthTime)) return badRequest(res, 'Geçersiz doğum saati');
    if (!isValidBirthPlace(birthPlace)) return badRequest(res, 'birthPlace en fazla 200 karakter olabilir');
    if (birthLatitude !== undefined && birthLatitude !== null && !isValidLatitude(birthLatitude)) {
      return badRequest(res, 'Geçersiz enlem');
    }
    if (birthLongitude !== undefined && birthLongitude !== null && !isValidLongitude(birthLongitude)) {
      return badRequest(res, 'Geçersiz boylam');
    }
    if (preferredName !== undefined && preferredName !== null && String(preferredName).length > 100) {
      return badRequest(res, 'preferredName en fazla 100 karakter olabilir');
    }
    if (typeof gender === 'string' && gender.length > 32) return badRequest(res, 'gender alanı çok uzun');
    if (typeof relationshipStatus === 'string' && relationshipStatus.length > 32) return badRequest(res, 'relationshipStatus alanı çok uzun');
    if (typeof workStatus === 'string' && workStatus.length > 32) return badRequest(res, 'workStatus alanı çok uzun');

    // Fetch current user
    const { data: user, error: fetchError } = await supabase
      .from('users')
      .select('id, birth_date, birth_time, birth_latitude, birth_longitude, relationship_status, work_status')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (fetchError || !user) return writeJson(res, 404, { error: 'Kullanıcı bulunamadı' });

    const updateData = { updated_at: new Date().toISOString() };
    let birthDataChanged = false;
    let contextDataChanged = false;

    // Birth fields
    const newBirthDate = birthDate || user.birth_date;
    const newBirthTime = birthTime || user.birth_time;
    const newLat = birthLatitude !== undefined ? birthLatitude : user.birth_latitude;
    const newLon = birthLongitude !== undefined ? birthLongitude : user.birth_longitude;

    if (birthDate && birthDate !== user.birth_date) { updateData.birth_date = birthDate; birthDataChanged = true; }
    if (birthTime && birthTime !== user.birth_time) { updateData.birth_time = birthTime; birthDataChanged = true; }
    if (birthLatitude !== undefined && birthLatitude !== user.birth_latitude) { updateData.birth_latitude = birthLatitude; birthDataChanged = true; }
    if (birthLongitude !== undefined && birthLongitude !== user.birth_longitude) { updateData.birth_longitude = birthLongitude; birthDataChanged = true; }
    if (birthPlace !== undefined) updateData.birth_place = birthPlace;

    // Context fields
    if (relationshipStatus && relationshipStatus !== user.relationship_status) { updateData.relationship_status = relationshipStatus; contextDataChanged = true; }
    if (workStatus && workStatus !== user.work_status) { updateData.work_status = workStatus; contextDataChanged = true; }
    if (gender) updateData.gender = gender;
    if (preferredName !== undefined) updateData.preferred_name = preferredName;

    // Recalculate natal chart if birth data changed
    let natalResult = {};
    if (birthDataChanged) {
      const natalChart = buildNatalChart(newBirthDate, newBirthTime, newLat, newLon);
      updateData.sun_sign = natalChart.sunSign;
      updateData.moon_sign = natalChart.moonSign;
      updateData.ascendant_sign = natalChart.ascendantSign || null;
      updateData.natal_planets = {
        ...natalChart.planets,
        _ascendant: natalChart.ascendant || null,
        _mc: natalChart.mc || null,
      };
      natalResult = {
        sunSign: toTR(natalChart.sunSign),
        moonSign: toTR(natalChart.moonSign),
        ascendantSign: natalChart.ascendantSign ? toTR(natalChart.ascendantSign) : null,
      };
    }

    const { error: updateError } = await supabase.from('users').update(updateData).eq('device_id', deviceId);
    if (updateError) throw updateError;

    // Delete today's insight so it regenerates with new context
    if (birthDataChanged || contextDataChanged) {
      const today = new Date().toISOString().split('T')[0];
      await supabase.from('daily_insights').delete().eq('user_id', user.id).eq('date', today);
      console.log(`[User] Profile updated, deleted today's insight for ${deviceId}`);
    }

    writeJson(res, 200, { success: true, birthDataChanged, contextDataChanged, ...natalResult });
  } catch (error) {
    internalError(res, error, '[User] Update profile error:', 'Profil güncellenemedi');
  }
}

async function handleUserRefreshTime(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId, refreshHour, refreshMinute, timezone } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!(await checkOwnership(req, res, deviceId))) return;

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

async function handleUpdatePremium(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId, isPremium } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (typeof isPremium !== 'boolean') {
      return badRequest(res, 'isPremium boolean olmalı');
    }
    if (!(await checkOwnership(req, res, deviceId))) return;

    const { error } = await supabase
      .from('users')
      .update({ is_premium: isPremium })
      .eq('device_id', deviceId);

    if (error) throw error;

    console.log(`[User] Premium status: ${deviceId} → is_premium=${isPremium}`);
    writeJson(res, 200, { success: true, isPremium });
  } catch (error) {
    internalError(res, error, '[User] Premium update error:', 'Premium durumu güncellenemedi');
  }
}

module.exports = [
  ['POST', /^\/api\/user\/register$/, handleUserRegister],
  ['PUT', /^\/api\/user\/push-token$/, handleUserPushToken],
  ['PUT', /^\/api\/user\/profile$/, handleUpdateProfile],
  ['PUT', /^\/api\/user\/premium$/, handleUpdatePremium],
  ['PUT', /^\/api\/user\/refresh-time$/, handleUserRefreshTime],
  ['POST', /^\/api\/user\/delete$/, handleUserDeletePost],
  ['POST', /^\/api\/user\/migrate-natal$/, handleMigrateNatalCharts],
  ['GET', /^\/api\/user\/([^/]+)$/, handleUserGet, ['deviceId']],
  ['DELETE', /^\/api\/user\/([^/]+)$/, handleUserDelete, ['deviceId']],
];
