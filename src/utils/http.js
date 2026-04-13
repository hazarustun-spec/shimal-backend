'use strict';

const crypto = require('crypto');

// Sentry — optional, graceful no-op if not initialized
let Sentry;
try { Sentry = require('@sentry/node'); } catch (_) { Sentry = null; }

// Mobile API için max body — en büyük istek register payload'ı (~2KB).
// 32KB tampon bırakıyoruz; daha büyüğü abuse işareti sayılır.
const MAX_BODY_BYTES = 32 * 1024;

// ─── Security headers ────────────────────────────────────────────────────────

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // CORS — only if explicitly configured (mobile API doesn't need it)
  const allowedOrigin = process.env.CORS_ORIGIN;
  if (allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, x-device-id, x-timestamp');
  }
}

// ─── API Key authentication ──────────────────────────────────────────────────
// Tek bir karar kaynağı: SHIMAL_API_KEY env değişkeni.
// Vestigial API_KEY_ENFORCE flag'i kaldırıldı — gereksiz karışıklığa yol açıyordu.
//
// Davranış:
//   • Production (NODE_ENV=production) + key tanımlı değil → 503 (fail-closed)
//   • Production + key tanımlı                            → client x-api-key ZORUNLU, timing-safe karşılaştırma
//   • Development + key tanımlı değil                     → uyarı logla, geç (yerel kolaylık)
//   • Development + key tanımlı                           → production ile aynı katı kural
//
// Returns: true (geçti) / false (response yazıldı)

let _devKeyWarningLogged = false;

function checkApiKey(req, res) {
  const serverKey = process.env.SHIMAL_API_KEY;
  const isProduction = process.env.NODE_ENV === 'production';

  if (!serverKey) {
    if (isProduction) {
      // Production: key olmadan tek bir istek bile geçemez
      console.error('[Security] SHIMAL_API_KEY tanımlanmamış — production\'da zorunlu!');
      writeJson(res, 503, { error: 'Sunucu yapılandırma hatası' });
      return false;
    }
    // Development: tek seferlik uyarı, sonra sessizce geçir
    if (!_devKeyWarningLogged) {
      console.warn('[Security] DEV mode: SHIMAL_API_KEY tanımlı değil — istekler doğrulanmadan geçiyor.');
      _devKeyWarningLogged = true;
    }
    return true;
  }

  const clientKey = req.headers['x-api-key'] || '';
  if (!clientKey) {
    writeJson(res, 401, { error: 'API anahtarı eksik' });
    return false;
  }

  // Timing-safe karşılaştırma (uzunluk sızıntısını önlemek için pad + equal-length kontrol)
  try {
    if (serverKey.length !== clientKey.length) {
      // Timing'ı sabit tutmak için yine de bir karşılaştırma yap
      const dummy = Buffer.alloc(serverKey.length, 0);
      crypto.timingSafeEqual(dummy, Buffer.from(serverKey, 'utf8'));
      writeJson(res, 401, { error: 'Geçersiz API anahtarı' });
      return false;
    }
    if (!crypto.timingSafeEqual(Buffer.from(serverKey, 'utf8'), Buffer.from(clientKey, 'utf8'))) {
      writeJson(res, 401, { error: 'Geçersiz API anahtarı' });
      return false;
    }
  } catch {
    writeJson(res, 401, { error: 'Geçersiz API anahtarı' });
    return false;
  }

  return true;
}

// ─── User-Agent bot koruması ──────────────────────────────────────────────────
// Shimal iOS uygulamasından gelmeyen istekleri tanımla.
// Sert reddetmiyoruz (UA spoofing kolay) ama logluyoruz + şüphelileri işaretliyoruz.

const ALLOWED_UA_PATTERNS = [
  /Shimal/i,           // Kendi uygulamamız
  /CFNetwork/i,        // iOS URLSession default UA
  /Darwin/i,           // iOS sistem UA
];

function checkUserAgent(req) {
  const ua = req.headers['user-agent'] || '';
  // UA yoksa veya tarayıcı UA'sıysa şüpheli logla ama reddetme
  const isKnown = ALLOWED_UA_PATTERNS.some(p => p.test(ua));
  if (!isKnown && ua) {
    console.warn(`[BotDetect] Tanınmayan User-Agent: "${ua.substring(0, 100)}" — IP: ${req.socket?.remoteAddress}`);
  }
  return true; // Sadece logluyoruz, hard reject yok (UA kolayca taklit edilebilir)
}

