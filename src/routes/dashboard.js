'use strict';

/**
 * Dashboard Stats Route
 * GET /dashboard/stats
 *
 * Aggregates live data from Supabase, Anthropic, and OneSignal.
 * Protected by DASHBOARD_KEY env var (falls back to SHIMAL_API_KEY).
 * Returns CORS * so the local HTML file can call it.
 */

const supabase = require('../config/supabase');
const { writeJson } = require('../utils/http');

// ─── Pricing (as of 2025) ────────────────────────────────────────────────────
const PRICING = {
  'claude-opus-4-6':         { input: 15.00,  output: 75.00  },
  'claude-sonnet-4-6':       { input: 3.00,   output: 15.00  },
  'claude-sonnet-4-5':       { input: 3.00,   output: 15.00  },
  'claude-haiku-4-5':        { input: 0.80,   output: 4.00   },
  'claude-3-5-sonnet':       { input: 3.00,   output: 15.00  },
  'claude-3-5-haiku':        { input: 0.80,   output: 4.00   },
  'claude-3-opus':           { input: 15.00,  output: 75.00  },
  'claude-3-haiku':          { input: 0.25,   output: 1.25   },
  default:                   { input: 3.00,   output: 15.00  },
};

function calcCost(model, inputTokens, outputTokens) {
  const key = Object.keys(PRICING).find((k) => model && model.startsWith(k)) || 'default';
  const p = PRICING[key];
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}

// ─── Supabase stats ───────────────────────────────────────────────────────────
async function getSupabaseStats() {
  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
    const headers = {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      Prefer: 'count=exact',
      Range: '0-0',
    };

    // Total users
    const totalRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?select=id`,
      { headers }
    );
    const totalRange = totalRes.headers.get('content-range') || '';
    const totalUsers = parseInt(totalRange.split('/')[1] ?? '0', 10) || 0;

    // Users with push token
    const pushRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?select=id&push_token=not.is.null`,
      { headers }
    );
    const pushRange = pushRes.headers.get('content-range') || '';
    const usersWithPush = parseInt(pushRange.split('/')[1] ?? '0', 10) || 0;

    // New users today (created_at >= today 00:00 UTC)
    const today = new Date().toISOString().split('T')[0];
    const newTodayRes = await fetch(
      `${SUPABASE_URL}/rest/v1/users?select=id&created_at=gte.${today}T00:00:00.000Z`,
      { headers }
    );
    const newTodayRange = newTodayRes.headers.get('content-range') || '';
    const newUsersToday = parseInt(newTodayRange.split('/')[1] ?? '0', 10) || 0;

    // Daily insights generated today
    let insightsToday = 0;
    try {
      const insightRes = await fetch(
        `${SUPABASE_URL}/rest/v1/daily_insights?select=id&date=eq.${today}`,
        { headers }
      );
      const insightRange = insightRes.headers.get('content-range') || '';
      insightsToday = parseInt(insightRange.split('/')[1] ?? '0', 10) || 0;
    } catch {
      // table might not exist yet
    }

    return { totalUsers, usersWithPush, newUsersToday, insightsToday, ok: true };
  } catch (err) {
    console.error('[Dashboard] Supabase stats error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Anthropic usage ──────────────────────────────────────────────────────────
async function getAnthropicUsage(apiKey) {
  try {
    // This month
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = now.toISOString().split('T')[0];

    const res = await fetch(
      `https://api.anthropic.com/v1/usage?start_date=${startDate}&end_date=${endDate}`,
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    if (!res.ok) {
      // Fallback: try the messages usage endpoint
      const res2 = await fetch(
        `https://api.anthropic.com/v1/usage/messages?start_date=${startDate}&end_date=${endDate}`,
        {
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
        }
      );
      if (!res2.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data2 = await res2.json();
      return processAnthropicData(data2);
    }

    const data = await res.json();
    return processAnthropicData(data);
  } catch (err) {
    console.error('[Dashboard] Anthropic usage error:', err.message);
    return { ok: false, error: err.message };
  }
}

function processAnthropicData(data) {
  // Handle both array and object response shapes
  const entries = Array.isArray(data) ? data
    : Array.isArray(data.data) ? data.data
    : data.usage ? [data.usage]
    : [];

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalRequests = entries.length;
  let costUsd = 0;

  for (const entry of entries) {
    const inp = entry.input_tokens ?? 0;
    const out = entry.output_tokens ?? 0;
    const cacheRead = entry.cache_read_input_tokens ?? 0;
    totalInput += inp;
    totalOutput += out;
    totalCacheRead += cacheRead;
    costUsd += calcCost(entry.model, inp, out);
  }

  return {
    ok: true,
    totalRequests,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheReadTokens: totalCacheRead,
    totalTokens: totalInput + totalOutput,
    estimatedCostUsd: Math.round(costUsd * 100) / 100,
    period: `Bu ay`,
  };
}

// ─── OneSignal stats ──────────────────────────────────────────────────────────
async function getOneSignalStats(appId, restApiKey) {
  try {
    if (!appId || !restApiKey) return { ok: false, error: 'Missing env vars' };

    const res = await fetch(`https://onesignal.com/api/v1/apps/${appId}`, {
      headers: {
        Authorization: `Basic ${restApiKey}`,
      },
    });

    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = await res.json();

    return {
      ok: true,
      players: data.players ?? 0,
      messagable_players: data.messagable_players ?? 0,
      updated_at: data.updated_at,
    };
  } catch (err) {
    console.error('[Dashboard] OneSignal stats error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────
async function handleDashboardStats(req, res) {
  // Auth
  const validKey = process.env.DASHBOARD_KEY || process.env.SHIMAL_API_KEY;
  if (validKey) {
    const provided = req.headers['x-dashboard-key'] || req.headers['x-api-key'] || '';
    if (provided !== validKey) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(JSON.stringify({ error: 'Geçersiz dashboard key' }));
      return;
    }
  }

  // Fetch all in parallel
  const [supabaseStats, anthropicUsage, oneSignalStats] = await Promise.all([
    getSupabaseStats(),
    getAnthropicUsage(process.env.ANTHROPIC_API_KEY),
    getOneSignalStats(process.env.ONESIGNAL_APP_ID, process.env.ONESIGNAL_API_KEY),
  ]);

  const payload = {
    fetchedAt: new Date().toISOString(),
    supabase: supabaseStats,
    anthropic: anthropicUsage,
    onesignal: oneSignalStats,
    server: {
      uptime: Math.floor(process.uptime()),
      nodeVersion: process.version,
      env: process.env.NODE_ENV || 'development',
    },
  };

  // CORS * so the local HTML file (file://) can reach the deployed backend
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-api-key, x-dashboard-key, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });
  res.end(JSON.stringify(payload));
}

async function handleDashboardOptions(_req, res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-api-key, x-dashboard-key, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });
  res.end();
}

module.exports = [
  ['GET',     /^\/dashboard\/stats$/, handleDashboardStats],
  ['OPTIONS', /^\/dashboard\/stats$/, handleDashboardOptions],
];
