/**
 * Shimal Backend Server
 * Native Node HTTP server. All route handlers live in src/routes/*.
 */

require('dotenv').config({ override: true });

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
const SunCalc = require('suncalc');
const supabase = require('./config/supabase');
const { setSecurityHeaders, checkApiKey, writeJson, notFound, internalError, getRequestUrl } = require('./utils/http');
const { checkRateLimit } = require('./utils/rate-limit');
const { sendDailyNotifications, sendPushNotification } = require('./services/push-service');
const { generateInsightForUser } = require('./routes/daily');

// Route modules — each exports an array of [method, pattern, handler, keys?] tuples
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const dailyRoutes = require('./routes/daily');
const guidanceRoutes = require('./routes/guidance');
const transitRoutes = require('./routes/transits');
const cosmicWeatherRoutes = require('./routes/cosmic-weather');
const compatibilityRoutes = require('./routes/compatibility');
const geomagneticRoutes = require('./routes/geomagnetic');
const personalityRoutes = require('./routes/personality');
const feedbackRoutes = require('./routes/feedback');
const demoRoutes = require('./routes/demo');
const dashboardRoutes = require('./routes/dashboard');

const PORT = Number(process.env.PORT || 3000);

process.on('uncaughtException', (error) => {
  console.error('[Startup] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Startup] Unhandled rejection:', reason);
});

// ─── Static handlers ──────────────────────────────────────────────────────────

async function handleRoot(_req, res) {
  writeJson(res, 200, {
    name: 'Shimal API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      register: 'POST /api/user/register',
      profile: 'GET /api/user/:deviceId',
      pushToken: 'PUT /api/user/push-token',
      dailyInsight: 'GET /api/daily/:deviceId',
      decisionGuidance: 'POST /api/guidance/decision',
      generateAll: 'POST /api/daily/generate-all',
      transitsToday: 'GET /api/transits/today',
      transitTimeline: 'GET /api/transits/timeline?days=14',
      moonPhase: 'GET /api/transits/moon-phase',
      natalChart: 'GET /api/transits/natal-chart?birthDate=1995-03-15&birthTime=14:30',
      compatibility: 'POST /api/transits/compatibility',
      cosmicWeather: 'GET /api/cosmic-weather',
      compatibilityLite: 'POST /api/compatibility',
      geomagnetic: 'GET /api/geomagnetic?lat=41.0&lon=29.0',
    },
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
  ...guidanceRoutes,
  ...transitRoutes,
  ...cosmicWeatherRoutes,
  ...compatibilityRoutes,
  ...geomagneticRoutes,
  ...personalityRoutes,
  ...feedbackRoutes,
  ...demoRoutes,
  ...dashboardRoutes,
];

// ─── Request dispatcher ───────────────────────────────────────────────────────

async function routeRequest(req, res) {
  setSecurityHeaders(res);

  if (req.method === 'OPTIONS') {
    const url = getRequestUrl(req);
    if (url.pathname.startsWith('/dashboard/')) {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'x-api-key, x-dashboard-key, content-type',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
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

  // API key check (skip public routes and cron endpoint which has its own auth)
  const isPublic = url.pathname === '/' || url.pathname === '/health';
  const isCron = url.pathname === '/api/daily/generate-all' || url.pathname === '/api/user/migrate-natal';
  const isDashboard = url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/');
  const isDemo = url.pathname.startsWith('/api/demo/');
  if (!isPublic && !isCron && !isDemo && !isDashboard) {
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

// Kullanıcının doğum koordinatlarından bugünkü gündoğumu saatini hesaplar
// Koordinat yoksa timezone'a göre mevsimsel tahmin kullanır
function getSunriseHM(user, date) {
  const tz  = user.timezone || 'Europe/Istanbul';
  const lat = parseFloat(user.birth_latitude);
  const lon = parseFloat(user.birth_longitude);
  try {
    if (!isNaN(lat) && !isNaN(lon) && lat !== 0 && lon !== 0) {
      const times = SunCalc.getTimes(date, lat, lon);
      if (times.sunrise && !isNaN(times.sunrise.getTime())) {
        return getLocalHM(times.sunrise, tz);
      }
    }
  } catch { /* fall through */ }
  // Fallback: Türkiye için aylık ortalama gündoğumu saatleri (UTC+3)
  const month = date.getMonth(); // 0=Ocak … 11=Aralık
  const hours = [8, 7, 7, 6, 6, 5, 5, 6, 6, 7, 7, 8];
  return { hour: hours[month], minute: 0 };
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

// ─── CRON 1 — Her sabah 03:00 UTC: Tüm insightları toplu üret ────────────────
// Gündoğumundan ÖNCE tüm kullanıcılara ait insight hazırlanır.
// generateInsightForUser zaten bugün varsa skip eder — güvenli çalıştırılabilir.

cron.schedule('0 3 * * *', async () => {
  try {
    const today = new Date().toISOString().split('T')[0];
    console.log(`[DailyGen] ${today} için toplu insight üretimi başlıyor...`);

    usersCache = null; // cache'i yenile
    const users = await getCachedUsers();
    if (!users.length) return;

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
        }
      }));
      // Batch'ler arasında kısa bekleme
      if (i + BATCH < users.length) await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[DailyGen] Tamamlandı: ${generated} üretildi, ${skipped} atlandı, ${errors} hata.`);
  } catch (err) {
    console.error('[DailyGen] Genel hata:', err.message);
  }
}, { timezone: 'UTC' });

// ─── CRON 2 — Her dakika: 3 farklı saatte push bildirim gönder ───────────────
// • Sabah  → Gündoğumu saatinde: AI insight bildirimi
// • Öğlen  → 13:00 yerel saatte: hatırlatma
// • Akşam  → 20:00 yerel saatte: hatırlatma

cron.schedule('* * * * *', async () => {
  try {
    const now   = new Date();
    const today = now.toISOString().split('T')[0];
    const users = await getCachedUsers();
    if (!users.length) return;

    // Her kullanıcı için hangi push penceresi açık?
    const morningDue   = [];
    const afternoonDue = [];
    const eveningDue   = [];

    for (const user of users) {
      const tz          = user.timezone || 'Europe/Istanbul';
      const { hour, minute } = getLocalHM(now, tz);
      const sunrise     = getSunriseHM(user, now);

      if (!pushSent.morning.has(user.id)   && isWithin5Min(hour, minute, sunrise.hour, sunrise.minute)) morningDue.push(user);
      if (!pushSent.afternoon.has(user.id) && isWithin5Min(hour, minute, 13, 0))  afternoonDue.push(user);
      if (!pushSent.evening.has(user.id)   && isWithin5Min(hour, minute, 20, 0))  eveningDue.push(user);
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
}, { timezone: 'UTC' });

// ─── CRON 3 — Gece yarısı 00:00 UTC: push takibini sıfırla ──────────────────
cron.schedule('0 0 * * *', () => {
  pushSent.morning.clear();
  pushSent.afternoon.clear();
  pushSent.evening.clear();
  usersCache = null; // yeni gün, yeni kullanıcı cache'i
  console.log('[Cron] Push takibi ve kullanıcı cache temizlendi.');
}, { timezone: 'UTC' });
