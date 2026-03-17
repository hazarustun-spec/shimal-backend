/**
 * AstroGuide Backend Server
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
const { setCorsHeaders, writeJson, notFound, internalError, getRequestUrl } = require('./utils/http');
const { sendDailyNotifications } = require('./services/push-service');

// Route modules — each exports an array of [method, pattern, handler, keys?] tuples
const userRoutes = require('./routes/user');
const dailyRoutes = require('./routes/daily');
const guidanceRoutes = require('./routes/guidance');
const transitRoutes = require('./routes/transits');
const cosmicWeatherRoutes = require('./routes/cosmic-weather');
const compatibilityRoutes = require('./routes/compatibility');
const demoRoutes = require('./routes/demo');

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
    name: 'AstroGuide API',
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
    },
  });
}

async function handleHealth(_req, res) {
  const health = {
    status: 'ok',
    service: 'astroguide-backend',
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
  ...userRoutes,
  ...dailyRoutes,
  ...guidanceRoutes,
  ...transitRoutes,
  ...cosmicWeatherRoutes,
  ...compatibilityRoutes,
  ...demoRoutes,
];

// ─── Request dispatcher ───────────────────────────────────────────────────────

async function routeRequest(req, res) {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = getRequestUrl(req);
  console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname}`);

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
    internalError(res, error, '[HTTP] Unhandled route error:', 'Internal server error');
  });
});

server.listen(PORT, () => {
  console.log(`\n✨ AstroGuide Backend running on http://localhost:${PORT}`);
  console.log(`📡 API docs at http://localhost:${PORT}/`);
  console.log(`🔮 Health check at http://localhost:${PORT}/health\n`);
});

// ─── Cron jobs ────────────────────────────────────────────────────────────────
// 08:30 Turkey time = 05:30 UTC (UTC+3)
cron.schedule('30 5 * * *', async () => {
  console.log('[Cron] Sending daily push notifications...');
  try {
    await sendDailyNotifications(supabase);
    console.log('[Cron] Daily notifications complete.');
  } catch (err) {
    console.error('[Cron] Daily notification error:', err.message);
  }
}, { timezone: 'UTC' });
