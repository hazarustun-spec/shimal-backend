'use strict';

// Apple Sign In identityToken (JWT) doğrulaması.
// JWT Apple tarafından RS256 ile imzalanır; public key'ler JWKS endpoint'inden çekilir.
// Dış bağımlılık kullanmıyoruz — Node'un built-in crypto modülü yeterli (Node 16+).
//
// Spec: https://developer.apple.com/documentation/sign_in_with_apple/sign_in_with_apple_rest_api/verifying_a_user

const crypto = require('crypto');
const https = require('https');

const JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

// Beklenen audience = iOS uygulamanın bundle ID'si
const EXPECTED_AUDIENCE = process.env.APPLE_BUNDLE_ID || 'com.shimal.app';

// JWKS cache — Apple anahtarlarını sık sık fetch etmemek için 24 saat tutuyoruz
let cachedKeys = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function fetchAppleKeys() {
  return new Promise((resolve, reject) => {
    const req = https.get(JWKS_URL, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Apple JWKS fetch failed: HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (!parsed || !Array.isArray(parsed.keys)) {
            return reject(new Error('Apple JWKS: invalid response shape'));
          }
          resolve(parsed.keys);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Apple JWKS fetch timeout')); });
    req.on('error', reject);
  });
}

async function getAppleKeys(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedKeys && now < cacheExpiry) {
    return cachedKeys;
  }
  const keys = await fetchAppleKeys();
  cachedKeys = keys;
  cacheExpiry = now + CACHE_TTL_MS;
  return keys;
}

function base64UrlDecode(str) {
  return Buffer.from(str, 'base64url');
}

/**
 * Apple identityToken (JWT) doğrular.
 * Başarılıysa { sub, email, emailVerified } döner.
 * Başarısızsa Error fırlatır.
 */
async function verifyAppleIdentityToken(identityToken) {
  if (!identityToken || typeof identityToken !== 'string') {
    throw new Error('Missing identityToken');
  }
  const parts = identityToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed JWT');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    throw new Error('Malformed JWT claims');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported alg: ${header.alg}`);
  }
  if (!header.kid) {
    throw new Error('Missing kid in JWT header');
  }

  // İlgili anahtarı bul — bulunmazsa cache'i tazeleyip bir kez daha dene
  let keys = await getAppleKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await getAppleKeys(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) {
    throw new Error(`Apple public key not found for kid: ${header.kid}`);
  }

  // JWK → KeyObject (Node 16+ destekler)
  let publicKey;
  try {
    publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  } catch (err) {
    throw new Error(`Failed to import Apple public key: ${err.message}`);
  }

  // İmza doğrulama
  const signedData = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = base64UrlDecode(signatureB64);
  const valid = crypto.verify('RSA-SHA256', signedData, publicKey, signature);
  if (!valid) {
    throw new Error('Invalid JWT signature');
  }

  // Claims doğrulama
  if (payload.iss !== APPLE_ISSUER) {
    throw new Error(`Invalid issuer: ${payload.iss}`);
  }
  // aud string veya array olabilir
  const audMatches = Array.isArray(payload.aud)
    ? payload.aud.includes(EXPECTED_AUDIENCE)
    : payload.aud === EXPECTED_AUDIENCE;
  if (!audMatches) {
    throw new Error(`Invalid audience: ${payload.aud}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) {
    throw new Error('Token expired');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Token issued-at in the future');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Missing sub claim');
  }

  return {
    sub: payload.sub,
    email: payload.email || null,
    emailVerified: payload.email_verified === 'true' || payload.email_verified === true,
  };
}

module.exports = { verifyAppleIdentityToken };
