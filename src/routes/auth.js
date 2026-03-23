'use strict';

const supabase = require('../config/supabase');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');
const { isValidPhone, isValidOtp, isValidDeviceId } = require('../utils/validate');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

function normalizePhone(phoneNumber) {
  return phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
}

async function callSupabaseAuth(path, body) {
  const url = `${SUPABASE_URL}/auth/v1${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { ok: response.ok, status: response.status, data };
}

async function handleSendOTP(req, res) {
  try {
    const body = await readJsonBody(req);
    const { phoneNumber } = body;

    if (!phoneNumber || !isValidPhone(String(phoneNumber))) {
      return badRequest(res, 'Valid phoneNumber is required (7-15 digits, optional + prefix)');
    }

    const phone = normalizePhone(String(phoneNumber));

    const { ok, data } = await callSupabaseAuth('/otp', { phone });

    if (!ok) {
      const rawMessage = data?.msg || data?.error_description || data?.message || '';
      console.error('[Auth] Send OTP failed:', rawMessage);
      // Don't expose internal Supabase error details to client
      writeJson(res, 422, { error: 'Doğrulama kodu gönderilemedi. Lütfen tekrar deneyin.' });
      return;
    }

    console.log(`[Auth] OTP sent to ${phone}`);
    writeJson(res, 200, { success: true });
  } catch (error) {
    internalError(res, error, '[Auth] Send OTP error:', 'Doğrulama kodu gönderilemedi');
  }
}

async function handleVerifyOTP(req, res) {
  try {
    const body = await readJsonBody(req);
    const { phoneNumber, code, deviceId } = body;

    if (!phoneNumber || !isValidPhone(String(phoneNumber))) {
      return badRequest(res, 'Valid phoneNumber is required');
    }
    if (!code || !isValidOtp(String(code))) {
      return badRequest(res, 'Valid verification code is required (4-8 digits)');
    }
    if (deviceId && !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }

    const phone = normalizePhone(String(phoneNumber));

    const { ok, data } = await callSupabaseAuth('/verify', {
      type: 'sms',
      phone,
      token: String(code),
    });

    if (!ok) {
      const rawMessage = data?.msg || data?.error_description || data?.message || '';
      console.error('[Auth] Verify OTP failed:', rawMessage);
      writeJson(res, 422, { error: 'Doğrulama kodu hatalı veya süresi dolmuş.' });
      return;
    }

    const supabaseUserId = data?.user?.id;

    // Link the verified auth identity to this device's user record
    if (deviceId && supabaseUserId) {
      try {
        await supabase
          .from('users')
          .update({ auth_id: supabaseUserId, phone })
          .eq('device_id', deviceId);
      } catch (linkErr) {
        // Non-fatal: auth succeeded, linking is best-effort
        // This will fail until auth_id/phone columns are added to the DB schema
        console.warn('[Auth] Could not link auth_id to user record:', linkErr.message || linkErr);
      }
    }

    console.log(`[Auth] OTP verified for ${phone}, supabaseUserId=${supabaseUserId}`);
    writeJson(res, 200, { success: true, supabaseUserId });
  } catch (error) {
    internalError(res, error, '[Auth] Verify OTP error:', 'Kod doğrulanamadı');
  }
}

// Account recovery: look up user by phone (after re-verifying on reinstall)
async function handleLookupByPhone(req, res) {
  try {
    const body = await readJsonBody(req);
    const { phoneNumber } = body;

    if (!phoneNumber || !isValidPhone(String(phoneNumber))) {
      return badRequest(res, 'Valid phoneNumber is required');
    }

    const phone = normalizePhone(String(phoneNumber));

    const { data: user } = await supabase
      .from('users')
      .select('id, device_id, sun_sign, moon_sign, birth_date, preferred_name')
      .eq('phone', phone)
      .single();

    if (!user) {
      writeJson(res, 404, { error: 'Hesap bulunamadı' });
      return;
    }

    writeJson(res, 200, { found: true, user });
  } catch (error) {
    internalError(res, error, '[Auth] Lookup error:', 'Hesap sorgulanamadı');
  }
}

module.exports = [
  ['POST', /^\/api\/auth\/send-otp$/, handleSendOTP],
  ['POST', /^\/api\/auth\/verify-otp$/, handleVerifyOTP],
  ['POST', /^\/api\/auth\/lookup-by-phone$/, handleLookupByPhone],
];
