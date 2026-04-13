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
// Eski HMAC sistemi ile geriye uyumluluk:
//   - Eğer DB'deki session_token_hash NULL ise kullanıcı eski HMAC modunda
//   - Bu durumda legacy HMAC doğrulaması devreye girer
//   - İlk başarılı authenticated request'te otomatik yeni random token'a geçilir
//
// Performans: In-memory cache (15dk TTL) → her request için DB lookup yapmaz.

const crypto = require('crypto');
const supabase = require('../config/supabase');

// ─── Legacy HMAC (backward compat) ───────────────────────────────────────────

function legacyHmacToken(deviceId) {
  const secret = process.env.SHIMAL_SESSION_SECRET || process.env.SHIMAL_API_KEY || 'shimal-dev-secret';
  return crypto.createHmac('sha256', secret).update(deviceId).digest('hex');
}

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
      // DB hatası → cache'i kirletme, fail-open: legacy HMAC yoluna düş
      console.warn('[SessionToken] DB lookup hatası:', error.message || error);
      return undefined; // undefined = bilinmiyor, caller legacy fallback'e düşer
    }

    const hash = data?.session_token_hash || null;
    tokenCache.set(deviceId, { hash, cachedAt: Date.now() });
    return hash;
  } catch (err) {
    console.warn('[SessionToken] DB exception:', err.message || err);
    return undefined;
  }
}

// ─── Verification ────────────────────────────────────────────────────────────

/**
 * Client'ın gönderdiği raw token'ı doğrular.
 * Return:
 *   - true  → geçerli
 *   - false → geçersiz (client yanlış token verdi)
 *   - 'legacy' → DB'de hash yok, eski HMAC eşleşti (upgrade yap)
 */
async function verifyToken(deviceId, clientToken) {
  if (!clientToken || typeof clientToken !== 'string') return false;

  const storedHash = await getStoredTokenHash(deviceId);

  // DB erişilemez → legacy HMAC fallback (fail-open for availability)
  if (storedHash === undefined) {
    return verifyLegacyHmac(deviceId, clientToken) ? 'legacy' : false;
  }

  // DB'de hash var → random token doğrulama
  if (storedHash) {
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

  // DB'de hash null → kullanıcı henüz migrate edilmemiş, legacy HMAC dene
  return verifyLegacyHmac(deviceId, clientToken) ? 'legacy' : false;
}

function verifyLegacyHmac(deviceId, clientToken) {
  const expected = legacyHmacToken(deviceId);
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(clientToken, 'hex');
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
      // DB'ye yazılamadıysa (örn. kolon yoksa) legacy HMAC'e düş
      console.warn('[SessionToken] Hash update hatası, legacy HMAC fallback:', error.message || error);
      return legacyHmacToken(deviceId);
    }

    invalidateTokenCache(deviceId);
    tokenCache.set(deviceId, { hash, cachedAt: Date.now() });
    return rawToken;
  } catch (err) {
    console.warn('[SessionToken] Issue exception, legacy HMAC fallback:', err.message || err);
    return legacyHmacToken(deviceId);
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
  // Legacy export — http.js hâlâ bunu import ediyor olabilir
  legacyHmacToken,
};
