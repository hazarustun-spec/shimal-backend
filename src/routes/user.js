'use strict';

const supabase = require('../config/supabase');
const { buildNatalChart } = require('../services/natal-chart');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');

async function handleUserRegister(req, res) {
  try {
    const body = await readJsonBody(req);
    const {
      deviceId, birthDate, birthTime, gender, relationshipStatus, workStatus,
      birthPlace, birthLatitude, birthLongitude, preferredName,
    } = body;

    if (!deviceId || !birthDate) {
      return badRequest(res, 'deviceId and birthDate are required');
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
        sunSign: natalChart.sunSign,
        moonSign: natalChart.moonSign,
        natalSummary: natalChart.summary,
      },
    });
  } catch (error) {
    internalError(res, error, '[User] Registration error:', 'Failed to register user');
  }
}

async function handleUserPushToken(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId, pushToken } = body;

    const { error } = await supabase
      .from('users')
      .update({ push_token: pushToken })
      .eq('device_id', deviceId);

    if (error) throw error;
    writeJson(res, 200, { success: true });
  } catch (error) {
    internalError(res, error, '[User] Push token update error:', 'Failed to update push token');
  }
}

async function handleUserGet(_req, res, params) {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('device_id', params.deviceId)
      .single();

    if (error || !user) {
      writeJson(res, 404, { error: 'User not found' });
      return;
    }

    writeJson(res, 200, { user });
  } catch (error) {
    internalError(res, error, '[User] Fetch error:', 'Failed to fetch user');
  }
}

module.exports = [
  ['POST', /^\/api\/user\/register$/, handleUserRegister],
  ['PUT', /^\/api\/user\/push-token$/, handleUserPushToken],
  ['GET', /^\/api\/user\/([^/]+)$/, handleUserGet, ['deviceId']],
];
