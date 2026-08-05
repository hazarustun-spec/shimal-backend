'use strict';

/**
 * Shimal Admin Dashboard
 *
 * GET  /dashboard                  → HTML dashboard
 * POST /dashboard/login            → şifre doğrulama, token döner
 * GET  /dashboard/stats            → tüm metrikler (JSON)
 * GET  /dashboard/stats/insights   → 30 günlük insight trendi
 * GET  /dashboard/prompts          → düzenlenebilir AI prompt'ları + durumları
 * GET  /dashboard/prompts/history  → bir prompt'un sürüm geçmişi
 * GET  /dashboard/prompts/version  → belirli bir sürümün tam metni
 * POST /dashboard/prompts/save     → yeni sürüm kaydet
 * POST /dashboard/prompts/revert   → eski sürümü yeni sürüm olarak geri getir
 * POST /dashboard/prompts/reset    → koddaki varsayılana dön
 */

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');
const supabase = require('../config/supabase');
const promptStore = require('../services/prompt-store');
const { writeJson } = require('../utils/http');

function dashboardCorsOrigin() {
  // Production'da wildcard açık bırakmak güvenlik riski — env var yoksa
  // backend URL'ini kullan (dashboard kendi origin'inde barındırılıyor)
  return process.env.DASHBOARD_ORIGIN || process.env.RAILWAY_PUBLIC_DOMAIN
    ? (process.env.DASHBOARD_ORIGIN || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`)
    : '*'; // Sadece local dev'de wildcard
}

// ─── Pricing ──────────────────────────────────────────────────────────────────
const PRICING = {
  // Gemini (current engine). Verify against ai.google.dev/pricing — rates change.
  'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
  'gemini-2.5-flash':      { input: 0.30, output: 2.50 },
  'gemini-2.5-pro':        { input: 1.25, output: 10.00 },
  // Legacy Claude rates (kept for historical cost rows)
  'claude-sonnet-4-6':     { input: 3.00,  output: 15.00 },
  'claude-haiku-4-5':      { input: 0.80,  output: 4.00  },
  default:                 { input: 0.30,  output: 2.50 },
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
  res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': dashboardCorsOrigin() });
  res.end(JSON.stringify({ error: 'Yetkisiz' }));
  return false;
}

// ─── Persistent error log (Supabase) + in-memory fallback ────────────────────
const ERROR_BUFFER = [];
const ERROR_BUFFER_MAX = 50;

function logError(source, message) {
  const entry = { ts: new Date().toISOString(), source, message: String(message).slice(0, 300) };
  ERROR_BUFFER.unshift(entry);
  if (ERROR_BUFFER.length > ERROR_BUFFER_MAX) ERROR_BUFFER.pop();

  // Fire-and-forget persist to Supabase
  persistError(entry).catch(() => {});
}

async function persistError({ ts, source, message }) {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    if (!SURL || !KEY) return;
    await fetch(`${SURL}/rest/v1/error_logs`, {
      method: 'POST',
      headers: {
        apikey: KEY,
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ created_at: ts, source, message }),
    });
  } catch { /* fallback to in-memory only */ }
}

async function getPersistedErrors(limit = 30) {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    if (!SURL || !KEY) return ERROR_BUFFER.slice(0, limit);
    const r = await fetch(
      `${SURL}/rest/v1/error_logs?select=created_at,source,message&order=created_at.desc&limit=${limit}`,
      { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
    );
    if (!r.ok) return ERROR_BUFFER.slice(0, limit);
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) return ERROR_BUFFER.slice(0, limit);
    return rows.map(r => ({ ts: r.created_at, source: r.source, message: r.message }));
  } catch {
    return ERROR_BUFFER.slice(0, limit);
  }
}

// ─── Health check ────────────────────────────────────────────────────────────
async function getHealthCheck() {
  const mem = process.memoryUsage();
  const heapUsedMb  = Math.round(mem.heapUsed  / 1048576);
  const heapTotalMb = Math.round(mem.heapTotal / 1048576);
  const rssMb       = Math.round(mem.rss       / 1048576);
  const heapPct     = heapTotalMb > 0 ? Math.round(heapUsedMb / heapTotalMb * 100) : 0;

  // CPU usage (% over 1s sample)
  const cpuPct = await measureCpu();

  // DB ping — simple select to verify connection
  let dbOk = false;
  let dbLatencyMs = null;
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    if (SURL && KEY) {
      const t0 = Date.now();
      const r = await fetch(`${SURL}/rest/v1/users?select=id&limit=1`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(5000),
      });
      dbLatencyMs = Date.now() - t0;
      dbOk = r.ok;
    }
  } catch { dbOk = false; }

  // Gemini API reachability check — zero-cost model-metadata GET (no tokens spent)
  let anthropicOk = false;
  let anthropicLatencyMs = null;
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    if (apiKey) {
      const t0 = Date.now();
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, {
        method: 'GET',
        headers: { 'x-goog-api-key': apiKey },
        signal: AbortSignal.timeout(5000),
      });
      anthropicLatencyMs = Date.now() - t0;
      // 200 = reachable + valid key, 400/401/403 = reachable (bad key), 5xx = down
      anthropicOk = r.status < 500;
    }
  } catch { anthropicOk = false; }

  const memStatus = heapPct > 90 ? 'critical' : heapPct > 75 ? 'warning' : 'ok';
  const cpuStatus = cpuPct  > 90 ? 'critical' : cpuPct  > 70 ? 'warning' : 'ok';
  const dbStatus  = !dbOk ? 'error' : dbLatencyMs > 2000 ? 'warning' : 'ok';

  return {
    memory: { heapUsedMb, heapTotalMb, rssMb, heapPct, status: memStatus },
    cpu:    { pct: cpuPct, status: cpuStatus },
    db:     { ok: dbOk, latencyMs: dbLatencyMs, status: dbStatus },
    anthropic: { ok: anthropicOk, latencyMs: anthropicLatencyMs },
    uptime: Math.floor(process.uptime()),
    nodeVersion: process.version,
    env: process.env.NODE_ENV || 'development',
  };
}

function measureCpu() {
  return new Promise(resolve => {
    const t0 = process.cpuUsage();
    const hr0 = process.hrtime.bigint();
    setTimeout(() => {
      const t1 = process.cpuUsage(t0);
      const elapsed = Number(process.hrtime.bigint() - hr0) / 1000; // microseconds
      const cpuTotal = t1.user + t1.system;
      resolve(elapsed > 0 ? Math.min(100, Math.round(cpuTotal / elapsed * 100)) : 0);
    }, 200);
  });
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

    // SQL Injection notu: Aşağıdaki interpolasyonlar tamamen server-side new Date().toISOString()
    // kaynaklıdır. Kullanıcı girdisi içermez → PostgREST injection riski yok.
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

// ─── Anthropic usage (DB-based estimation) ───────────────────────────────────
// Anthropic'in /v1/usage endpoint'i public API'de mevcut değil.
// Maliyet tahminini DB'deki insight + personality sayısından hesaplıyoruz.
// Token ortalamaları:
//   Daily insight:      ~2200 input, ~900 output  (Sonnet)
//   Personality:        ~3500 input, ~2500 output  (Sonnet)
//   Compatibility:      ~2800 input, ~1200 output  (Sonnet)
const USAGE_PROFILES = {
  daily:       { inp: 2200, out: 900 },
  personality: { inp: 3500, out: 2500 },
  compat:      { inp: 2800, out: 1200 },
};

async function getAnthropicUsage() {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    if (!SURL || !KEY) return { ok: false, error: 'Supabase env var eksik' };

    const now   = new Date();
    const start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const h     = { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' };

    const count = async (q) => {
      const r = await fetch(`${SURL}/rest/v1/${q}`, { headers: h });
      return parseInt((r.headers.get('content-range') || '0/0').split('/')[1] || '0', 10);
    };

    const [insightCount, personalityCount] = await Promise.all([
      count(`daily_insights?select=id&date=gte.${start}`),
      count(`personality_analyses?select=id&created_at=gte.${start}T00:00:00Z`),
    ]);

    const dp = USAGE_PROFILES.daily;
    const pp = USAGE_PROFILES.personality;
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    const totalInp = insightCount * dp.inp + personalityCount * pp.inp;
    const totalOut = insightCount * dp.out + personalityCount * pp.out;
    const totalCost = calcCost(model, totalInp, totalOut);
    const totalRequests = insightCount + personalityCount;

    return {
      ok: true,
      source: 'estimate',
      model,
      inputTokens: totalInp,
      outputTokens: totalOut,
      costUsd: Math.round(totalCost * 100) / 100,
      requests: totalRequests,
      breakdown: {
        daily:       { count: insightCount,     costUsd: Math.round(calcCost(model, insightCount * dp.inp, insightCount * dp.out) * 100) / 100 },
        personality: { count: personalityCount, costUsd: Math.round(calcCost(model, personalityCount * pp.inp, personalityCount * pp.out) * 100) / 100 },
      },
      note: 'DB insight/personality sayısından ortalama token kullanımıyla hesaplandı',
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

// ─── Feedback stats ───────────────────────────────────────────────────────────
async function getFeedbackStats() {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    const h    = { apikey: KEY, Authorization: `Bearer ${KEY}` };
    const since30 = encodeURIComponent(new Date(Date.now() - 30 * 86400_000).toISOString());
    const since7  = encodeURIComponent(new Date(Date.now() - 7  * 86400_000).toISOString());

    // Önce toplam satır sayısını al (tarih filtresi olmadan) — debug amaçlı
    const [all30Res, all7Res, countRes] = await Promise.all([
      fetch(`${SURL}/rest/v1/feedback?select=content_type,is_positive&created_at=gte.${since30}`, { headers: h }),
      fetch(`${SURL}/rest/v1/feedback?select=content_type,is_positive,created_at&created_at=gte.${since7}&order=created_at.desc`, { headers: h }),
      fetch(`${SURL}/rest/v1/feedback?select=id&limit=1`, { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } }),
    ]);

    const totalAllTime = parseInt(countRes.headers?.get('content-range')?.split('/')[1] || '0', 10);
    console.log(`[Dashboard] Feedback table total rows (all time): ${totalAllTime}`);

    if (!all30Res.ok) {
      const errBody = await all30Res.text();
      console.error('[Dashboard] Feedback query failed:', all30Res.status, errBody);
      return { ok: false, error: `Supabase hatası (${all30Res.status})` };
    }

    const all30 = await all30Res.json();
    console.log(`[Dashboard] Feedback last 30d: ${all30.length} rows, all time: ${totalAllTime}`);
    const all7  = all7Res.ok ? await all7Res.json() : [];

    if (!Array.isArray(all30)) {
      console.error('[Dashboard] Feedback response not array:', JSON.stringify(all30).slice(0, 200));
      return { ok: false, error: 'Veri formatı hatalı' };
    }

    const total    = all30.length;
    const positive = all30.filter(r => r.is_positive).length;
    const negative = total - positive;
    const posRate  = total > 0 ? Math.round((positive / total) * 100) : null;
    const week7    = Array.isArray(all7) ? all7.length : 0;

    // By content type
    const byType = {};
    for (const r of all30) {
      const t = r.content_type || 'unknown';
      if (!byType[t]) byType[t] = { positive: 0, negative: 0 };
      if (r.is_positive) byType[t].positive++;
      else byType[t].negative++;
    }

    // Daily trend (last 7 days)
    const dailyTrend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().split('T')[0];
      const dayItems = Array.isArray(all7) ? all7.filter(r => r.created_at?.startsWith(d)) : [];
      dailyTrend.push({
        date: d,
        positive: dayItems.filter(r => r.is_positive).length,
        negative: dayItems.filter(r => !r.is_positive).length,
      });
    }

    return { ok: true, total, positive, negative, posRate, week7, byType, dailyTrend, totalAllTime };
  } catch (err) {
    logError('feedback', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleDashboardHtml(_req, res) {
  const htmlPath = path.join(__dirname, '../public/dashboard.html');
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'",
    });
    res.end(html);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Dashboard HTML bulunamadı');
  }
}

// ─── Password verification (scrypt, timing-safe) ──────────────────────────────
// Tercih edilen: DASHBOARD_PASSWORD_HASH = "scrypt:<saltHex>:<hashHex>"
// Eski format (scrypt$...$...) de hâlâ desteklenir.
// Fallback (deprecated): DASHBOARD_PASSWORD = plaintext (uyarı loglanır)
//
// Hash üretmek için:
//   node -e "const c=require('crypto');const p=process.argv[1];const s=c.randomBytes(16);const h=c.scryptSync(p,s,64);console.log('scrypt:'+s.toString('hex')+':'+h.toString('hex'))" 'MY_PASSWORD'

function verifyDashboardPassword(provided) {
  const hashSpec = process.env.DASHBOARD_PASSWORD_HASH;
  if (hashSpec && (hashSpec.startsWith('scrypt:') || hashSpec.startsWith('scrypt$'))) {
    const delim = hashSpec.includes('scrypt:') ? ':' : '$';
    const parts = hashSpec.split(delim);
    if (parts.length !== 3) return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expectedHash = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expectedHash.length === 0) return false;
    let derived;
    try {
      derived = crypto.scryptSync(String(provided), salt, expectedHash.length);
    } catch {
      return false;
    }
    if (derived.length !== expectedHash.length) return false;
    return crypto.timingSafeEqual(derived, expectedHash);
  }

  // Plaintext fallback — sadece backward-compat (development only)
  if (process.env.NODE_ENV === 'production') {
    console.warn('[Dashboard] Plaintext DASHBOARD_PASSWORD rejected in production — use DASHBOARD_PASSWORD_HASH instead.');
    return null;
  }
  const plain = process.env.DASHBOARD_PASSWORD;
  if (plain) {
    if (!verifyDashboardPassword._plainWarned) {
      console.warn('[Dashboard] DASHBOARD_PASSWORD plaintext modunda — DASHBOARD_PASSWORD_HASH\'e geçiş öneriliyor.');
      verifyDashboardPassword._plainWarned = true;
    }
    const providedBuf = Buffer.from(String(provided));
    const expectedBuf = Buffer.from(plain);
    if (providedBuf.length !== expectedBuf.length) {
      // Timing'i sabit tutmak için sahte karşılaştırma
      crypto.timingSafeEqual(expectedBuf, expectedBuf);
      return false;
    }
    return crypto.timingSafeEqual(providedBuf, expectedBuf);
  }

  return null; // Hiçbir env var tanımlı değil
}

async function handleLogin(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!process.env.DASHBOARD_PASSWORD_HASH && !process.env.DASHBOARD_PASSWORD) {
    writeJson(res, 503, { error: 'DASHBOARD_PASSWORD_HASH (veya DASHBOARD_PASSWORD) env var ayarlanmamış' });
    return;
  }
  let body = '';
  await new Promise(r => { req.on('data', c => { body += c; }); req.on('end', r); });
  let provided = '';
  try { provided = JSON.parse(body).password || ''; } catch { /* ignore */ }

  if (typeof provided !== 'string' || provided.length === 0 || provided.length > 512) {
    writeJson(res, 401, { error: 'Yanlış şifre' });
    return;
  }

  const ok = verifyDashboardPassword(provided);
  if (ok !== true) {
    writeJson(res, 401, { error: 'Yanlış şifre' });
    return;
  }
  writeJson(res, 200, { token: makeToken() });
}

async function handleStats(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;

  const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
  if (!force && statsCache && Date.now() - statsCacheAge < CACHE_TTL) {
    writeJson(res, 200, { ...statsCache, cached: true });
    return;
  }

  const [supabaseStats, anthropicUsage, oneSignalStats, feedbackStats, health, recentErrors] = await Promise.all([
    getSupabaseStats(),
    getAnthropicUsage(),
    getOneSignalStats(),
    getFeedbackStats(),
    getHealthCheck(),
    getPersistedErrors(20),
  ]);

  const payload = {
    fetchedAt: new Date().toISOString(),
    supabase:  supabaseStats,
    anthropic: anthropicUsage,
    onesignal: oneSignalStats,
    feedback:  feedbackStats,
    health,
    server: {
      uptime:       health.uptime,
      nodeVersion:  health.nodeVersion,
      env:          health.env,
      recentErrors: recentErrors,
    },
    cached: false,
  };

  statsCache    = payload;
  statsCacheAge = Date.now();
  writeJson(res, 200, payload);
}

async function handleInsightTrend(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;
  writeJson(res, 200, await getInsightTrend());
}

async function handleOptions(_req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': dashboardCorsOrigin(),
    'Access-Control-Allow-Headers': 'x-dashboard-token, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end();
}

// ─── Revenue stats ───────────────────────────────────────────────────────────
async function getRevenueStats() {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    if (!SURL || !KEY) return { ok: false, error: 'Env var eksik' };
    const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };

    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const day30Ago = new Date(Date.now() - 30 * 86400_000).toISOString();
    const day7Ago  = new Date(Date.now() - 7  * 86400_000).toISOString();

    const [eventsRes, monthRes, premiumCountRes] = await Promise.all([
      fetch(`${SURL}/rest/v1/revenue_events?select=event_type,amount_usd,is_trial,event_at,product_id&event_at=gte.${day30Ago}&environment=eq.PRODUCTION&order=event_at.desc`, { headers: h }),
      fetch(`${SURL}/rest/v1/revenue_events?select=amount_usd,event_type,event_at&event_at=gte.${monthStart}T00:00:00Z&environment=eq.PRODUCTION`, { headers: h }),
      fetch(`${SURL}/rest/v1/users?select=id&is_premium=eq.true`, { headers: { ...h, Prefer: 'count=exact', Range: '0-0' } }),
    ]);

    const events30  = await eventsRes.json();
    const monthEvts = await monthRes.json();
    const premiumCount = parseInt((premiumCountRes.headers.get('content-range') || '0/0').split('/')[1] || '0', 10);

    if (!Array.isArray(events30)) return { ok: false, error: 'Revenue veri hatası' };

    // MRR: aktif premium × aylık fiyat tahmini (son 30g toplam gelir)
    const revenueTypes = new Set(['INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE']);
    const revenue30d = events30.filter(e => revenueTypes.has(e.event_type)).reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
    const monthRevenue = Array.isArray(monthEvts) ? monthEvts.filter(e => revenueTypes.has(e.event_type)).reduce((s, e) => s + (Number(e.amount_usd) || 0), 0) : 0;

    // Trial → Paid conversion (last 30d)
    const trials = events30.filter(e => e.is_trial && e.event_type === 'INITIAL_PURCHASE').length;
    const paidAfterTrial = events30.filter(e => !e.is_trial && e.event_type === 'RENEWAL').length;
    const trialConversion = trials > 0 ? Math.round(paidAfterTrial / trials * 100) : null;

    // Cancellations last 30d
    const cancellations30d = events30.filter(e => e.event_type === 'CANCELLATION').length;
    const renewals30d = events30.filter(e => e.event_type === 'RENEWAL').length;
    const churnRate = (renewals30d + cancellations30d) > 0 ? Math.round(cancellations30d / (renewals30d + cancellations30d) * 100) : null;

    // ARPU (average revenue per active premium user)
    const arpu = premiumCount > 0 ? Math.round(revenue30d / premiumCount * 100) / 100 : null;

    // Daily revenue trend (last 30 days)
    const dailyRevenue = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400_000).toISOString().split('T')[0];
      const dayTotal = events30
        .filter(e => revenueTypes.has(e.event_type) && e.event_at?.startsWith(d))
        .reduce((s, e) => s + (Number(e.amount_usd) || 0), 0);
      dailyRevenue.push({ date: d, amount: Math.round(dayTotal * 100) / 100 });
    }

    // Recent events (last 10)
    const recentEvents = events30.slice(0, 10).map(e => ({
      type: e.event_type,
      amount: e.amount_usd,
      product: e.product_id,
      trial: e.is_trial,
      at: e.event_at,
    }));

    return {
      ok: true,
      mrr: Math.round(revenue30d * 100) / 100,
      monthRevenue: Math.round(monthRevenue * 100) / 100,
      premiumCount,
      arpu,
      trialConversion,
      churnRate,
      cancellations30d,
      renewals30d,
      trials,
      dailyRevenue,
      recentEvents,
    };
  } catch (err) {
    logError('revenue', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Users list (paginated) ──────────────────────────────────────────────────
async function handleUsersList(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;

  const url = new URL(req.url, 'http://x');
  const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const limit  = Math.min(100, Math.max(10, parseInt(url.searchParams.get('limit') || '50', 10)));
  const filter = url.searchParams.get('filter') || '';   // premium, free, churn
  const search = url.searchParams.get('search') || '';   // email/name search
  const sort   = url.searchParams.get('sort') || 'created_at.desc';

  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };

    // Build query
    let query = `${SURL}/rest/v1/users?select=id,email,preferred_name,sun_sign,moon_sign,ascendant_sign,is_premium,created_at,push_token,timezone`;
    const filters = [];

    if (filter === 'premium') filters.push('is_premium=eq.true');
    if (filter === 'free') filters.push('is_premium=eq.false');
    if (search) filters.push(`or=(email.ilike.*${encodeURIComponent(search)}*,preferred_name.ilike.*${encodeURIComponent(search)}*)`);

    if (filters.length) query += '&' + filters.join('&');

    // Sort
    const [sortCol, sortDir] = sort.split('.');
    const validCols = ['created_at', 'email', 'sun_sign', 'is_premium'];
    const col = validCols.includes(sortCol) ? sortCol : 'created_at';
    const dir = sortDir === 'asc' ? 'asc' : 'desc';
    query += `&order=${col}.${dir}`;

    // Pagination
    const offset = (page - 1) * limit;
    query += `&offset=${offset}&limit=${limit}`;

    const countH = { ...h, Prefer: 'count=exact', Range: `${offset}-${offset + limit - 1}` };
    const r = await fetch(query, { headers: countH });
    const totalCount = parseInt((r.headers.get('content-range') || '0/0').split('/')[1] || '0', 10);
    const users = await r.json();

    if (!Array.isArray(users)) {
      writeJson(res, 200, { users: [], total: 0, page, pages: 0 });
      return;
    }

    // Get last insight date for each user
    const userIds = users.map(u => u.id);
    let insightMap = {};
    let feedbackMap = {};
    if (userIds.length > 0) {
      const idsParam = userIds.map(id => `"${id}"`).join(',');
      const [insightRes, fbRes] = await Promise.all([
        fetch(`${SURL}/rest/v1/daily_insights?select=user_id,date&user_id=in.(${idsParam})&order=date.desc&limit=${userIds.length}`, { headers: h }),
        fetch(`${SURL}/rest/v1/feedback?select=user_id,is_positive&user_id=in.(${idsParam})`, { headers: h }),
      ]);
      const insights = await insightRes.json();
      const feedbacks = await fbRes.json();

      // Latest insight per user
      if (Array.isArray(insights)) {
        for (const i of insights) {
          if (!insightMap[i.user_id]) insightMap[i.user_id] = i.date;
        }
      }
      // Feedback summary per user
      if (Array.isArray(feedbacks)) {
        for (const f of feedbacks) {
          if (!feedbackMap[f.user_id]) feedbackMap[f.user_id] = { pos: 0, neg: 0 };
          if (f.is_positive) feedbackMap[f.user_id].pos++;
          else feedbackMap[f.user_id].neg++;
        }
      }
    }

    const enriched = users.map(u => ({
      id: u.id,
      email: u.email ? u.email.replace(/^(.{2}).*(@.*)$/, '$1***$2') : '—',
      name: u.preferred_name || '—',
      sunSign: u.sun_sign || '—',
      moonSign: u.moon_sign || '—',
      ascendant: u.ascendant_sign || '—',
      premium: !!u.is_premium,
      hasPush: !!u.push_token,
      createdAt: u.created_at,
      lastInsight: insightMap[u.id] || null,
      feedbackScore: feedbackMap[u.id] ? feedbackMap[u.id].pos - feedbackMap[u.id].neg : 0,
      feedbackTotal: feedbackMap[u.id] ? feedbackMap[u.id].pos + feedbackMap[u.id].neg : 0,
    }));

    writeJson(res, 200, {
      users: enriched,
      total: totalCount,
      page,
      pages: Math.ceil(totalCount / limit),
    });
  } catch (err) {
    logError('users-list', err.message);
    writeJson(res, 500, { error: 'Kullanıcı listesi alınamadı' });
  }
}

// ─── Cron runs history ───────────────────────────────────────────────────────
async function getCronStats() {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    if (!SURL || !KEY) return { ok: false, error: 'Env var eksik' };
    const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };
    const day7Ago = new Date(Date.now() - 7 * 86400_000).toISOString();

    const r = await fetch(
      `${SURL}/rest/v1/cron_runs?select=id,job_name,started_at,finished_at,status,users_processed,users_failed,duration_ms,error_message,metadata&started_at=gte.${day7Ago}&order=started_at.desc&limit=100`,
      { headers: h }
    );

    if (!r.ok) return { ok: false, error: 'Cron veri hatası' };
    const runs = await r.json();
    if (!Array.isArray(runs)) return { ok: false, runs: [] };

    // Summary per job
    const jobs = {};
    for (const run of runs) {
      if (!jobs[run.job_name]) jobs[run.job_name] = { total: 0, success: 0, error: 0, lastRun: null, lastSuccess: null, avgDuration: 0, durations: [] };
      const j = jobs[run.job_name];
      j.total++;
      if (run.status === 'success') { j.success++; if (!j.lastSuccess) j.lastSuccess = run.started_at; }
      if (run.status === 'error') j.error++;
      if (!j.lastRun) j.lastRun = run.started_at;
      if (run.duration_ms) j.durations.push(run.duration_ms);
    }
    for (const j of Object.values(jobs)) {
      j.avgDuration = j.durations.length > 0 ? Math.round(j.durations.reduce((a, b) => a + b, 0) / j.durations.length) : null;
      delete j.durations;
    }

    // Last 10 runs for display
    const recent = runs.slice(0, 15).map(r => ({
      job: r.job_name,
      status: r.status,
      startedAt: r.started_at,
      durationMs: r.duration_ms,
      processed: r.users_processed,
      failed: r.users_failed,
      error: r.error_message,
    }));

    return { ok: true, jobs, recent };
  } catch (err) {
    logError('cron-stats', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Cohort retention ────────────────────────────────────────────────────────
async function getCohortRetention() {
  try {
    const SURL = process.env.SUPABASE_URL;
    const KEY  = process.env.SUPABASE_SERVICE_KEY;
    if (!SURL || !KEY) return { ok: false, error: 'Env var eksik' };
    const h = { apikey: KEY, Authorization: `Bearer ${KEY}` };

    // Get all users created in last 8 weeks with their signup date
    const weeksAgo = new Date(Date.now() - 8 * 7 * 86400_000).toISOString();

    const [usersRes, insightsRes] = await Promise.all([
      fetch(`${SURL}/rest/v1/users?select=id,created_at&created_at=gte.${weeksAgo}&order=created_at.asc`, { headers: h }),
      fetch(`${SURL}/rest/v1/daily_insights?select=user_id,date&created_at=gte.${weeksAgo}&order=date.asc`, { headers: h }),
    ]);

    const users    = await usersRes.json();
    const insights = await insightsRes.json();

    if (!Array.isArray(users) || !Array.isArray(insights)) {
      return { ok: false, error: 'Veri alınamadı' };
    }

    // Build insight dates per user
    const userInsightDates = {};
    for (const i of insights) {
      if (!userInsightDates[i.user_id]) userInsightDates[i.user_id] = new Set();
      userInsightDates[i.user_id].add(i.date);
    }

    // Group users into weekly cohorts (Monday start)
    function getWeekStart(dateStr) {
      const d = new Date(dateStr);
      const day = d.getUTCDay();
      const diff = (day === 0 ? 6 : day - 1); // Monday = 0
      d.setUTCDate(d.getUTCDate() - diff);
      return d.toISOString().split('T')[0];
    }

    const cohorts = {};
    for (const user of users) {
      const weekStart = getWeekStart(user.created_at);
      if (!cohorts[weekStart]) cohorts[weekStart] = [];
      cohorts[weekStart].push(user);
    }

    // For each cohort, calculate W0..W4 retention
    const cohortData = [];
    const sortedWeeks = Object.keys(cohorts).sort();

    for (const weekStart of sortedWeeks) {
      const cohortUsers = cohorts[weekStart];
      const size = cohortUsers.length;
      const retention = [];

      for (let w = 0; w <= 4; w++) {
        const weekStartDate = new Date(weekStart);
        weekStartDate.setUTCDate(weekStartDate.getUTCDate() + w * 7);
        const weekEndDate = new Date(weekStartDate);
        weekEndDate.setUTCDate(weekEndDate.getUTCDate() + 7);

        if (weekStartDate > new Date()) { retention.push(null); continue; }

        const wsStr = weekStartDate.toISOString().split('T')[0];
        const weStr = weekEndDate.toISOString().split('T')[0];

        let active = 0;
        for (const user of cohortUsers) {
          const dates = userInsightDates[user.id];
          if (!dates) continue;
          for (const d of dates) {
            if (d >= wsStr && d < weStr) { active++; break; }
          }
        }

        retention.push(size > 0 ? Math.round(active / size * 100) : 0);
      }

      cohortData.push({
        week: weekStart,
        size,
        retention, // [W0%, W1%, W2%, W3%, W4%]
      });
    }

    // Overall D1, D7, D30 for summary card
    const day30Users = users.filter(u => new Date(u.created_at) <= new Date(Date.now() - 30 * 86400_000));
    const day7Users  = users.filter(u => new Date(u.created_at) <= new Date(Date.now() - 7  * 86400_000));
    const day1Users  = users.filter(u => new Date(u.created_at) <= new Date(Date.now() - 1  * 86400_000));

    function retentionAtDay(userList, days) {
      if (userList.length === 0) return null;
      let retained = 0;
      for (const user of userList) {
        const targetDate = new Date(new Date(user.created_at).getTime() + days * 86400_000);
        const tStr = targetDate.toISOString().split('T')[0];
        const dates = userInsightDates[user.id];
        if (dates && dates.has(tStr)) retained++;
      }
      return Math.round(retained / userList.length * 100);
    }

    return {
      ok: true,
      cohorts: cohortData,
      summary: {
        d1:  retentionAtDay(day1Users, 1),
        d7:  retentionAtDay(day7Users, 7),
        d30: retentionAtDay(day30Users, 30),
      },
    };
  } catch (err) {
    logError('cohort', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Extended stats (include revenue, cron, cohort) ──────────────────────────
async function handleExtendedStats(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;

  const [revenue, cronStats, cohort] = await Promise.all([
    getRevenueStats(),
    getCronStats(),
    getCohortRetention(),
  ]);

  writeJson(res, 200, { revenue, cron: cronStats, cohort });
}

// ─── Prompt editor ───────────────────────────────────────────────────────────
// AI prompt'ları sürümlenmiş olarak DB'de tutuluyor (sql/010_prompts.sql).
// Buradaki uçlar yalnızca panelden erişilir; kimlik doğrulama mevcut HMAC
// token mekanizmasının aynısıdır (checkDashboardAuth).

const PROMPT_BODY_LIMIT = 200_000; // ~200 KB — en uzun prompt bunun onda biri

function readJsonBody(req, limit = PROMPT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      body += chunk;
      if (body.length > limit) {
        aborted = true;
        reject(new Error('İstek gövdesi çok büyük'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Geçersiz JSON gövdesi')); }
    });
    req.on('error', (err) => { if (!aborted) reject(err); });
  });
}

async function handlePromptsList(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;
  try {
    writeJson(res, 200, { prompts: await promptStore.listPromptState() });
  } catch (err) {
    logError('prompts', err.message);
    writeJson(res, 500, { error: 'Prompt listesi alınamadı' });
  }
}

async function handlePromptHistory(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;
  const key = new URL(req.url, 'http://x').searchParams.get('key') || '';
  if (!promptStore.getPromptMeta(key)) { writeJson(res, 400, { error: 'Bilinmeyen prompt anahtarı' }); return; }
  try {
    writeJson(res, 200, { key, versions: await promptStore.getHistory(key) });
  } catch (err) {
    // Geçmiş okunamaması düzenlemeyi engellememeli — boş liste + uyarı dön.
    logError('prompts-history', err.message);
    writeJson(res, 200, { key, versions: [], warning: `Geçmiş okunamadı: ${err.message}` });
  }
}

async function handlePromptVersion(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;
  const params = new URL(req.url, 'http://x').searchParams;
  const key = params.get('key') || '';
  if (!promptStore.getPromptMeta(key)) { writeJson(res, 400, { error: 'Bilinmeyen prompt anahtarı' }); return; }
  try {
    writeJson(res, 200, await promptStore.getVersionContent(key, params.get('version')));
  } catch (err) {
    writeJson(res, 400, { error: err.message });
  }
}

async function handlePromptSave(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { writeJson(res, 400, { error: err.message }); return; }

  try {
    const result = await promptStore.savePrompt(body.key, body.content, { note: body.note });
    writeJson(res, 200, { ok: true, ...result });
  } catch (err) {
    // Doğrulama hatası kullanıcı hatasıdır (400); diğerleri sunucu tarafı (500).
    if (err.validation) { writeJson(res, 400, { error: err.message }); return; }
    logError('prompts-save', err.message);
    writeJson(res, 500, { error: `Kaydedilemedi: ${err.message}` });
  }
}

async function handlePromptRevert(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { writeJson(res, 400, { error: err.message }); return; }

  try {
    const result = await promptStore.revertPrompt(body.key, body.version);
    writeJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err.validation) { writeJson(res, 400, { error: err.message }); return; }
    logError('prompts-revert', err.message);
    writeJson(res, 500, { error: `Geri alınamadı: ${err.message}` });
  }
}

async function handlePromptReset(req, res) {
  res.setHeader('Access-Control-Allow-Origin', dashboardCorsOrigin());
  if (!checkDashboardAuth(req, res)) return;
  let body;
  try { body = await readJsonBody(req); }
  catch (err) { writeJson(res, 400, { error: err.message }); return; }

  try {
    const result = await promptStore.resetPrompt(body.key);
    writeJson(res, 200, { ok: true, ...result });
  } catch (err) {
    if (err.validation) { writeJson(res, 400, { error: err.message }); return; }
    logError('prompts-reset', err.message);
    writeJson(res, 500, { error: `Varsayılana dönülemedi: ${err.message}` });
  }
}

module.exports = [
  ['GET',     /^\/dashboard$/,                    handleDashboardHtml],
  ['POST',    /^\/dashboard\/login$/,              handleLogin],
  ['GET',     /^\/dashboard\/stats$/,              handleStats],
  ['GET',     /^\/dashboard\/stats\/insights$/,    handleInsightTrend],
  ['GET',     /^\/dashboard\/stats\/extended$/,    handleExtendedStats],
  ['GET',     /^\/dashboard\/stats\/users$/,       handleUsersList],
  ['GET',     /^\/dashboard\/prompts$/,            handlePromptsList],
  ['GET',     /^\/dashboard\/prompts\/history$/,   handlePromptHistory],
  ['GET',     /^\/dashboard\/prompts\/version$/,   handlePromptVersion],
  ['POST',    /^\/dashboard\/prompts\/save$/,      handlePromptSave],
  ['POST',    /^\/dashboard\/prompts\/revert$/,    handlePromptRevert],
  ['POST',    /^\/dashboard\/prompts\/reset$/,     handlePromptReset],
  ['OPTIONS', /^\/dashboard/,                      handleOptions],
];

module.exports.logDashboardError = logError;
