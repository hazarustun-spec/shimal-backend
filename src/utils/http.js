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
// SHIMAL_API_KEY_PREVIOUS tanımlıysa o da kabul edilir — yalnızca rotasyon
// geçiş dönemi için. Ayrıntı: aşağıdaki previousKey yorumu.
//
// Returns: true (geçti) / false (response yazıldı)

let _devKeyWarningLogged = false;
let _previousKeyHits = 0;
let _previousKeyLastLog = 0;

// Sabit maliyetli karşılaştırma. Uzunluk farklıysa bile bir timingSafeEqual
// çalıştırıyoruz ki cevap süresi anahtar uzunluğunu sızdırmasın.
function keyMatches(serverKey, clientKey) {
  try {
    if (serverKey.length !== clientKey.length) {
      const dummy = Buffer.alloc(serverKey.length, 0);
      crypto.timingSafeEqual(dummy, Buffer.from(serverKey, 'utf8'));
      return false;
    }
    return crypto.timingSafeEqual(
      Buffer.from(serverKey, 'utf8'),
      Buffer.from(clientKey, 'utf8')
    );
  } catch {
    return false;
  }
}

function checkApiKey(req, res) {
  const serverKey = process.env.SHIMAL_API_KEY;
  // Anahtar rotasyonu için geçiş dönemi anahtarı. Yayınlanmış istemciler eski
  // anahtarı gömülü taşıdığı için yeni anahtara geçerken eskisi bir süre daha
  // kabul edilmeli, yoksa güncellemeyen herkes 401 alır. Yeni sürüm yaygınlaşınca
  // bu değişken silinir — kullanım sayısı loglanıyor ki ne zaman güvenli olduğu
  // görülebilsin.
  const previousKey = process.env.SHIMAL_API_KEY_PREVIOUS;
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

  if (keyMatches(serverKey, clientKey)) return true;

  if (previousKey && keyMatches(previousKey, clientKey)) {
    _previousKeyHits += 1;
    // Saatte bir özet: sıfıra indiğinde SHIMAL_API_KEY_PREVIOUS kaldırılabilir.
    const now = Date.now();
    if (now - _previousKeyLastLog > 3600_000) {
      console.warn(
        `[Security] Eski API anahtarı hâlâ kullanılıyor (son özetten beri ${_previousKeyHits} istek). ` +
        'Sıfırlanınca SHIMAL_API_KEY_PREVIOUS silinebilir.'
      );
      _previousKeyLastLog = now;
      _previousKeyHits = 0;
    }
    return true;
  }

  writeJson(res, 401, { error: 'Geçersiz API anahtarı' });
  return false;
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
// Tek geçerli form: random bytes + DB'de saklanan SHA-256 hash.
// Detaylar: src/utils/session-token.js

const sessionTokenModule = require('./session-token');

// ─── Ownership check ────────────────────────────────────────────────────────
// Ensures the requesting device can only access its own data.
// The mobile app sends x-device-id + x-session-token headers on every request.
//
// Fail-closed: BOTH headers are mandatory on every ownership-checked endpoint,
// reads included. There used to be a "graceful degradation" mode where a
// missing session token was merely logged and let through, so x-api-key plus a
// known device UUID was enough to read another user's row. The API key ships
// inside every IPA and is therefore not a secret, which left those reads
// effectively unauthenticated. There is no client-compat reason to keep the
// escape hatch: the app registers on every cold launch (ContentView.swift:105
// → UserProfileManager.ensureRegistered, gated because hasVerifiedRegistration
// is not persisted) and blocks its UI until the resulting token is stored, so a
// live client always holds one by the time it issues a read.
//
// NOT: Bu fonksiyon ASYNC — DB'den token hash'ini okuyor olabilir.
// Tüm caller'lar `await` etmeli.

async function checkOwnership(req, res, targetDeviceId) {
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
    console.warn(`[Security] No session token — device=${targetDeviceId.substring(0, 8)}... path=${req.url}`);
    writeJson(res, 401, { error: 'Oturum tokenı eksik. Lütfen uygulamayı yeniden başlatın.' });
    return false;
  }

  // verifyToken artık yalnızca true/false döner — DB'deki hash ile eşleşme
  // dışında kabul edilen bir token formu yok.
  if (!(await sessionTokenModule.verifyToken(targetDeviceId, clientToken))) {
    writeJson(res, 401, { error: 'Geçersiz oturum. Lütfen uygulamayı yeniden açın.' });
    return false;
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
  keyMatches,
  checkUserAgent,
  checkOwnership,
  checkCronKey,
  writeJson,
  notFound,
  badRequest,
  internalError,
  readJsonBody,
  getRequestUrl,
};
