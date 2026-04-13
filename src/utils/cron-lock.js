'use strict';

// Dağıtık cron lock — çoklu Railway instance'ında duplicate çalışmayı engeller.
//
// Yaklaşım:
//   1. Süresi dolmuş kilitleri sil (expired locks temizlenir)
//   2. Yeni kilit INSERT et — PRIMARY KEY çakışması = başka instance tutuyor
//   3. Job bitince release et
//
// Migration: backend/sql/002_cron_locks.sql dosyasını Supabase'te çalıştır.
//
// Kullanım:
//   const released = await withCronLock('daily-gen', 60 * 60, async () => {
//     // ... job code
//   });
//   if (!released) console.log('Lock alınamadı, başka instance çalışıyor');

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Bu process'in benzersiz kimliği (log + debug için)
const INSTANCE_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

function headers() {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  };
}

/**
 * Kilit almayı dener. Başarılıysa true, aksi halde false döner.
 * DB hatası → true döner (fail-open: tek instance'ta çalışmayı bozmamak için).
 */
async function acquireCronLock(jobName, ttlSeconds) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn(`[CronLock] Supabase env eksik, ${jobName} kilitsiz çalışıyor`);
    return true;
  }
  try {
    const nowIso = new Date().toISOString();
    const expiresIso = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // 1. Süresi dolmuş kilidi (varsa) sil
    await fetch(
      `${SUPABASE_URL}/rest/v1/cron_locks?job_name=eq.${encodeURIComponent(jobName)}&locked_until=lt.${encodeURIComponent(nowIso)}`,
      { method: 'DELETE', headers: headers() }
    );

    // 2. INSERT dene — PK conflict = başka instance tutuyor
    const res = await fetch(`${SUPABASE_URL}/rest/v1/cron_locks`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        job_name: jobName,
        locked_until: expiresIso,
        instance_id: INSTANCE_ID,
      }),
    });

    if (res.status === 201 || res.status === 200) {
      return true;
    }
    if (res.status === 409) {
      // Başka instance aktif kilit tutuyor
      return false;
    }
    // Tablo yoksa (42P01) veya başka DB hatası → fail-open, logla
    const text = await res.text().catch(() => '');
    console.warn(`[CronLock] ${jobName} INSERT hatası (${res.status}): ${text.substring(0, 200)}`);
    return true;
  } catch (err) {
    console.warn(`[CronLock] ${jobName} acquire exception:`, err.message || err);
    return true; // Fail-open
  }
}

/**
 * Kilidi serbest bırakır (job bittiğinde çağrılır).
 * Sadece bu instance'ın tuttuğu kilidi siler.
 */
async function releaseCronLock(jobName) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/cron_locks?job_name=eq.${encodeURIComponent(jobName)}&instance_id=eq.${encodeURIComponent(INSTANCE_ID)}`,
      { method: 'DELETE', headers: headers() }
    );
  } catch (err) {
    console.warn(`[CronLock] ${jobName} release exception:`, err.message || err);
  }
}

/**
 * Wrapper: lock al, job'u çalıştır, finally'de serbest bırak.
 * Return: true → job çalıştı, false → başka instance çalıştırıyor, skip edildi.
 */
async function withCronLock(jobName, ttlSeconds, fn) {
  const acquired = await acquireCronLock(jobName, ttlSeconds);
  if (!acquired) {
    console.log(`[CronLock] ${jobName} → başka instance çalıştırıyor, skip`);
    return false;
  }
  try {
    await fn();
  } finally {
    await releaseCronLock(jobName);
  }
  return true;
}

module.exports = { acquireCronLock, releaseCronLock, withCronLock, INSTANCE_ID };
