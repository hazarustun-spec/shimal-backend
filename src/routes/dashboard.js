'use strict';

/**
 * Shimal Admin Dashboard
 *
 * GET  /dashboard                  → HTML dashboard
 * POST /dashboard/login            → şifre doğrulama, token döner
 * GET  /dashboard/stats            → tüm metrikler (JSON)
 * GET  /dashboard/stats/insights   → 30 günlük insight trendi
 */

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const supabase = require('../config/supabase');
const { writeJson } = require('../utils/http');

// ─── Pricing ──────────────────────────────────────────────────────────────────
const PRICING = {
  'claude-opus-4-6':   { input: 15.00, output: 75.00 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-5': { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':  { input: 0.80,  output: 4.00  },
  'claude-3-5-sonnet': { input: 3.00,  output: 15.00 },
  'claude-3-5-haiku':  { input: 0.80,  output: 4.00  },
  'claude-3-opus':     { input: 15.00, output: 75.00 },
  'claude-3-haiku':    { input: 0.25,  output: 1.25  },
  default:             { input: 3.00,  output: 15.00 },
};

function calcCost(model, inp, out) {
  const key = Object.keys(PRICING).find(k => model && model.startsWith(k)) || 'default';
  const p = PRICING[key];
  return (inp / 1_000_000) * p.input + (out / 1_000_000) * p.output;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function getSecret() {
  return process.env.DASHBOARD_SECRET || process.env.SHIMAL_API_KEY || 'shimal-dashboard-secret';
}

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + 8 * 3600_000 })).toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length < 2) return false;
  const payload = parts[0];
  const sig = parts[1];
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('base64url');
  try {
    if (sig.length !== expected.length) return false;
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return Date.now() < exp;
  } catch { return false; }
}

function checkDashboardAuth(req, res) {
  const token = req.headers['x-dashboard-token'] || '';
  if (verifyToken(token)) return true;
  res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify({ error: 'Yetkisiz' }));
  return false;
}

// ─── In-memory error ring buffer ──────────────────────────────────────────────
const ERROR_BUFFER = [];
const ERROR_BUFFER_MAX = 20;

function logError(source, message) {
  ERROR_BUFFER.unshift({ ts: new Date().toISOString(), source, message: String(message).slice(0, 200) });
  if (ERROR_BUFFER.length > ERROR_BUFFER_MAX) ERROR_BUFFER.pop();
}

// ─── Cache ────────────────────────────────────────────────────────────────────
let statsCache = null;
let statsCacheAge = 0;
const CACHE_TTL = 2 * 60 * 1000;

