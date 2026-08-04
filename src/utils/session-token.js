'use strict';

// Proper rotatable session tokens (ARCH-1)
//
// Tasarım:
//   1. Token = 32 random byte (hex encoded, 64 char)
//   2. DB'de sadece SHA-256 hash'i saklanır (users.session_token_hash)
//   3. Client raw token'ı Keychain'de tutar, her istekte x-session-token header'ında gönderir
//   4. Server token'ı hash'leyip DB'deki hash ile timing-safe karşılaştırır
//   5. Rotation: yeni random token üret → DB'deki hash'i güncelle → client'a yeni token dön
//
// Legacy HMAC modu KALDIRILDI. Eskiden token, HMAC(SHIMAL_SESSION_SECRET,
// deviceId) olarak da doğrulanabiliyordu. O secret rotasyon sırasında bilerek
// eski API anahtarının değerine sabitlenmişti ve o anahtar düz metin olarak
// sızmıştı — yani token türetilebilir bir değerdi ve sahiplik kontrolünü
// tamamen geçersiz kılıyordu. Türetilebilir bir token, token olmamasıyla
// aynı şey.
//
// Geriye uyumluluk gerekçesi de geçersizdi: istemci her soğuk açılışta
// yeniden register oluyor (ContentView.swift:105) ve DB destekli taze token
// alıyor, alana kadar da arayüzü açmıyor. Legacy'ye bağlı hiçbir akış yok.
//
// Artık token'ın TEK geçerli formu DB'de hash'i saklanan random token.
// DB okunamıyorsa doğrulama başarısız olur (fail-closed) — eskiden burada
// HMAC'e düşülüyordu.
//
// Performans: In-memory cache (15dk TTL) → her request için DB lookup yapmaz.

const crypto = require('crypto');
const supabase = require('../config/supabase');

// ─── Token generation ────────────────────────────────────────────────────────

/** Yeni random session token üretir (raw form, client'a dönülür). */
function generateRandomToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Token'ı SHA-256 ile hash'ler (DB'de saklanan form). */
function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

// ─── In-memory cache (performans için) ──────────────────────────────────────
// DB lookup'ı azaltmak için deviceId → { hash, cachedAt }
// Token rotate edildiğinde invalidate ederiz.

const tokenCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

// Cleanup: süresi dolmuş kayıtları temizle
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tokenCache) {
    if (now - entry.cachedAt > CACHE_TTL_MS) tokenCache.delete(key);
  }
}, 60 * 1000).unref();

function invalidateTokenCache(deviceId) {
  tokenCache.delete(deviceId);
}

// DB erişim hatası sayacı — sürekli hata varsa güvenlik uyarısı logla
let _dbErrorCount = 0;
const DB_ERROR_WARN_THRESHOLD = 5;

async function getStoredTokenHash(deviceId) {
  const cached = tokenCache.get(deviceId);
  if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
    return cached.hash; // null veya string
  }

  try {
    const { data, error } = await supabase
      .from('users')
      .select('session_token_hash')
      .eq('device_id', deviceId)
      .maybeSingle();

    if (error) {
      _dbErrorCount++;
      console.warn(`[SessionToken] DB lookup hatası (${_dbErrorCount}x):`, error.message || error);
      if (_dbErrorCount >= DB_ERROR_WARN_THRESHOLD) {
        console.error('[SessionToken] ⚠️  DB sürekli erişilemiyor — legacy HMAC fallback aktif, güvenlik seviyesi düşük!');
      }
      return undefined; // undefined = bilinmiyor, caller legacy fallback'e düşer
    }

    // DB erişimi başarılı → hata sayacını sıfırla
    if (_dbErrorCount > 0) {
      console.log(`[SessionToken] DB bağlantısı düzeldi (${_dbErrorCount} hata sonrası)`);
      _dbErrorCount = 0;
    }

    const hash = data?.session_token_hash || null;
    tokenCache.set(deviceId, { hash, cachedAt: Date.now() });
    return hash;
  } catch (err) {
    _dbErrorCount++;
    console.warn(`[SessionToken] DB exception (${_dbErrorCount}x):`, err.message || err);
    if (_dbErrorCount >= DB_ERROR_WARN_THRESHOLD) {
      console.error('[SessionToken] ⚠️  DB sürekli erişilemiyor — legacy HMAC fallback aktif, güvenlik seviyesi düşük!');
    }
    return undefined;
  }
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Client'ın gönderdiği raw token'ı doğrular.
 * Return: true → geçerli, false → geçersiz.
 *
 * DB okunamadığında da false döner. Kullanılabilirlik adına HMAC'e düşmek,
 * secret'ı bilen herkese geçerli token üretme imkânı verdiği için kaldırıldı;
 * zaten DB olmadan hiçbir uç anlamlı cevap üretemiyor.
 */
async function verifyToken(deviceId, clientToken) {
  if (!clientToken || typeof clientToken !== 'string') return false;

  const storedHash = await getStoredTokenHash(deviceId);

  // undefined → DB erişilemedi. null → kullanıcının aktif oturumu yok
  // (hiç register olmamış ya da revokeToken çağrılmış). İkisi de reddedilir.
  if (!storedHash) return false;

  const clientHash = hashToken(clientToken);
  try {
    const a = Buffer.from(clientHash, 'hex');
    const b = Buffer.from(storedHash, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ─── Issue / Rotate ──────────────────────────────────────────────────────────

/**
 * Verilen device için yeni random token üretir, DB'ye hash'ini yazar,
 * raw token'ı döner (client'ın saklaması için).
 */
async function issueNewToken(deviceId) {
  const rawToken = generateRandomToken();
  const hash = hashToken(rawToken);

  try {
    const { error } = await supabase
      .from('users')
      .update({
        session_token_hash: hash,
        session_token_rotated_at: new Date().toISOString(),
      })
      .eq('device_id', deviceId);

    if (error) {
      // Hash yazılamadıysa doğrulanabilir bir token da veremeyiz. Eskiden
      // burada legacy HMAC dönülüyordu; o token DB'ye hiç yazılmadığı için
      // sonsuza dek geçerli ve secret'ı bilen herkesçe üretilebilirdi.
      console.error('[SessionToken] Hash update hatası, token verilemedi:', error.message || error);
      return null;
    }

    invalidateTokenCache(deviceId);
    tokenCache.set(deviceId, { hash, cachedAt: Date.now() });
    return rawToken;
  } catch (err) {
    console.error('[SessionToken] Issue exception, token verilemedi:', err.message || err);
    return null;
  }
}

/** Belirli bir device için token'ı iptal eder (logout veya şüpheli aktivite). */
async function revokeToken(deviceId) {
  try {
    await supabase
      .from('users')
      .update({
        session_token_hash: null,
        session_token_rotated_at: new Date().toISOString(),
      })
      .eq('device_id', deviceId);
    invalidateTokenCache(deviceId);
    return true;
  } catch (err) {
    console.warn('[SessionToken] Revoke exception:', err.message || err);
    return false;
  }
}

module.exports = {
  issueNewToken,
  verifyToken,
  revokeToken,
  invalidateTokenCache,
};
