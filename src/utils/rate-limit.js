'use strict';

const { writeJson } = require('./http');

// ─── Rate limit tiers ─────────────────────────────────────────────────────────

const TIERS = {
  STRICT:  { windowMs: 60000, max: 3  },  // SMS OTP
  AUTH:    { windowMs: 60000, max: 10 },   // Auth endpoints
  AI:     { windowMs: 60000, max: 5  },   // AI-heavy endpoints
  GENERAL: { windowMs: 60000, max: 60 },   // Everything else
};

// ─── In-memory store (IP → { count, resetAt }) ───────────────────────────────

const stores = {};
for (const tier of Object.keys(TIERS)) {
  stores[tier] = new Map();
}

// Cleanup expired entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const store of Object.values(stores)) {
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key);
    }
  }
}, 60000).unref();

// ─── Get client IP (works behind Railway proxy) ──────────────────────────────

function getClientIp(req) {
  // Railway sets x-forwarded-for. Take the LAST IP (rightmost) which is set by
  // the trusted proxy, not the first which can be spoofed by the client.
  // For Railway: the proxy appends the real client IP as the rightmost entry.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = forwarded.split(',').map(s => s.trim());
    // Use rightmost IP (added by trusted proxy), not leftmost (client-controlled)
    return parts[parts.length - 1] || req.socket?.remoteAddress || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ─── Determine tier from pathname ─────────────────────────────────────────────

function getTier(pathname) {
  if (pathname === '/api/auth/send-otp') return 'STRICT';
  if (pathname.startsWith('/api/auth/')) return 'AUTH';
  if (pathname.startsWith('/api/daily/') || pathname === '/api/guidance/decision') return 'AI';
  if (pathname.startsWith('/api/')) return 'GENERAL';
  return null; // No rate limiting for non-API routes
}

// ─── Check rate limit ─────────────────────────────────────────────────────────
// Returns true if request is allowed, false if rejected (429 already sent)

function checkRateLimit(req, res, pathname) {
  const tierName = getTier(pathname);
  if (!tierName) return true;

  const tier = TIERS[tierName];
  const store = stores[tierName];
  const ip = getClientIp(req);
  const now = Date.now();

  let entry = store.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + tier.windowMs };
    store.set(ip, entry);
  }

  entry.count++;

  if (entry.count > tier.max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    writeJson(res, 429, { error: 'Çok fazla istek. Lütfen biraz sonra tekrar deneyin.' });
    console.log(`[RateLimit] ${tierName} limit hit for ${ip} on ${pathname}`);
    return false;
  }

  return true;
}

module.exports = { checkRateLimit };
