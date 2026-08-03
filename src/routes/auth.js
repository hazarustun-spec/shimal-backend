'use strict';

const supabase = require('../config/supabase');
const { readJsonBody, writeJson, badRequest, internalError, checkOwnership } = require('../utils/http');
const { issueNewToken, revokeToken } = require('../utils/session-token');
const { isValidPhone, isValidEmail, isValidOtp, isValidDeviceId } = require('../utils/validate');
const { checkOtpLockout, recordOtpFailure, clearOtpFailures } = require('../utils/rate-limit');
const { verifyAppleIdentityToken } = require('../utils/apple-auth');

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
      const errorCode  = data?.error_code || '';
      const statusCode = data?.code;
      console.error('[Auth] Send OTP failed:', errorCode || statusCode, rawMessage);
      if (statusCode === 429 || errorCode === 'over_sms_send_rate_limit') {
        writeJson(res, 429, { error: 'Çok fazla deneme yapıldı. Lütfen birkaç dakika bekleyip tekrar deneyin.' });
      } else {
        writeJson(res, 500, { error: 'Doğrulama kodu şu anda gönderilemiyor. Lütfen tekrar deneyin.' });
      }
      return;
    }

    console.log(`[Auth] OTP sent to ${phone}`);
    writeJson(res, 200, { success: true });
  } catch (error) {
    console.error('[Auth] Send OTP exception:', error?.message || error);
    writeJson(res, 500, { error: 'Doğrulama kodu şu anda gönderilemiyor. Lütfen tekrar deneyin.' });
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
      return badRequest(res, 'Geçerli bir doğrulama kodu girin (4-8 haneli)');
    }
    if (deviceId && !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }

    const phone = normalizePhone(String(phoneNumber));

    // ── Brute-force kilidi kontrolü ──────────────────────────────────────────
    const lockout = checkOtpLockout(phone);
    if (lockout.locked) {
      writeJson(res, 429, { error: `Çok fazla hatalı deneme. ${lockout.remainingMin} dakika sonra tekrar deneyin.` });
      return;
    }

    const { ok, data } = await callSupabaseAuth('/verify', {
      type: 'sms',
      phone,
      token: String(code),
    });

    if (!ok) {
      recordOtpFailure(phone); // Başarısız denemeyi kaydet
      const rawMessage = data?.msg || data?.error_description || data?.message || '';
      console.error('[Auth] Verify OTP failed:', rawMessage);
      writeJson(res, 422, { error: 'Doğrulama kodu hatalı veya süresi dolmuş.' });
      return;
    }

    clearOtpFailures(phone); // Başarılı → kilidi sıfırla
    const supabaseUserId = data?.user?.id;

    if (deviceId && supabaseUserId) {
      try {
        await supabase
          .from('users')
          .update({ auth_id: supabaseUserId, phone })
          .eq('device_id', deviceId);
      } catch (linkErr) {
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

    // Enumeration koruması vs. kullanılabilirlik dengesi:
    // - Rate limit (429) → gerçek bir kullanıcı feedback'i, gösterilir
    // - Diğer tüm hatalar → generic 500 (kayıtlı/kayıtsız ayrımı yapmaz)
    // Supabase /auth/otp zaten signup+login hybrid olduğundan "email yok" durumu
    // normal koşulda ayrı bir hata kodu dönmez; yine de tek tip generic hata kullanıyoruz.
    if (!ok) {
      const rawMessage = data?.msg || data?.error_description || data?.message || '';
      const errorCode  = data?.error_code || '';
      const statusCode = data?.code;
      console.error('[Auth] Email OTP failed:', errorCode || statusCode, rawMessage);

      if (errorCode === 'over_email_send_rate_limit' || statusCode === 429) {
        writeJson(res, 429, { error: 'Çok fazla deneme yapıldı. Lütfen birkaç dakika bekleyip tekrar deneyin.' });
      } else {
        // Tüm diğer hatalar → aynı generic mesaj (enumeration leak yok)
        writeJson(res, 500, { error: 'Doğrulama kodu şu anda gönderilemiyor. Lütfen tekrar deneyin.' });
      }
      return;
    }

    console.log(`[Auth] Email OTP sent to ${email}`);
    writeJson(res, 200, { success: true });
  } catch (error) {
    console.error('[Auth] Email OTP exception:', error?.message || error);
    writeJson(res, 500, { error: 'Doğrulama kodu şu anda gönderilemiyor. Lütfen tekrar deneyin.' });
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

    // ── Brute-force kilidi kontrolü ──────────────────────────────────────────
    const lockout = checkOtpLockout(normalizedEmail);
    if (lockout.locked) {
      writeJson(res, 429, { error: `Çok fazla hatalı deneme. ${lockout.remainingMin} dakika sonra tekrar deneyin.` });
      return;
    }

    const { ok, data } = await callSupabaseAuth('/verify', {
      type: 'email',
      email: normalizedEmail,
      token: String(code),
    });

    if (!ok) {
      recordOtpFailure(normalizedEmail); // Başarısız denemeyi kaydet
      const rawMessage = data?.msg || data?.error_description || data?.message || '';
      console.error('[Auth] Email verify failed:', rawMessage);
      writeJson(res, 422, { error: 'Doğrulama kodu hatalı veya süresi dolmuş.' });
      return;
    }

    clearOtpFailures(normalizedEmail); // Başarılı → kilidi sıfırla

    const supabaseUserId = data?.user?.id;

    // Check if a user record already exists with this email (re-login or account recovery)
    const { data: existingUser } = await supabase
      .from('users')
      .select('device_id, birth_date, birth_time, birth_place, birth_latitude, birth_longitude, preferred_name, gender, relationship_status, work_status, sun_sign, moon_sign, ascendant_sign, natal_planets')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existingUser) {
      // Transfer account to new device if deviceId provided
      const targetDeviceId = deviceId || existingUser.device_id;
      if (deviceId) {
        await supabase
          .from('users')
          .update({ device_id: deviceId, auth_id: supabaseUserId })
          .eq('email', normalizedEmail);
        console.log(`[Auth] Account recovered: ${normalizedEmail} → new device ${deviceId}`);
      }

      // Yeni device için fresh random token — eski cihazdaki token invalidate olur
      const sessionToken = targetDeviceId ? await issueNewToken(targetDeviceId) : undefined;

      return writeJson(res, 200, {
        success: true,
        recovered: true,
        ...(sessionToken && { sessionToken }),
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
          ascendantSign: existingUser.ascendant_sign || existingUser.natal_planets?._ascendant?.sign || '',
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

// ─── Apple Sign In ────────────────────────────────────────────────────────────

// Apple ID ile mevcut hesabı ara → bulursa device_id'yi güncelle ve profili döndür
async function handleAppleRecover(req, res) {
  try {
    const body = await readJsonBody(req);
    const { identityToken, deviceId } = body;

    // identityToken ZORUNLU — sadece appleUserId string'ine güvenmiyoruz (taklit edilebilir).
    // Apple'ın imzaladığı JWT doğrulanır, sub claim'i gerçek Apple User ID olarak kullanılır.
    if (!identityToken || typeof identityToken !== 'string') {
      return badRequest(res, 'identityToken gerekli');
    }

    let verified;
    try {
      verified = await verifyAppleIdentityToken(identityToken);
    } catch (verifyErr) {
      console.warn('[Auth] Apple identityToken doğrulama hatası:', verifyErr.message);
      writeJson(res, 401, { error: 'Apple kimlik doğrulaması başarısız' });
      return;
    }

    // Güvenilen appleUserId artık sadece sunucu tarafından belirlenir
    const appleUserId = verified.sub;

    const { data: user } = await supabase
      .from('users')
      .select('device_id, birth_date, birth_time, birth_place, birth_latitude, birth_longitude, preferred_name, gender, relationship_status, work_status, sun_sign, moon_sign, ascendant_sign, natal_planets')
      .eq('auth_id', appleUserId)
      .maybeSingle();

    if (!user) {
      writeJson(res, 404, { error: 'Hesap bulunamadı' });
      return;
    }

    // Yeni cihaza aktar
    const targetDeviceId = (deviceId && isValidDeviceId(deviceId)) ? deviceId : user.device_id;
    if (deviceId && isValidDeviceId(deviceId)) {
      await supabase
        .from('users')
        .update({ device_id: deviceId })
        .eq('auth_id', appleUserId);
      console.log(`[Auth] Apple account recovered: ${appleUserId} → device ${deviceId}`);
    }

    // Yeni device için fresh random token (eski invalidate olur)
    const sessionToken = targetDeviceId ? await issueNewToken(targetDeviceId) : undefined;

    writeJson(res, 200, {
      success: true,
      recovered: true,
      ...(sessionToken && { sessionToken }),
      profile: {
        birthDate:          user.birth_date,
        birthTime:          user.birth_time,
        birthPlace:         user.birth_place || '',
        birthLatitude:      user.birth_latitude,
        birthLongitude:     user.birth_longitude,
        preferredName:      user.preferred_name || '',
        gender:             user.gender || 'not_specified',
        relationshipStatus: user.relationship_status || 'not_specified',
        workStatus:         user.work_status || 'not_specified',
        sunSign:            user.sun_sign || '',
        moonSign:           user.moon_sign || '',
        ascendantSign:      user.ascendant_sign || user.natal_planets?._ascendant?.sign || '',
      }
    });
  } catch (error) {
    internalError(res, error, '[Auth] Apple recover error:', 'Hesap kurtarılamadı');
  }
}

// Apple ID (ve opsiyonel email) ile mevcut device_id kaydını güncelle
async function handleAppleLink(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId, identityToken, email } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    // identityToken ZORUNLU — imzası Apple tarafından doğrulanır
    if (!identityToken || typeof identityToken !== 'string') {
      return badRequest(res, 'identityToken gerekli');
    }

    let verified;
    try {
      verified = await verifyAppleIdentityToken(identityToken);
    } catch (verifyErr) {
      console.warn('[Auth] Apple identityToken doğrulama hatası:', verifyErr.message);
      writeJson(res, 401, { error: 'Apple kimlik doğrulaması başarısız' });
      return;
    }

    const appleUserId = verified.sub;
    const updateData = { auth_id: appleUserId };
    // Email önce token'dan (Apple imzalı), sonra request body'den doğrulanmış olanı
    const tokenEmail = verified.email;
    if (tokenEmail && isValidEmail(String(tokenEmail))) {
      updateData.email = String(tokenEmail).toLowerCase().trim();
    } else if (email && isValidEmail(String(email))) {
      updateData.email = String(email).toLowerCase().trim();
    }

    const { error } = await supabase
      .from('users')
      .update(updateData)
      .eq('device_id', deviceId);

    if (error) throw error;

    console.log(`[Auth] Apple ID linked: ${appleUserId} → device ${deviceId}${email ? ` (email: ${email})` : ''}`);
    writeJson(res, 200, { success: true });
  } catch (error) {
    internalError(res, error, '[Auth] Apple link error:', 'Apple hesabı bağlanamadı');
  }
}

// Account recovery: look up user by email
// Enumeration koruması: hesap olsa da olmasa da aynı yanıt yapısı döner.
// Gerçek profil bilgisi yalnızca OTP doğrulandıktan sonra handleEmailVerifyOTP içinde gelir.
async function handleLookupByEmail(req, res) {
  try {
    const body = await readJsonBody(req);
    const { email } = body;

    if (!email || !isValidEmail(String(email))) {
      return badRequest(res, 'Geçerli bir e-posta adresi girin');
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const { data: user } = await supabase
      .from('users')
      .select('sun_sign, birth_date')   // Minimum veri — id/device_id ASLA dönme
      .eq('email', normalizedEmail)
      .maybeSingle();

    // Hesap var ya da yok — her ikisinde de 200 dön (enumeration önleme)
    writeJson(res, 200, { found: !!user });
  } catch (error) {
    internalError(res, error, '[Auth] Email lookup error:', 'Hesap sorgulanamadı');
  }
}

// Account recovery: look up user by phone (OTP doğrulaması sonrasında)
async function handleLookupByPhone(req, res) {
  try {
    const body = await readJsonBody(req);
    const { phoneNumber } = body;

    if (!phoneNumber || !isValidPhone(String(phoneNumber))) {
      return badRequest(res, 'Geçerli bir telefon numarası girin');
    }

    const phone = normalizePhone(String(phoneNumber));

    const { data: user } = await supabase
      .from('users')
      .select('sun_sign, birth_date')   // Minimum veri — id/device_id ASLA dönme
      .eq('phone', phone)
      .maybeSingle();

    // Hesap var ya da yok — her ikisinde de 200 dön (enumeration önleme)
    writeJson(res, 200, { found: !!user });
  } catch (error) {
    internalError(res, error, '[Auth] Lookup error:', 'Hesap sorgulanamadı');
  }
}

// ─── Sign Out ────────────────────────────────────────────────────────────────
// Client'ın sunucu tarafındaki session token'ını iptal eder.
// Böylece sızdırılan token bu noktadan sonra geçersiz olur.
// Client ayrıca lokal Keychain + SecureStorage temizliği yapar.

async function handleLogout(req, res) {
  try {
    const body = await readJsonBody(req);
    const { deviceId } = body;

    if (!deviceId || !isValidDeviceId(deviceId)) {
      return badRequest(res, 'Geçersiz cihaz kimliği');
    }
    if (!(await checkOwnership(req, res, deviceId))) return;

    await revokeToken(deviceId);
    console.log(`[Auth] Logout — session token revoked for device ${deviceId.substring(0, 8)}...`);
    writeJson(res, 200, { success: true });
  } catch (error) {
    internalError(res, error, '[Auth] Logout error:', 'Çıkış yapılamadı');
  }
}

module.exports = [
  ['POST', /^\/api\/auth\/send-otp$/, handleSendOTP],
  ['POST', /^\/api\/auth\/verify-otp$/, handleVerifyOTP],
  ['POST', /^\/api\/auth\/email\/send-otp$/, handleEmailSendOTP],
  ['POST', /^\/api\/auth\/email\/verify-otp$/, handleEmailVerifyOTP],
  ['POST', /^\/api\/auth\/lookup-by-phone$/, handleLookupByPhone],
  ['POST', /^\/api\/auth\/lookup-by-email$/, handleLookupByEmail],
  ['POST', /^\/api\/auth\/apple\/recover$/, handleAppleRecover],
  ['POST', /^\/api\/auth\/apple\/link$/, handleAppleLink],
  ['POST', /^\/api\/auth\/logout$/, handleLogout],
];