// ─── Supabase stats ───────────────────────────────────────────────────────────
async function getSupabaseStats() {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    const h    = { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' };

    const count = async (q) => {
      const r = await fetch(`${SURL}/rest/v1/${q}`, { headers: h });
      return parseInt((r.headers.get('content-range') || '0/0').split('/')[1] || '0', 10);
    };

    const now      = new Date();
    const today    = now.toISOString().split('T')[0];
    const weekAgo  = new Date(Date.now() - 7 * 86400_000).toISOString();
    const day7Ago  = new Date(Date.now() - 7  * 86400_000).toISOString().split('T')[0];
    const day30Ago = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0];
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;

    const [totalUsers, usersWithPush, premiumUsers, newToday, newWeek, insightsToday, insightsThisMonth] = await Promise.all([
      count('users?select=id'),
      count('users?select=id&push_token=not.is.null'),
      count('users?select=id&is_premium=eq.true'),
      count(`users?select=id&created_at=gte.${today}T00:00:00Z`),
      count(`users?select=id&created_at=gte.${weekAgo}`),
      count(`daily_insights?select=id&date=eq.${today}`),
      count(`daily_insights?select=id&date=gte.${monthStart}`),
    ]);

    // Sun sign + refresh hour dağılımı, aktif kullanıcılar, yeni kullanıcı IDs paralel
    const hJson = { apikey: KEY, Authorization: `Bearer ${KEY}` };
    const [usersRes, active7Res, active30Res, newUsersRes] = await Promise.all([
      fetch(`${SURL}/rest/v1/users?select=sun_sign,refresh_hour`, { headers: hJson }),
      fetch(`${SURL}/rest/v1/daily_insights?select=user_id&date=gte.${day7Ago}`, { headers: hJson }),
      fetch(`${SURL}/rest/v1/daily_insights?select=user_id&date=gte.${day30Ago}`, { headers: hJson }),
      fetch(`${SURL}/rest/v1/users?select=id&created_at=gte.${weekAgo}`, { headers: hJson }),
    ]);

    const allUsers    = await usersRes.json();
    const active7Raw  = await active7Res.json();
    const active30Raw = await active30Res.json();
    const newUsersRaw = await newUsersRes.json();

    const signDist = {};
    const refreshHourDist = {};
    if (Array.isArray(allUsers)) {
      for (const u of allUsers) {
        const s = u.sun_sign || 'Unknown';
        signDist[s] = (signDist[s] || 0) + 1;
        const hr = u.refresh_hour ?? 8;
        refreshHourDist[hr] = (refreshHourDist[hr] || 0) + 1;
      }
    }

    const active7Set   = new Set(Array.isArray(active7Raw)  ? active7Raw.map(r => r.user_id)  : []);
    const active30Set  = new Set(Array.isArray(active30Raw) ? active30Raw.map(r => r.user_id) : []);
    const newUserIdSet = new Set(Array.isArray(newUsersRaw) ? newUsersRaw.map(r => r.id)      : []);

    const activeUsers7d  = active7Set.size;
    const activeUsers30d = active30Set.size;
    // Yeni kullanıcılardan kaçı ilk 7 gün içinde insight aldı
    const newUsersActivated = [...newUserIdSet].filter(id => active7Set.has(id)).length;
    // Hiç aktif olmayan kullanıcılar (churn riski)
    const churnRisk = Math.max(0, totalUsers - activeUsers30d);
    // Insight başarı oranı: bu ayki insight / beklenen (push token × geçen gün sayısı)
    const daysInMonth = now.getDate();
    const expectedInsights = usersWithPush * daysInMonth;
    const insightSuccessRate = expectedInsights > 0
      ? Math.min(100, Math.round(insightsThisMonth / expectedInsights * 100)) : null;

    return { ok: true, totalUsers, usersWithPush, premiumUsers, newToday, newWeek,
             insightsToday, insightsThisMonth, activeUsers7d, activeUsers30d,
             newUsersActivated, churnRisk, insightSuccessRate,
             signDist, refreshHourDist };
  } catch (err) {
    logError('supabase', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Insight 30-day trend ─────────────────────────────────────────────────────
async function getInsightTrend() {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    const since = new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0];

    const [insightRes, userRes] = await Promise.all([
      fetch(
        `${SURL}/rest/v1/daily_insights?select=date&date=gte.${since}&order=date.asc`,
        { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
      ),
      fetch(
        `${SURL}/rest/v1/users?select=created_at&created_at=gte.${since}T00:00:00Z&order=created_at.asc`,
        { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
      ),
    ]);

    const rows     = await insightRes.json();
    const userRows = await userRes.json();

    if (!Array.isArray(rows)) return { ok: false, days: [], growth: [] };

    const byDate   = {};
    const byRegDay = {};
    for (const r of rows)     byDate[r.date]  = (byDate[r.date]  || 0) + 1;
    if (Array.isArray(userRows)) {
      for (const u of userRows) {
        const d = u.created_at?.split('T')[0];
        if (d) byRegDay[d] = (byRegDay[d] || 0) + 1;
      }
    }

    const days   = [];
    const growth = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().split('T')[0];
      days.push({ date: d, count: byDate[d] || 0 });
      growth.push({ date: d, count: byRegDay[d] || 0 });
    }
    return { ok: true, days, growth };
  } catch (err) {
    logError('supabase-trend', err.message);
    return { ok: false, error: err.message, days: [] };
  }
}

// ─── Anthropic usage ──────────────────────────────────────────────────────────
async function getAnthropicUsage() {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { ok: false, error: 'API key yok' };

    const now   = new Date();
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const end   = now.toISOString().split('T')[0];

    const r = await fetch(`https://api.anthropic.com/v1/usage?start_date=${start}&end_date=${end}`, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    });

    if (r.ok) {
      const data = await r.json();
      const entries = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
      let inp = 0, out = 0, cost = 0;
      for (const e of entries) {
        inp  += e.input_tokens  ?? 0;
        out  += e.output_tokens ?? 0;
        cost += calcCost(e.model, e.input_tokens ?? 0, e.output_tokens ?? 0);
      }
      return { ok: true, source: 'api', inputTokens: inp, outputTokens: out, costUsd: Math.round(cost * 100) / 100, requests: entries.length };
    }

    // Fallback: DB'deki insight sayısından tahmin
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    const cr = await fetch(
      `${SURL}/rest/v1/daily_insights?select=id&date=gte.${start}&date=lte.${end}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' } }
    );
    const insightCount = parseInt((cr.headers.get('content-range') || '0/0').split('/')[1] || '0', 10);
    const estInp  = insightCount * 2200;
    const estOut  = insightCount * 900;
    const estCost = calcCost('claude-sonnet-4-6', estInp, estOut);

    return {
      ok: true,
      source: 'estimate',
      inputTokens: estInp,
      outputTokens: estOut,
      costUsd: Math.round(estCost * 100) / 100,
      requests: insightCount,
      note: 'Tahmin — DB\'deki insight sayısından hesaplandı',
    };
  } catch (err) {
    logError('anthropic', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── OneSignal stats ──────────────────────────────────────────────────────────
async function getOneSignalStats() {
  try {
    const appId = process.env.ONESIGNAL_APP_ID;
    const key   = process.env.ONESIGNAL_API_KEY;
    if (!appId || !key) return { ok: false, error: 'Env var eksik' };

    const [appRes, notifRes] = await Promise.all([
      fetch(`https://onesignal.com/api/v1/apps/${appId}`, { headers: { Authorization: `Basic ${key}` } }),
      fetch(`https://onesignal.com/api/v1/notifications?app_id=${appId}&limit=30&kind=1`, { headers: { Authorization: `Basic ${key}` } }),
    ]);

    const app = appRes.ok ? await appRes.json() : {};
    const notifData = notifRes.ok ? await notifRes.json() : {};
    const notifs = notifData.notifications || [];

    const totalSent    = notifs.reduce((s, n) => s + (n.successful || 0), 0);
    const totalClicked = notifs.reduce((s, n) => s + (n.converted  || 0), 0);
    const ctr = totalSent > 0 ? Math.round((totalClicked / totalSent) * 100) : 0;
    const lastNotif = notifs[0] || null;

    return {
      ok: true,
      players: app.players ?? 0,
      messagablePlayers: app.messagable_players ?? 0,
      recentNotifs: notifs.length,
      totalSentRecent: totalSent,
      totalClickedRecent: totalClicked,
      ctrPercent: ctr,
      lastSentAt: lastNotif?.queued_at ? new Date(lastNotif.queued_at * 1000).toISOString() : null,
    };
  } catch (err) {
    logError('onesignal', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleDashboardHtml(_req, res) {
  const htmlPath = path.join(__dirname, '../public/dashboard.html');
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Dashboard HTML bulunamadı');
  }
}

async function handleLogin(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) {
    writeJson(res, 503, { error: 'DASHBOARD_PASSWORD env var ayarlanmamış' });
    return;
  }
  let body = '';
  await new Promise(r => { req.on('data', c => { body += c; }); req.on('end', r); });
  let provided = '';
  try { provided = JSON.parse(body).password || ''; } catch { /* ignore */ }

  const padLen = Math.max(provided.length, pass.length, 64);
  const safe = crypto.timingSafeEqual(
    Buffer.from(provided.padEnd(padLen)),
    Buffer.from(pass.padEnd(padLen))
  );
  if (!safe || provided !== pass) {
    writeJson(res, 401, { error: 'Yanlış şifre' });
    return;
  }
  writeJson(res, 200, { token: makeToken() });
}

