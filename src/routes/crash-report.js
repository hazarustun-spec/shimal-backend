'use strict';

const crypto = require('crypto');
const supabase = require('../config/supabase');
const { writeJson, badRequest, readJsonBody } = require('../utils/http');

// Sentry — optional
let Sentry;
try { Sentry = require('@sentry/node'); } catch (_) { Sentry = null; }

// KVKK: deviceId'yi 3. taraflara (Sentry) DÜZ göndermek yerine pseudonymize et.
// Aynı deviceId her zaman aynı hash'i üretir → Sentry yine crash'leri kullanıcı
// bazında gruplayabilir, ama kimlik çözünürlüğü için SHIMAL_API_KEY gerekir.
function pseudonymizeDeviceId(deviceId) {
  if (!deviceId) return undefined;
  const secret = process.env.SHIMAL_SESSION_SECRET || process.env.SHIMAL_API_KEY || 'shimal-pseudonym-secret';
  return crypto.createHmac('sha256', secret).update(String(deviceId)).digest('hex').substring(0, 16);
}

async function handleCrashReport(req, res) {
  try {
    const body = await readJsonBody(req);
    const { type, reason, name, callStack, timestamp, appVersion, osVersion, deviceModel, deviceId, sessions, context } = body;

    if (!type || !reason) {
      return badRequest(res, 'type and reason are required');
    }

    // Sentry'ye ilet — deviceId yerine pseudonym gönderiyoruz (KVKK/GDPR)
    if (Sentry) {
      const error = new Error(`[${name || type}] ${reason}`);
      const pseudonymId = pseudonymizeDeviceId(deviceId);
      Sentry.captureException(error, {
        tags: { source: 'ios', type, appVersion, osVersion },
        user: pseudonymId ? { id: pseudonymId } : undefined,
        extra: { callStack, deviceModel, sessions, context, timestamp },
      });
    }

    // Supabase'e kaydet (opsiyonel — tablo yoksa sessizce geç)
    try {
      await supabase.from('crash_reports').insert({
        type,
        reason: reason.substring(0, 500),
        name: name || null,
        call_stack: callStack ? callStack.substring(0, 2000) : null,
        app_version: appVersion || null,
        os_version: osVersion || null,
        device_model: deviceModel || null,
        device_id: deviceId || null,
        session_count: sessions || null,
        context: context || null,
        reported_at: timestamp || new Date().toISOString(),
      });
    } catch (_) {
      // crash_reports tablosu henüz yoksa log'a yaz, hata döndürme
      console.warn(`[CrashReport] DB insert atlandı (tablo olmayabilir): ${reason.substring(0, 100)}`);
    }

    console.log(`[CrashReport] ${type} — ${reason.substring(0, 80)} — ${deviceId || 'anon'}`);
    writeJson(res, 200, { received: true });
  } catch (error) {
    // Crash reporter endpoint'inin kendisi hata verirse sessizce 200 dön
    console.error('[CrashReport] Handler error:', error.message);
    writeJson(res, 200, { received: false });
  }
}

module.exports = [
  ['POST', /^\/api\/crash-report$/, handleCrashReport],
];
