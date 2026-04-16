/**
 * Shimal Backend Server
 * Native Node HTTP server. All route handlers live in src/routes/*.
 */

require('dotenv').config({ override: true });

// ─── Sentry — crash reporting (init önce, her şeyden önce) ───────────────────
const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,       // %10 performance trace
    profilesSampleRate: 0.05,    // %5 profiling
  });
  console.log('[Sentry] Initialized');
} else {
  console.warn('[Sentry] SENTRY_DSN not set — crash reporting disabled');
}

// ─── Startup env validation ───────────────────────────────────────────────────
const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_KEY',
  'ANTHROPIC_API_KEY',
];
const missingVars = REQUIRED_ENV_VARS.filter((k) => !process.env[k]);
if (missingVars.length > 0) {
  console.error(`[Startup] FATAL: Missing required environment variables: ${missingVars.join(', ')}`);
  process.exit(1);
}

const http = require('http');
const cron    = require('node-cron');
const { withCronLock } = require('./utils/cron-lock');
// SunCalc kaldırıldı — sabah bildirimi artık sabit 08:30 (yerel saat)
const supabase = require('./config/supabase');
const { setSecurityHeaders, checkApiKey, checkUserAgent, writeJson, notFound, internalError, getRequestUrl } = require('./utils/http');
const { checkRateLimit } = require('./utils/rate-limit');
const { sendDailyNotifications, sendPushNotification } = require('./services/push-service');
const { generateInsightForUser, recordFailedInsight, retryFailedInsights } = require('./routes/daily');

// Route modules — each exports an array of [method, pattern, handler, keys?] tuples
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const dailyRoutes = require('./routes/daily');
const transitRoutes = require('./routes/transits');
const cosmicWeatherRoutes = require('./routes/cosmic-weather');
const compatibilityRoutes = require('./routes/compatibility');
const geomagneticRoutes = require('./routes/geomagnetic');
const personalityRoutes = require('./routes/personality');
const feedbackRoutes = require('./routes/feedback');
const crashReportRoutes = require('./routes/crash-report');
const dashboardRoutes = require('./routes/dashboard');
const webhookRoutes = require('./routes/webhook');

const PORT = Number(process.env.PORT || 3000);