async function handleStats(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!checkDashboardAuth(req, res)) return;

  const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
  if (!force && statsCache && Date.now() - statsCacheAge < CACHE_TTL) {
    writeJson(res, 200, { ...statsCache, cached: true });
    return;
  }

  const [supabaseStats, anthropicUsage, oneSignalStats] = await Promise.all([
    getSupabaseStats(),
    getAnthropicUsage(),
    getOneSignalStats(),
  ]);

  const payload = {
    fetchedAt: new Date().toISOString(),
    supabase:  supabaseStats,
    anthropic: anthropicUsage,
    onesignal: oneSignalStats,
    server: {
      uptime:       Math.floor(process.uptime()),
      nodeVersion:  process.version,
      env:          process.env.NODE_ENV || 'development',
      recentErrors: ERROR_BUFFER.slice(0, 10),
    },
    cached: false,
  };

  statsCache    = payload;
  statsCacheAge = Date.now();
  writeJson(res, 200, payload);
}

async function handleInsightTrend(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!checkDashboardAuth(req, res)) return;
  writeJson(res, 200, await getInsightTrend());
}

async function handleOptions(_req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-dashboard-token, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end();
}

module.exports = [
  ['GET',     /^\/dashboard$/,                    handleDashboardHtml],
  ['POST',    /^\/dashboard\/login$/,              handleLogin],
  ['GET',     /^\/dashboard\/stats$/,              handleStats],
  ['GET',     /^\/dashboard\/stats\/insights$/,    handleInsightTrend],
  ['OPTIONS', /^\/dashboard/,                      handleOptions],
];

module.exports.logDashboardError = logError;
