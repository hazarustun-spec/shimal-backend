'use strict';

const supabase = require('../config/supabase');
const { writeJson } = require('../utils/http');
const { logDashboardError } = require('./dashboard');

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'NON_RENEWING_PURCHASE',
  'PRODUCT_CHANGE',
  'CANCELLATION',
  'UNCANCELLATION',
  'BILLING_ISSUE_DETECTED',
  'SUBSCRIBER_ALIAS',
  'EXPIRATION',
  'TRANSFER',
]);

/** Events that grant premium */
const PREMIUM_ON_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'UNCANCELLATION',
]);

/** Events that revoke premium.
 * CANCELLATION is deliberately NOT here: it only means auto-renew was turned
 * off — the user keeps access until the paid period ends, at which point
 * RevenueCat sends EXPIRATION. */
const PREMIUM_OFF_EVENTS = new Set([
  'EXPIRATION',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Read raw request body as a string */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Resolve our internal user_id from RevenueCat's app_user_id */
async function resolveUserId(appUserId) {
  if (!appUserId) return null;

  // If app_user_id is already a valid UUID, check users table directly
  if (UUID_RE.test(appUserId)) {
    const { data } = await supabase
      .from('users')
      .select('id')
      .eq('id', appUserId)
      .single();
    if (data) return data.id;
  }

  // Otherwise try matching by rc_customer_id column
  const { data } = await supabase
    .from('users')
    .select('id')
    .eq('rc_customer_id', appUserId)
    .single();

  return data ? data.id : null;
}

/** Update user premium status based on event type */
async function updatePremiumStatus(userId, eventType) {
  if (!userId) return;

  if (PREMIUM_ON_EVENTS.has(eventType)) {
    await supabase
      .from('users')
      .update({ is_premium: true })
      .eq('id', userId);
  } else if (PREMIUM_OFF_EVENTS.has(eventType)) {
    await supabase
      .from('users')
      .update({ is_premium: false })
      .eq('id', userId);
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handleRevenueCatWebhook(req, res) {
  // Always return 200 — RevenueCat retries on non-200
  try {
    // ── Auth check ──
    const secret = process.env.REVENUECAT_WEBHOOK_SECRET;
    if (secret) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      if (token !== secret) {
        console.warn('[Webhook/RC] Invalid auth token');
        return writeJson(res, 200, { ok: false, error: 'unauthorized' });
      }
    }

    // ── Parse body ──
    const raw = await readRawBody(req);
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      console.warn('[Webhook/RC] Invalid JSON body');
      return writeJson(res, 200, { ok: false, error: 'invalid_json' });
    }

    const event = payload.event;
    if (!event) {
      console.warn('[Webhook/RC] Missing event object in payload');
      return writeJson(res, 200, { ok: false, error: 'missing_event' });
    }

    // ── Extract fields ──
    const eventType = event.type;
    if (!VALID_EVENT_TYPES.has(eventType)) {
      console.log(`[Webhook/RC] Ignoring unknown event type: ${eventType}`);
      return writeJson(res, 200, { ok: true, skipped: true });
    }

    const appUserId   = event.app_user_id || null;
    const productId   = event.product_id || null;
    const priceRaw    = event.price_in_purchased_currency;
    const currency    = event.currency || 'USD';
    const periodType  = event.period_type || null;        // TRIAL, NORMAL, INTRO
    const isTrial     = periodType === 'TRIAL';
    const environment = event.environment || 'PRODUCTION';
    const eventAt     = event.event_timestamp_ms
      ? new Date(event.event_timestamp_ms).toISOString()
      : new Date().toISOString();

    // Revenue after Apple's 30% cut
    const amountUsd = (typeof priceRaw === 'number') ? +(priceRaw * 0.7).toFixed(2) : null;

    // ── Resolve user ──
    const userId = await resolveUserId(appUserId);

    // ── Store event ──
    const { error: insertErr } = await supabase.from('revenue_events').insert({
      event_type:     eventType,
      user_id:        userId,
      rc_customer_id: appUserId,
      product_id:     productId,
      amount_usd:     amountUsd,
      currency,
      is_trial:       isTrial,
      period_type:    periodType,
      environment,
      event_at:       eventAt,
      raw_payload:    payload,
    });

    if (insertErr) {
      console.error('[Webhook/RC] DB insert error:', insertErr.message);
      logDashboardError('webhook-rc', insertErr.message);
    }

    // ── Update premium status ──
    await updatePremiumStatus(userId, eventType);

    console.log(`[Webhook/RC] ${eventType} — product=${productId} user=${userId || appUserId || 'unknown'} amount=$${amountUsd ?? '?'} env=${environment}`);
    return writeJson(res, 200, { ok: true });

  } catch (err) {
    // Never return non-200 to RevenueCat
    console.error('[Webhook/RC] Unhandled error:', err);
    logDashboardError('webhook-rc', err.message || String(err));
    return writeJson(res, 200, { ok: false, error: 'internal' });
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = [
  ['POST', /^\/api\/webhook\/revenuecat$/, handleRevenueCatWebhook],
];
