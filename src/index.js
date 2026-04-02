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
const cron = require('node-cron');
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
    res.writeHead(204);
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
  const isDashboard = url.pathname.startsWith('/dashboard/');
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
// Her dakika çalışır — her kullanıcının kendi timezone + seçtiği saate göre
// insight üretir ve push bildirim gönderir.

cron.schedule('* * * * *', async () => {
  try {
    const now   = new Date();
    const today = now.toISOString().split('T')[0];

    // Push token'ı olan ve natal planets kaydı olan tüm kullanıcılar
    const { data: users, error } = await supabase
      .from('users')
      .select('*')
      .not('push_token', 'is', null)
      .not('natal_planets', 'is', null);

    if (error || !users?.length) return;

    // Şu an kimin refresh zamanı gelmiş?
    const due = users.filter((user) => {
      const tz     = user.timezone || 'Europe/Istanbul';
      const hour   = user.refresh_hour   ?? 8;
      const minute = user.refresh_minute ?? 30;
      try {
        const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(now);
        const lh = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10);
        const lm = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10);
        return lh === hour && lm === minute;
      } catch {
        return false;
      }
    });

    if (!due.length) return;

    console.log(`[Cron] ${due.length} kullanıcı için insight üretimi başlıyor...`);

    // 3'lü batch — Anthropic rate limit'e saygı
    const BATCH = 3;
    for (let i = 0; i < due.length; i += BATCH) {
      const batch = due.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (user) => {
        try {
          const result = await generateInsightForUser(user, today);
          if (result === 'skipped') return;

          // Insight üretildi — push bildirim gönder
          const name = user.preferred_name || '';
          const body = typeof result === 'string' ? result
            : (name ? `${name}, bugünkü kozmik rehberliğin hazır.`
                    : 'Bugünkü kozmik rehberliğiniz hazır.');
          const heading = name ? `Shimal · ${name}` : 'Shimal';

          await sendPushNotification(user.push_token, body, heading, {
            type: 'daily_insight', date: today,
          });

          console.log(`[Cron] ✓ ${user.id} (${user.sun_sign})`);
        } catch (err) {
          console.error(`[Cron] ✗ ${user.id}:`, err.message);
        }
      }));
    }

    console.log(`[Cron] Tamamlandı: ${today}`);
  } catch (err) {
    console.error('[Cron] Genel hata:', err.message);
  }
}, { timezone: 'UTC' });