// ─── Cron key auth (timing-safe + IP lockout + DB persistence) ───────────────
// Cron endpoint'leri API key middleware'ini atladığından brute-force korumasız
// kalıyordu. Bu helper per-IP sayaç tutar: 5 hatalı deneme → 30 dk kilit.
// State Supabase'e write-through edilir → restart sonrası lockout korunur.

const _cronFailures = new Map(); // ip → { failures, lockedUntil }
const CRON_MAX_FAILURES = 5;
const CRON_LOCKOUT_MS   = 30 * 60 * 1000;
let _cronFailurePersistAvailable = true;

// Startup: aktif lockout'ları DB'den yükle
setImmediate(async () => {
  try {
    const supabase = require('../config/supabase');
    const { data, error } = await supabase.from('cron_key_failures')
      .select('ip, failures, locked_until');
    if (error) {
      console.warn('[CronAuth] Lockout DB load hatası:', error.message || error);
      _cronFailurePersistAvailable = false;
      return;
    }
    if (!Array.isArray(data)) return;
    const now = Date.now();
    let loaded = 0;
    for (const row of data) {
      const entry = {
        failures: Number(row.failures) || 0,
        lockedUntil: row.locked_until ? Number(row.locked_until) : null,
      };
      if (entry.lockedUntil && entry.lockedUntil < now && entry.failures === 0) continue;
      _cronFailures.set(row.ip, entry);
      loaded++;
    }
    if (loaded > 0) console.log(`[CronAuth] ${loaded} lockout kaydı DB'den yüklendi`);
  } catch (err) {
    console.warn('[CronAuth] Lockout persistence init hatası:', err.message || err);
    _cronFailurePersistAvailable = false;
  }
});

function _persistCronFailure(ip, entry) {
  if (!_cronFailurePersistAvailable) return;
  const supabase = require('../config/supabase');
  supabase.from('cron_key_failures').upsert({
    ip,
    failures: entry.failures || 0,
    locked_until: entry.lockedUntil || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'ip' }).then((result) => {
    if (result && result.error) {
      console.warn('[CronAuth] Lockout upsert hatası:', result.error.message || result.error);
    }
  }).catch((err) => {
    console.warn('[CronAuth] Lockout upsert exception:', err.message || err);
  });
}

function _clearCronFailure(ip) {
  if (!_cronFailurePersistAvailable) return;
  const supabase = require('../config/supabase');
  supabase.from('cron_key_failures').delete().eq('ip', ip).then((result) => {
    if (result && result.error) {
      console.warn('[CronAuth] Lockout delete hatası:', result.error.message || result.error);
    }
  }).catch((err) => {
    console.warn('[CronAuth] Lockout delete exception:', err.message || err);
  });
}

function _getCronClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = String(forwarded).split(',').map((s) => s.trim());
    return parts[parts.length - 1] || req.socket?.remoteAddress || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

function checkCronKey(req, res) {
  const ip = _getCronClientIp(req);
  const now = Date.now();

  // Lockout kontrolü
  const entry = _cronFailures.get(ip);
  if (entry && entry.lockedUntil && now < entry.lockedUntil) {
    const remainingMin = Math.ceil((entry.lockedUntil - now) / 60000);
    console.warn(`[CronAuth] IP kilitli (${remainingMin}dk kaldı): ${ip}`);
    writeJson(res, 429, { error: 'Çok fazla başarısız deneme. Lütfen daha sonra tekrar deneyin.' });
    return false;
  }

  const serverKey = process.env.CRON_API_KEY;
  if (!serverKey) {
    console.error('[CronAuth] CRON_API_KEY tanımlanmamış');
    writeJson(res, 503, { error: 'Cron auth yapılandırılmamış' });
    return false;
  }

  const clientKey = req.headers['x-cron-key'] || '';
  let valid = false;
  try {
    if (typeof clientKey === 'string' &&
        clientKey.length === serverKey.length &&
        clientKey.length > 0) {
      valid = crypto.timingSafeEqual(
        Buffer.from(clientKey, 'utf8'),
        Buffer.from(serverKey, 'utf8')
      );
    } else {
      // Timing'i sabit tutmak için sahte karşılaştırma
      const dummy = Buffer.alloc(serverKey.length, 0);
      crypto.timingSafeEqual(dummy, Buffer.from(serverKey, 'utf8'));
    }
  } catch {
    valid = false;
  }

  if (!valid) {
    const current = _cronFailures.get(ip) || { failures: 0, lockedUntil: null };
    current.failures++;
    if (current.failures >= CRON_MAX_FAILURES) {
      current.lockedUntil = now + CRON_LOCKOUT_MS;
      console.warn(`[CronAuth] Brute-force kilidi: ${ip} (${current.failures} hata) → 30dk kilit`);
    }
    _cronFailures.set(ip, current);
    _persistCronFailure(ip, current); // DB write-through
    writeJson(res, 401, { error: 'Unauthorized' });
    return false;
  }

  // Başarılı → sayaç sıfırla (memory + DB)
  if (_cronFailures.has(ip)) {
    _cronFailures.delete(ip);
    _clearCronFailure(ip);
  }
  return true;
}