process.on('uncaughtException', (error) => {
  console.error('[Startup] Uncaught exception:', error);
  Sentry.captureException(error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Startup] Unhandled rejection:', reason);
  Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// ─── Static handlers ──────────────────────────────────────────────────────────

async function handleRoot(_req, res) {
  writeJson(res, 200, {
    name: 'Shimal API',
    version: '1.0.0',
    status: 'operational',
  });
}

async function handleHealth(_req, res) {
  const health = {
    status: 'ok',
    service: 'shimal-backend',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
  };

  try {
    const { error } = await supabase.from('users').select('id').limit(1);
    health.database = error ? 'degraded' : 'connected';
    if (error) health.status = 'degraded';
  } catch {
    health.database = 'unreachable';
    health.status = 'degraded';
  }

  health.anthropic = process.env.ANTHROPIC_API_KEY ? 'configured' : 'missing';
  if (!process.env.ANTHROPIC_API_KEY) health.status = 'degraded';

  writeJson(res, health.status === 'ok' ? 200 : 503, health);
}

// ─── Route table ──────────────────────────────────────────────────────────────

const routes = [
  ['GET', /^\/$/, handleRoot],
  ['GET', /^\/health$/, handleHealth],
  ...authRoutes,
  ...userRoutes,
  ...dailyRoutes,
  ...transitRoutes,
  ...cosmicWeatherRoutes,
  ...compatibilityRoutes,
  ...geomagneticRoutes,
  ...personalityRoutes,
  ...feedbackRoutes,
  ...crashReportRoutes,
  ...dashboardRoutes,
  ...webhookRoutes,
];

// ─── Request dispatcher ───────────────────────────────────────────────────────

async function routeRequest(req, res) {
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    const url = getRequestUrl(req);
    if (url.pathname.startsWith('/dashboard/')) {
      const dashboardOrigin = process.env.DASHBOARD_ORIGIN
        || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null);
      const reqOrigin = req.headers.origin || '';
      // Production'da sadece tanımlı origin'e izin ver; local dev'de wildcard
      const corsOrigin = dashboardOrigin
        ? (reqOrigin === dashboardOrigin ? dashboardOrigin : dashboardOrigin)
        : '*';
      res.writeHead(204, {
        'Access-Control-Allow-Origin': corsOrigin,
        'Access-Control-Allow-Headers': 'x-api-key, x-dashboard-token, content-type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
    } else {
      res.writeHead(204);
    }
    res.end();
    return;
  }

  const url = getRequestUrl(req);
  console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`);

  // Rate limiting (all /api/* endpoints)
  if (!checkRateLimit(req, res, url.pathname)) return;

  // User-Agent bot tespiti (loglama amaçlı)
  if (url.pathname.startsWith('/api/')) checkUserAgent(req);

  // API key check (skip public routes and cron endpoint which has its own auth)
  const isPublic = url.pathname === '/' || url.pathname === '/health';
  const isCron = url.pathname === '/api/daily/generate-all' || url.pathname === '/api/user/migrate-natal';
  const isDashboard = url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/');
  const isWebhook = url.pathname.startsWith('/api/webhook/');
  if (!isPublic && !isCron && !isDashboard && !isWebhook) {
    if (!checkApiKey(req, res)) return;
  }

  for (const route of routes) {
    const [method, pattern, handler, keys = []] = route;
    if (req.method !== method) continue;
    const match = url.pathname.match(pattern);
    if (!match) continue;

    const params = {};
    keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });

    await handler(req, res, params, url);
    return;
  }

  notFound(res);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  routeRequest(req, res).catch((error) => {
    internalError(res, error, '[HTTP] Unhandled route error:', 'Sunucu hatası oluştu');
  });
});

server.listen(PORT, () => {
  console.log(`\n✨ Shimal Backend running on http://localhost:${PORT}`);
  console.log(`📡 API docs at http://localhost:${PORT}/`);
  console.log(`🔮 Health check at http://localhost:${PORT}/health\n`);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
// Railway SIGTERM gönderir → aktif state'leri flush et, sonra kapat

async function gracefulShutdown(signal) {
  console.log(`[Shutdown] ${signal} alındı, state flush ediliyor...`);
  try {
    const { onShutdown: flushRateLimits } = require('./utils/rate-limit');
    await flushRateLimits();
  } catch (err) {
    console.error('[Shutdown] Rate limit flush hatası:', err.message);
  }
  server.close(() => {
    console.log('[Shutdown] Server kapatıldı.');
    process.exit(0);
  });
  // 5 saniye içinde kapanmazsa zorla kapat
  setTimeout(() => { process.exit(1); }, 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─── Cron jobs ────────────────────────────────────────────────────────────────
// ─── Cron yardımcıları ────────────────────────────────────────────────────────

// Kullanıcının timezone'undaki saat/dakikayı döndürür
function getLocalHM(date, timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(date);
    return {
      hour:   parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10),
      minute: parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10),
    };
  } catch { return { hour: 0, minute: 0 }; }
}

// Hedef saatten sonra en fazla 5 dakika geçmişse true döndürür
function isWithin5Min(lh, lm, targetH, targetM) {
  const nowMins  = lh * 60 + lm;
  const tgtMins  = targetH * 60 + targetM;
  const diff = ((nowMins - tgtMins) + 1440) % 1440;
  return diff < 5;
}

// Günlük push takibi (in-memory, server restart'ta sıfırlanır)
// Her gün gece yarısı temizlenir
const pushSent = {
  morning:   new Set(), // gündoğumu bildirimi
  afternoon: new Set(), // öğle hatırlatması
  evening:   new Set(), // akşam hatırlatması
};

// Kullanıcı listesi cache (dakikada 1 DB çekmemek için)
let usersCache     = null;
let usersCacheTime = 0;
const USERS_TTL    = 5 * 60 * 1000; // 5 dk

async function getCachedUsers() {
  if (!usersCache || Date.now() - usersCacheTime > USERS_TTL) {
    const { data } = await supabase
      .from('users')
      .select('*')
      .not('push_token', 'is', null)
      .not('natal_planets', 'is', null);
    usersCache     = data || [];
    usersCacheTime = Date.now();
    console.log(`[Cache] ${usersCache.length} kullanıcı yüklendi.`);
  }
  return usersCache;
}

// ─── Cron run tracking ───────────────────────────────────────────────────────
async function recordCronStart(jobName) {
  const startMs = Date.now();
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_KEY;
    const startedAt = new Date(startMs).toISOString();
    const r = await fetch(`${SURL}/rest/v1/cron_runs`, {
      method: 'POST',
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ job_name: jobName, started_at: startedAt, status: 'running' }),
    });
    if (r.ok) {
      const rows = await r.json();
      return { id: rows[0]?.id || null, startMs };
    }
    return { id: null, startMs };
  } catch { return { id: null, startMs }; }
}

