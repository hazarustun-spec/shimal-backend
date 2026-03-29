'use strict';

const supabase = require('../config/supabase');
const { readJsonBody, writeJson, badRequest, internalError } = require('../utils/http');
const { isValidPhone, isValidEmail, isValidOtp, isValidDeviceId } = require('../utils/validate');

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

// ─── Email OTP ───────────────────────────────────────────────────────────────

async function handleEmailSendOTP(req, res) {
  try {
    const body = await readJsonBody(req);
    const { email } = body;

    if (!email || !isValidEmail(String(email))) {
      return badRequest(res, 'Geçerli bir e-posta adresi girin');
    }

    const { ok, data } = await callSupabaseAuth('/otp', {
      email: String(email).toLowerCase().trim(),
    });

    if (!ok) {
      const rawMessage = data?.msg || data?.error_description || data?.message || '';
      console.error('[Auth] Email OTP failed:', rawMessage);
      writeJson(res, 422, { error: 'Doğrulama kodu gönderilemedi. Lütfen tekrar deneyin.' });
      return;
    }

    console.log(`[Auth] Email OTP sent to ${email}`);
    writeJson(res, 200, { success: true });
  } catch (error) {
    internalError(res, error, '[Auth] Email OTP error:', 'Doğrulama kodu gönderilemedi');
  }
}

async function handleEmailVerifyOTP(req, res) {
  try {
    const body = await readJsonBody(req);
    const { email, code, deviceId } = body;

    if (!email || !isValidEmail(String(email))) {
      return badRequest(res, 'Geçerli bir e-posta adresi girin');
    }
    if (!code || !isValidOtp(String(code))) {
      return badRequest(res, 'Geçerli bir doğrulama kodu girin (6 haneli)');
    }
    if (deviceId && !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const { ok, data } = await callSupabaseAuth('/verify', {
      type: 'email',
      email: normalizedEmail,
      token: String(code),
    });

    if (!ok) {
      const rawMessage = data?.msg || data?.error_description || data?.message || '';
      console.error('[Auth] Email verify failed:', rawMessage);
      writeJson(res, 422, { error: 'Doğrulama kodu hatalı veya süresi dolmuş.' });
      return;
    }

    const supabaseUserId = data?.user?.id;

    // Check if a user record already exists with this email (re-login or account recovery)
    const { data: existingUser } = await supabase
      .from('users')
      .select('device_id, birth_date, birth_time, birth_place, birth_latitude, birth_longitude, preferred_name, gender, relationship_status, work_status, sun_sign, moon_sign, ascendant_sign')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingUser) {
      // Transfer account to new device if deviceId provided
      if (deviceId) {
        await supabase
          .from('users')
          .update({ device_id: deviceId, auth_id: supabaseUserId })
          .eq('email', normalizedEmail);
        console.log(`[Auth] Account recovered: ${normalizedEmail} → new device ${deviceId}`);
      }

      return writeJson(res, 200, {
        success: true,
        recovered: true,
        profile: {
          birthDate: existingUser.birth_date,
          birthTime: existingUser.birth_time,
          birthPlace: existingUser.birth_place || '',
          birthLatitude: existingUser.birth_latitude,
          birthLongitude: existingUser.birth_longitude,
          preferredName: existingUser.preferred_name || '',
          gender: existingUser.gender || 'not_specified',
          relationshipStatus: existingUser.relationship_status || 'not_specified',
          workStatus: existingUser.work_status || 'not_specified',
          sunSign: existingUser.sun_sign || '',
          moonSign: existingUser.moon_sign || '',
          ascendantSign: existingUser.ascendant_sign || '',
        }
      });
    }

    // No existing user → new registration, link email to current device
    if (deviceId && supabaseUserId) {
      try {
        await supabase
          .from('users')
          .update({ auth_id: supabaseUserId, email: normalizedEmail })
          .eq('device_id', deviceId);
      } catch (linkErr) {
        console.warn('[Auth] Could not link email to user:', linkErr.message || linkErr);
      }
    }

    console.log(`[Auth] Email verified (new user): ${normalizedEmail}, userId=${supabaseUserId}`);
    writeJson(res, 200, { success: true, recovered: false, supabaseUserId });
  } catch (error) {
    internalError(res, error, '[Auth] Email verify error:', 'Kod doğrulanamadı');
  }
}

// Account recovery: look up user by email
async function handleLookupByEmail(req, res) {
  try {
    const body = await readJsonBody(req);
    const { email } = body;

    if (!email || !isValidEmail(String(email))) {
      return badRequest(res, 'Geçerli bir e-posta adresi girin');
    }

    const { data: user } = await supabase
      .from('users')
      .select('id, device_id, sun_sign, moon_sign, birth_date, preferred_name')
      .eq('email', String(email).toLowerCase().trim())
      .single();

    if (!user) {
      writeJson(res, 404, { error: 'Hesap bulunamadı' });
      return;
    }

    writeJson(res, 200, { found: true, user });
  } catch (error) {
    internalError(res, error, '[Auth] Email lookup error:', 'Hesap sorgulanamadı');
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
  ['POST', /^\/api\/auth\/email\/send-otp$/, handleEmailSendOTP],
  ['POST', /^\/api\/auth\/email\/verify-otp$/, handleEmailVerifyOTP],
  ['POST', /^\/api\/auth\/lookup-by-phone$/, handleLookupByPhone],
  ['POST', /^\/api\/auth\/lookup-by-email$/, handleLookupByEmail],
];