// Cleanup kilit süresi dolan kayıtlar için
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _cronFailures) {
    if (entry.lockedUntil && now > entry.lockedUntil + 60 * 60 * 1000) {
      _cronFailures.delete(ip);
    }
  }
}, 5 * 60 * 1000).unref();

// ─── Session token ───────────────────────────────────────────────────────────
// Proper rotatable tokens: random bytes + DB-stored SHA-256 hash.
// Detaylar: src/utils/session-token.js
// Legacy HMAC tokens backward-compat için hâlâ destekleniyor.

const sessionTokenModule = require('./session-token');

// Legacy export for code that still imports `generateSessionToken`
// (eski register handler'ları vs). Sadece fallback için kullanılır.
function generateSessionToken(deviceId) {
  return sessionTokenModule.legacyHmacToken(deviceId);
}

// ─── Ownership check ────────────────────────────────────────────────────────
// Ensures the requesting device can only access its own data.
// The mobile app sends x-device-id + x-session-token headers on every request.
//
// `strict=true` (opt-in): session token EKSIK olması da 401 üretir.
// Write / mutation endpoint'leri (feedback, profile update, vs.) strict kullanmalı.
// Read endpoint'leri graceful degradation modunda kalabilir (eski istemci uyumu).
//
// NOT: Bu fonksiyon artık ASYNC — DB'den token hash'ini okuyor olabilir.
// Tüm caller'lar `await` etmeli.

async function checkOwnership(req, res, targetDeviceId, options = {}) {
  const strict = options.strict === true;
  const callerDeviceId = req.headers['x-device-id'] || '';
  if (!callerDeviceId) {
    writeJson(res, 401, { error: 'Cihaz kimliği header\'ı eksik' });
    return false;
  }
  if (callerDeviceId !== targetDeviceId) {
    writeJson(res, 403, { error: 'Bu veriye erişim yetkiniz yok' });
    return false;
  }

  // ── Session token doğrulama ───────────────────────────────────────────────
  const clientToken = req.headers['x-session-token'] || '';
  if (!clientToken) {
    if (strict) {
      writeJson(res, 401, { error: 'Oturum tokenı eksik. Lütfen uygulamayı yeniden başlatın.' });
      return false;
    }
    // Graceful degradation: token yoksa eski istemcileri kırmamak için geçir, logla
    console.warn(`[Security] No session token — device=${targetDeviceId.substring(0, 8)}... path=${req.url}`);
    return true;
  }

  const result = await sessionTokenModule.verifyToken(targetDeviceId, clientToken);
  if (result === false) {
    writeJson(res, 401, { error: 'Geçersiz oturum. Lütfen uygulamayı yeniden açın.' });
    return false;
  }
  // result === true (random DB token) veya 'legacy' (HMAC fallback) → ikisi de kabul
  if (result === 'legacy') {
    // Legacy HMAC kullanıcısı — bu request OK ama client'ı DB token'a upgrade etmek için
    // bir sonraki register/recover akışında yeni token dönülecek. Şimdilik dokunma.
    console.log(`[SessionToken] Legacy HMAC token kabul edildi — device=${targetDeviceId.substring(0, 8)}...`);
  }

  return true;
}

// ─── Response helpers ─────────────────────────────────────────────────────────

function writeJson(res, statusCode, payload) {
  setSecurityHeaders(res);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function notFound(res) {
  writeJson(res, 404, { error: 'Bulunamadı' });
}

function badRequest(res, message) {
  writeJson(res, 400, { error: message });
}

function internalError(res, error, prefix, message) {
  console.error(prefix, error?.message || error);
  if (Sentry && error instanceof Error) {
    Sentry.captureException(error, { extra: { prefix, message } });
  }
  writeJson(res, 500, { error: message });
}

// ─── Request parsing ──────────────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });

    req.on('error', reject);
  });
}

function getRequestUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

module.exports = {
  setSecurityHeaders,
  checkApiKey,
  checkUserAgent,
  checkOwnership,
  checkCronKey,
  generateSessionToken,
  writeJson,
  notFound,
  badRequest,
  internalError,
  readJsonBody,
  getRequestUrl,
};
