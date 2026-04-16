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

// Lock durumu takibi — tablo yoksa veya DB erişilemezse startup'ta uyar
let _lockTableVerified = false;
let _lockTableMissing = false;

/**
 * Kilit almayı dener. Başarılıysa true, aksi halde false döner.
 *
 * Strateji:
 *   - DB hatası + tek instance ortamı → true (fail-open, logla)
 *   - Tablo yoksa → her çağrıda WARN logla (dikkat çeksin)
 *   - Supabase env eksikse → true + uyarı
 */
async function acquireCronLock(jobName, ttlSeconds) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.warn(`[CronLock] ⚠️  Supabase env eksik, ${jobName} kilitsiz çalışıyor — çoklu instance riski!`);
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
      _lockTableVerified = true;
      return true;
    }
    if (res.status === 409) {
      // Başka instance aktif kilit tutuyor
      _lockTableVerified = true;
      return false;
    }

    // Tablo yoksa (42P01) veya başka DB hatası
    const text = await res.text().catch(() => '');

    // 42P01 = tablo bulunamadı → migration gerekiyor
    if (text.includes('42P01') || text.includes('cron_locks')) {
      if (!_lockTableMissing) {
        console.error(`[CronLock] ❌ cron_locks tablosu bulunamadı! Migration çalıştırın: backend/sql/002_cron_locks.sql`);
        console.error(`[CronLock] ⚠️  Çoklu instance'da duplicate job riski var — ${jobName} kilitsiz çalışacak`);
        _lockTableMissing = true;
      }
    } else {
      console.warn(`[CronLock] ${jobName} INSERT hatası (${res.status}): ${text.substring(0, 200)}`);
    }
    return true; // Fail-open — tek instance'ta çalışmayı bozmamak için
  } catch (err) {
    console.warn(`[CronLock] ${jobName} acquire exception:`, err.message || err);
    return true; // Fail-open
  }
}

/**
 * Startup'ta cron_locks tablosunun varlığını kontrol eder.
 * Hata oluşursa uyarı loglar ama process'i durdurmaz.
 */
async function verifyCronLockTable() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/cron_locks?select=job_name&limit=0`,
      { method: 'GET', headers: headers() }
    );
    if (res.ok) {
      _lockTableVerified = true;
      console.log('[CronLock] ✓ cron_locks tablosu doğrulandı');
    } else {
      const text = await res.text().catch(() => '');
      if (text.includes('42P01') || res.status === 404) {
        _lockTableMissing = true;
        console.error('[CronLock] ❌ cron_locks tablosu bulunamadı — backend/sql/002_cron_locks.sql çalıştırın!');
      }
    }
  } catch (err) {
    console.warn('[CronLock] Tablo kontrolü hatası:', err.message);
  }
}

// Startup'ta kontrol (non-blocking)
setImmediate(() => { verifyCronLockTable(); });

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

module.exports = { acquireCronLock, releaseCronLock, withCronLock, verifyCronLockTable, INSTANCE_ID };