async function recordCronEnd(run, status, { usersProcessed = 0, usersFailed = 0, errorMessage = null, metadata = null } = {}) {
  const runId = run?.id;
  if (!runId) return;
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY = process.env.SUPABASE_SERVICE_KEY;
    const finishedAt = new Date().toISOString();
    const durationMs = run.startMs ? Date.now() - run.startMs : null;
    await fetch(`${SURL}/rest/v1/cron_runs?id=eq.${runId}`, {
      method: 'PATCH',
      headers: {
        apikey: KEY, Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        finished_at: finishedAt,
        status,
        duration_ms: durationMs,
        users_processed: usersProcessed,
        users_failed: usersFailed,
        error_message: errorMessage ? String(errorMessage).slice(0, 500) : null,
        metadata,
      }),
    });
  } catch { /* fire-and-forget */ }
}

// ─── CRON 1 — Her sabah 03:00 UTC: Tüm insightları toplu üret ────────────────
// Gündoğumundan ÖNCE tüm kullanıcılara ait insight hazırlanır.
// generateInsightForUser zaten bugün varsa skip eder — güvenli çalıştırılabilir.

cron.schedule('0 3 * * *', async () => {
  // Dağıtık kilit: 2 saat TTL, başka instance tutuyorsa skip
  await withCronLock('daily-gen', 2 * 60 * 60, async () => {
    const run = await recordCronStart('daily-gen');
    try {
      const today = new Date().toISOString().split('T')[0];
      console.log(`[DailyGen] ${today} için toplu insight üretimi başlıyor...`);

      usersCache = null; // cache'i yenile
      const users = await getCachedUsers();
      if (!users.length) {
        await recordCronEnd(run, 'success', { metadata: { skipped: 0, total: 0 } });
        return;
      }

      let generated = 0, skipped = 0, errors = 0;
      const BATCH = 3; // Anthropic rate limit'e saygı
      for (let i = 0; i < users.length; i += BATCH) {
        const batch = users.slice(i, i + BATCH);
        await Promise.allSettled(batch.map(async (user) => {
          try {
            const result = await generateInsightForUser(user, today);
            if (result === 'skipped') { skipped++; return; }
            generated++;
          } catch (err) {
            errors++;
            console.error(`[DailyGen] ✗ ${user.id}:`, err.message);
            // Başarısız üretimi kaydet — 06:00 retry cron'u yeniden dener
            await recordFailedInsight(user.id, today, err.message);
          }
        }));
        // Batch'ler arasında kısa bekleme
        if (i + BATCH < users.length) await new Promise(r => setTimeout(r, 500));
      }

      console.log(`[DailyGen] Tamamlandı: ${generated} üretildi, ${skipped} atlandı, ${errors} hata.`);
      await recordCronEnd(run, 'success', { usersProcessed: generated, usersFailed: errors, metadata: { skipped, total: users.length } });
    } catch (err) {
      console.error('[DailyGen] Genel hata:', err.message);
      await recordCronEnd(run, 'error', { errorMessage: err.message });
    }
  });
}, { timezone: 'UTC' });

// ─── CRON 2 — 06:00 UTC: Başarısız insight'ları retry et ────────────────────
// 03:00 cron'unda üretilemeyen insight'lar failed_insights tablosuna kaydedilir.
// 06:00'da bu kullanıcılar için tekrar denenir (max 3 toplam deneme).

cron.schedule('0 6 * * *', async () => {
  await withCronLock('retry-gen', 60 * 60, async () => {
    const run = await recordCronStart('retry-gen');
    try {
      const today = new Date().toISOString().split('T')[0];
      console.log(`[RetryGen] ${today} için başarısız insight retry başlıyor...`);

      const { retried, recovered, stillFailing } = await retryFailedInsights(today);

      console.log(`[RetryGen] Tamamlandı: ${recovered}/${retried} kurtarıldı, ${stillFailing} hâlâ başarısız.`);
      await recordCronEnd(run, 'success', { usersProcessed: recovered, usersFailed: stillFailing, metadata: { retried } });
    } catch (err) {
      console.error('[RetryGen] Retry cron hatası:', err.message);
      await recordCronEnd(run, 'error', { errorMessage: err.message });
    }
  });
}, { timezone: 'UTC' });

// ─── CRON 3 — Her dakika: 3 farklı saatte push bildirim gönder ───────────────
// • Sabah  → Gündoğumu saatinde: AI insight bildirimi
// • Öğlen  → 13:00 yerel saatte: hatırlatma
// • Akşam  → 20:00 yerel saatte: hatırlatma

