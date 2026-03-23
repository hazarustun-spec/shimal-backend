'use strict';

const crypto = require('crypto');

const MAX_BODY_BYTES = 100 * 1024;

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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
  }
}

// ─── API Key authentication ──────────────────────────────────────────────────
// Returns true if allowed, false if rejected (response already sent)

function checkApiKey(req, res) {
  const serverKey = process.env.SHIMAL_API_KEY;
  if (!serverKey) return true; // No key configured = skip check

  const clientKey = req.headers['x-api-key'] || '';

  if (!clientKey) {
    writeJson(res, 401, { error: 'API anahtarı eksik' });
    return false;
  }

  // Timing-safe comparison (pad to same length to avoid length leakage)
  try {
    const maxLen = Math.max(serverKey.length, clientKey.length);
    const a = Buffer.alloc(maxLen, 0);
    const b = Buffer.alloc(maxLen, 0);
    Buffer.from(serverKey, 'utf8').copy(a);
    Buffer.from(clientKey, 'utf8').copy(b);
    if (serverKey.length !== clientKey.length || !crypto.timingSafeEqual(a, b)) {
      writeJson(res, 401, { error: 'Geçersiz API anahtarı' });
      return false;
    }
  } catch {
    writeJson(res, 401, { error: 'Geçersiz API anahtarı' });
    return false;
  }

  return true;
}

// ─── Ownership check ────────────────────────────────────────────────────────
// Ensures the requesting device can only access its own data.
// The mobile app sends x-device-id header on every request.

function checkOwnership(req, res, targetDeviceId) {
  const callerDeviceId = req.headers['x-device-id'] || '';
  if (!callerDeviceId) {
    writeJson(res, 401, { error: 'Cihaz kimliği header\'ı eksik' });
    return false;
  }
  if (callerDeviceId !== targetDeviceId) {
    writeJson(res, 403, { error: 'Bu veriye erişim yetkiniz yok' });
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
  checkOwnership,
  writeJson,
  notFound,
  badRequest,
  internalError,
  readJsonBody,
  getRequestUrl,
};
