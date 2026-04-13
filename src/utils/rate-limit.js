'use strict';

const { writeJson } = require('./http');
const supabase = require('../config/supabase');

// ─── Rate limit tiers (IP-based) ─────────────────────────────────────────────

const TIERS = {
  STRICT:  { windowMs: 60000,  max: 3  },  // SMS OTP gönderimi
  AUTH:    { windowMs: 60000,  max: 10 },  // Diğer auth endpoint'leri
  AI:      { windowMs: 60000,  max: 5  },  // AI-heavy endpoint'ler
  COMPUTE: { windowMs: 60000,  max: 15 },  // Gezegensel hesaplama (transits/cosmic/compat/geomag)
  GENERAL: { windowMs: 60000,  max: 60 },  // Genel API
};

// ─── In-memory store ──────────────────────────────────────────────────────────

const stores = {};
for (const tier of Object.keys(TIERS)) {
  stores[tier] = new Map();
}

// Per-device-ID store (AI / AUTH / COMPUTE endpoint'leri için ek koruma)
const deviceStores = {
  AUTH:    new Map(),  // max 5 / 5dk device başına
  AI:      new Map(),  // max 10 / dk device başına
  COMPUTE: new Map(),  // max 20 / 5dk device başına
};

// OTP brute-force lockout: identifier (phone/email) → { failures, lockedUntil }
const otpLockouts = new Map();

// Bot tespit: IP → son X dakikadaki benzersiz device ID'leri
const ipDeviceMap = new Map(); // ip → Set<deviceId>

// Dağıtık saldırı koruması: /24 subnet → OTP send sayacı
const subnetOtpStore = new Map(); // subnet → { count, resetAt }

// Cleanup her 60s
setInterval(() => {
  const now = Date.now();
  for (const store of Object.values(stores)) {
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key);
    }
  }
  for (const store of Object.values(deviceStores)) {
    for (const [key, entry] of store) {
      if (now >= entry.resetAt) store.delete(key);
    }
  }
  for (const [key, entry] of otpLockouts) {
    if (!entry.lockedUntil || now > entry.lockedUntil) {
      if (entry.failures < 3) otpLockouts.delete(key);
    }
  }
  for (const [key, entry] of ipDeviceMap) {
    if (now >= entry.resetAt) ipDeviceMap.delete(key);
  }
  for (const [key, entry] of subnetOtpStore) {
    if (now >= entry.resetAt) subnetOtpStore.delete(key);
  }
}, 60000).unref();

// ─── /24 subnet OTP send limiti (botnet koruması) ────────────────────────────

function getSubnet(ip) {
  // IPv4: 192.168.1.42 → 192.168.1
  // IPv6: ilk 64 bit → sadeleştirilmiş, tek düze
  if (!ip || ip === 'unknown') return null;
  if (ip.includes('.')) {
    const parts = ip.split('.');
    if (parts.length === 4) return parts.slice(0, 3).join('.');
  }
  if (ip.includes(':')) {
    return ip.split(':').slice(0, 4).join(':');
  }
  return ip;
}

function checkSubnetOtpLimit(req, res) {
  const subnet = getSubnet(getClientIp(req));
  if (!subnet) return true;

  const WINDOW = 10 * 60 * 1000; // 10 dk
  const MAX    = 20;              // /24 subnetten max 20 OTP send / 10 dk
  const now = Date.now();

  let entry = subnetOtpStore.get(subnet);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW };
    subnetOtpStore.set(subnet, entry);
  }
  entry.count++;

  if (entry.count > MAX) {
    console.warn(`[RateLimit/Subnet] ${subnet}/24 OTP spam: ${entry.count} istek / 10 dk`);
    writeJson(res, 429, { error: 'Çok fazla istek. Lütfen biraz sonra tekrar deneyin.' });
    return false;
  }
  return true;
}

// ─── IP tespiti (Railway proxy arkasında çalışır) ─────────────────────────────

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const parts = forwarded.split(',').map(s => s.trim());
    return parts[parts.length - 1] || req.socket?.remoteAddress || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ─── Endpoint → tier eşleme ───────────────────────────────────────────────────