cron.schedule('* * * * *', async () => {
  // Push cron her dakika çalışır — 50sn TTL ile lock alıyoruz.
  // Sonraki dakika'daki çağrı expired lock'u temizleyip devralır.
  await withCronLock('push-cron', 50, async () => {
  try {
    const now   = new Date();
    const today = now.toISOString().split('T')[0];
    const users = await getCachedUsers();
    if (!users.length) return;

    // Her kullanıcı için hangi push penceresi açık?
    const morningDue   = [];
    const afternoonDue = [];
    const eveningDue   = [];

    // Sabit saatler (her kullanıcı için kendi yerel saatiyle):
    //   Sabah  → 08:30
    //   Öğle   → 13:00
    //   Akşam  → 20:00
    const MORNING_H = 8,  MORNING_M = 30;
    const NOON_H    = 13, NOON_M    = 0;
    const EVENING_H = 20, EVENING_M = 0;

    for (const user of users) {
      const tz          = user.timezone || 'Europe/Istanbul';
      const { hour, minute } = getLocalHM(now, tz);

      if (!pushSent.morning.has(user.id)   && isWithin5Min(hour, minute, MORNING_H, MORNING_M)) morningDue.push(user);
      if (!pushSent.afternoon.has(user.id) && isWithin5Min(hour, minute, NOON_H, NOON_M))       afternoonDue.push(user);
      if (!pushSent.evening.has(user.id)   && isWithin5Min(hour, minute, EVENING_H, EVENING_M)) eveningDue.push(user);
    }

    // ── Sabah: AI insight bildirimi ──────────────────────────────────────────
    if (morningDue.length) {
      console.log(`[Push-Sabah] ${morningDue.length} kullanıcıya gündoğumu bildirimi...`);
      // Bugünkü insight'ları tek sorguda çek
      const { data: insights } = await supabase
        .from('daily_insights')
        .select('user_id, notification_text')
        .eq('date', today);
      const insightMap = Object.fromEntries((insights || []).map(r => [r.user_id, r.notification_text]));

      await Promise.allSettled(morningDue.map(async (user) => {
        try {
          const name    = user.preferred_name || '';
          const notifTxt = insightMap[user.id];
          const body    = notifTxt || (name
            ? `${name}, bugünkü kozmik rehberliğin hazır. 🌅`
            : 'Bugünkü kozmik rehberliğiniz hazır. 🌅');
          const heading = name ? `Shimal · ${name}` : 'Shimal';
          await sendPushNotification(user.push_token, body, heading, { type: 'daily_insight', date: today });
          pushSent.morning.add(user.id);
        } catch (err) { console.error(`[Push-Sabah] ✗ ${user.id}:`, err.message); }
      }));
    }

    // ── Öğlen: Hatırlatma ────────────────────────────────────────────────────
    if (afternoonDue.length) {
      console.log(`[Push-Öğlen] ${afternoonDue.length} kullanıcıya öğle hatırlatması...`);
      await Promise.allSettled(afternoonDue.map(async (user) => {
        try {
          const name    = user.preferred_name || '';
          const body    = name
            ? `${name}, günün ortasında bir dakikan var mı? ✨`
            : 'Günün ortasında bir dakikan var mı? ✨';
          await sendPushNotification(user.push_token, body, 'Shimal', { type: 'reminder', period: 'afternoon' });
          pushSent.afternoon.add(user.id);
        } catch (err) { console.error(`[Push-Öğlen] ✗ ${user.id}:`, err.message); }
      }));
    }

    // ── Akşam: Hatırlatma ────────────────────────────────────────────────────
    if (eveningDue.length) {
      console.log(`[Push-Akşam] ${eveningDue.length} kullanıcıya akşam hatırlatması...`);
      await Promise.allSettled(eveningDue.map(async (user) => {
        try {
          const name    = user.preferred_name || '';
          const body    = name
            ? `${name}, bugünü nasıl kapattın? Shimal seni bekliyor 🌙`
            : 'Bugünü nasıl kapattın? Shimal seni bekliyor 🌙';
          await sendPushNotification(user.push_token, body, 'Shimal', { type: 'reminder', period: 'evening' });
          pushSent.evening.add(user.id);
        } catch (err) { console.error(`[Push-Akşam] ✗ ${user.id}:`, err.message); }
      }));
    }

  } catch (err) {
    console.error('[Push-Cron] Genel hata:', err.message);
  }
  }); // withCronLock('push-cron')
}, { timezone: 'UTC' });

// ─── CRON 3 — Gece yarısı 00:00 UTC: push takibini sıfırla ──────────────────
cron.schedule('0 0 * * *', async () => {
  await withCronLock('midnight-reset', 10 * 60, async () => {
    const run = await recordCronStart('midnight-reset');
    pushSent.morning.clear();
    pushSent.afternoon.clear();
    pushSent.evening.clear();
    usersCache = null; // yeni gün, yeni kullanıcı cache'i
    console.log('[Cron] Push takibi ve kullanıcı cache temizlendi.');
    await recordCronEnd(run, 'success');
  });
}, { timezone: 'UTC' });