function getTier(pathname) {
  if (pathname === '/api/auth/send-otp' || pathname === '/api/auth/email/send-otp') return 'STRICT';
  if (pathname.startsWith('/api/auth/')) return 'AUTH';
  if (pathname.startsWith('/api/daily/') || pathname === '/api/guidance/decision') return 'AI';
  // CPU-heavy gezegensel hesaplama endpoint'leri
  if (pathname.startsWith('/api/transits/') ||
      pathname.startsWith('/api/cosmic-weather') ||
      pathname.startsWith('/api/compatibility') ||
      pathname.startsWith('/api/geomagnetic')) return 'COMPUTE';
  if (pathname.startsWith('/api/')) return 'GENERAL';
  return null;
}

// ─── IP tabanlı rate limit ────────────────────────────────────────────────────

function checkIpRateLimit(req, res, pathname) {
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
    console.warn(`[RateLimit/IP] ${tierName} limit aşıldı: ${ip} → ${pathname}`);
    return false;
  }

  return true;
}

// ─── Device-ID tabanlı ek rate limit (bot'lar için) ──────────────────────────

function checkDeviceRateLimit(req, res, pathname) {
  const deviceId = req.headers['x-device-id'];
  if (!deviceId) return true; // Device ID yoksa IP limiti yeterli

  const tierName = getTier(pathname);
  if (tierName !== 'AUTH' && tierName !== 'AI' && tierName !== 'COMPUTE') return true;

  const limits = {
    AUTH:    { windowMs: 300000, max: 5 },
    AI:      { windowMs: 60000,  max: 10 },
    COMPUTE: { windowMs: 300000, max: 20 },
  };
  const limit = limits[tierName];
  const store = deviceStores[tierName];
  const now = Date.now();

  let entry = store.get(deviceId);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + limit.windowMs };
    store.set(deviceId, entry);
  }

  entry.count++;

  if (entry.count > limit.max) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    writeJson(res, 429, { error: 'Çok fazla istek. Lütfen biraz sonra tekrar deneyin.' });
    console.warn(`[RateLimit/Device] ${tierName} limit aşıldı: ${deviceId} → ${pathname}`);
    return false;
  }

  return true;
}

// ─── Bot tespiti: tek IP'den çok sayıda farklı device ID ─────────────────────

function checkBotPattern(req, res) {
  const ip = getClientIp(req);
  const deviceId = req.headers['x-device-id'];
  if (!deviceId || !ip || ip === 'unknown') return true;

  const now = Date.now();
  const WINDOW = 5 * 60 * 1000; // 5 dakika
  const MAX_DEVICES_PER_IP = 8;  // Bir IP'den max 8 farklı device

  let entry = ipDeviceMap.get(ip);
  if (!entry || now >= entry.resetAt) {
    entry = { devices: new Set(), resetAt: now + WINDOW };
    ipDeviceMap.set(ip, entry);
  }

  entry.devices.add(deviceId);

  if (entry.devices.size > MAX_DEVICES_PER_IP) {
    console.warn(`[BotDetect] Şüpheli IP: ${ip} → ${entry.devices.size} farklı device ID (5dk içinde)`);
    writeJson(res, 429, { error: 'Şüpheli aktivite tespit edildi. Lütfen daha sonra tekrar deneyin.' });
    return false;
  }

  return true;
}

// ─── OTP Brute-force koruması ─────────────────────────────────────────────────
// identifier: normalleştirilmiş phone veya email
// Başarısız her denemede sayacı artır. 5 hatalı denemede 15 dk kilit.

const OTP_MAX_FAILURES = 5;
// Üstel kilit: 1. kilit 15dk, 2. kilit 1sa, 3+ kilit 24sa
const OTP_LOCKOUT_LADDER_MS = [
  15 * 60 * 1000,        // 15 dk
  60 * 60 * 1000,        // 1 saat
  24 * 60 * 60 * 1000,   // 24 saat
];

function checkOtpLockout(identifier) {
  const entry = otpLockouts.get(identifier);
  if (!entry) return { locked: false };

  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const remainingMs = entry.lockedUntil - Date.now();
    const remainingMin = Math.ceil(remainingMs / 60000);
    return { locked: true, remainingMin };
  }

  return { locked: false };
}

function recordOtpFailure(identifier) {
  const now = Date.now();
  let entry = otpLockouts.get(identifier) || { failures: 0, lockouts: 0, lockedUntil: null };
  entry.failures++;

  if (entry.failures >= OTP_MAX_FAILURES) {
    const ladderIndex = Math.min(entry.lockouts, OTP_LOCKOUT_LADDER_MS.length - 1);
    const lockoutDuration = OTP_LOCKOUT_LADDER_MS[ladderIndex];
    entry.lockedUntil = now + lockoutDuration;
    entry.lockouts++;
    entry.failures = 0; // Kilitten sonra sayaç sıfırlanır; yeni döngü başlar
    console.warn(`[OTP] Brute-force kilidi (seviye ${entry.lockouts}): ${identifier} — ${Math.round(lockoutDuration / 60000)}dk`);
  }

  otpLockouts.set(identifier, entry);
  persistOtpLockout(identifier, entry);
}

function clearOtpFailures(identifier) {
  // Sadece sayacı sıfırla; lockouts geçmişi kalsın (tekrar eden saldırgan için)
  const entry = otpLockouts.get(identifier);
  if (entry) {
    entry.failures = 0;
    entry.lockedUntil = null;
    otpLockouts.set(identifier, entry);
    persistOtpLockout(identifier, entry);
  }
}

// ─── Supabase persistence (restart'ta state'i korur) ──────────────────────────
// In-memory Map, DB'nin write-through cache'i. Restart sonrası DB'den yüklenir.
// DB sorunu auth akışını bozmaz — hatalar loglanır, bellekle devam edilir.

let _otpLockoutPersistAvailable = true;

async function loadOtpLockoutsFromDb() {
  try {
    const now = Date.now();
    const { data, error } = await supabase
      .from('otp_lockouts')
      .select('identifier, failures, lockouts, locked_until');
    if (error) {
      console.warn('[OTP] Lockout persistence yüklenemedi:', error.message || error);
      _otpLockoutPersistAvailable = false;
      return;
    }
    if (!Array.isArray(data)) return;
    let loaded = 0;
    for (const row of data) {
      const entry = {
        failures: Number(row.failures) || 0,
        lockouts: Number(row.lockouts) || 0,
        lockedUntil: row.locked_until ? Number(row.locked_until) : null,
      };
      // Süresi bitmiş kilitleri yükleme (DB cleanup için)
      if (entry.lockedUntil && entry.lockedUntil < now && entry.failures === 0) continue;
      otpLockouts.set(row.identifier, entry);
      loaded++;
    }
    if (loaded > 0) {
      console.log(`[OTP] ${loaded} lockout kaydı DB'den yüklendi`);
    }
  } catch (err) {
    console.warn('[OTP] Lockout persistence init hatası:', err.message || err);
    _otpLockoutPersistAvailable = false;
  }
}

function persistOtpLockout(identifier, entry) {
  if (!_otpLockoutPersistAvailable) return;
  // Fire-and-forget — auth akışını bloklamaz
  const payload = {
    identifier,
    failures: entry.failures || 0,
    lockouts: entry.lockouts || 0,
    locked_until: entry.lockedUntil || null,
    updated_at: new Date().toISOString(),
  };
  supabase
    .from('otp_lockouts')
    .upsert(payload, { onConflict: 'identifier' })
    .then((result) => {
      if (result && result.error) {
        console.warn('[OTP] Lockout upsert hatası:', result.error.message || result.error);
      }
    })
    .catch((err) => {
      console.warn('[OTP] Lockout upsert exception:', err.message || err);
    });
}

// Startup'ta persistence'ı yükle (supabase modülü hazır olduktan sonra)
setImmediate(() => { loadOtpLockoutsFromDb(); });

// ─── Ana kontrol fonksiyonu ───────────────────────────────────────────────────

function checkRateLimit(req, res, pathname) {
  if (!checkIpRateLimit(req, res, pathname)) return false;
  if (!checkDeviceRateLimit(req, res, pathname)) return false;
  if (pathname.startsWith('/api/') && !checkBotPattern(req, res)) return false;
  // /24 subnet koruması sadece OTP send endpointlerinde
  if (pathname === '/api/auth/send-otp' || pathname === '/api/auth/email/send-otp') {
    if (!checkSubnetOtpLimit(req, res)) return false;
  }
  return true;
}

module.exports = {
  checkRateLimit,
  checkOtpLockout,
  recordOtpFailure,
  clearOtpFailures,
};
