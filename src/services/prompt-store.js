'use strict';

/**
 * Sürümlenmiş AI prompt deposu.
 *
 * Prompt metinleri iki yerde yaşıyor:
 *   1. src/services/prompt-defaults.js — koddaki varsayılan (her zaman geçerli taban)
 *   2. Supabase `ai_prompts` tablosu   — panelden düzenlenen sürümler (sql/010_prompts.sql)
 *
 * TEMEL KURAL — ÜRETİM ASLA DURMAZ:
 * getPrompt() hiçbir koşulda hata fırlatmaz. DB boşsa, erişilemiyorsa, satır
 * bozuksa veya kayıtlı metin doğrulamadan geçmiyorsa koddaki varsayılana düşer.
 * Yani paneldeki hatalı bir düzenleme en fazla "değişiklik uygulanmadı" demektir;
 * içgörü üretimi durmaz.
 *
 * ÖNBELLEK: Her AI çağrısında DB'ye gitmemek için kısa TTL'li in-memory cache
 * kullanılıyor. Kaydetme/geri alma/varsayılana dönme işlemleri ilgili anahtarı
 * anında geçersiz kılar. Birden fazla instance çalışıyorsa (bkz. MULTI_INSTANCE.md)
 * diğer instance'lar en geç TTL kadar sonra yeni sürümü görür.
 */

const defaults = require('./prompt-defaults');

const TABLE = 'ai_prompts';

// Başarılı okuma bu süre kadar cache'lenir.
const CACHE_TTL_MS = Number(process.env.PROMPT_CACHE_TTL_MS) || 60_000;
// DB okunamadığında varsayılan daha kısa süre cache'lenir: geçici bir kesinti
// düzelttiğinde bir dakika beklemeye gerek kalmasın, ama her AI çağrısı da
// çöken bir DB'yi dövmesin.
const FAIL_CACHE_TTL_MS = 15_000;

const READ_TIMEOUT_MS  = 5_000;
const WRITE_TIMEOUT_MS = 8_000;

const MAX_HISTORY = 25;

// ─── Kayıt defteri ────────────────────────────────────────────────────────────
// requiredTokens: metinden SİLİNMESİ üretimi bozacak parçalar. Kullanıcı çıktı
// formatından örneğin "love" alanını silerse uygulama o bölümü boş gösterir —
// bu yüzden kaydetmeye izin verilmiyor.

const PROMPT_REGISTRY = [
  {
    key: 'daily_system',
    label: 'Günlük İçgörü — Sistem Talimatı',
    description: 'Günlük burç yorumunu üreten ana talimat. Ton, paragraf yapısı ve JSON çıktı formatı burada tanımlı.',
    defaultText: defaults.DAILY_SYSTEM_PROMPT,
    minLength: 400,
    maxLength: 40_000,
    requiredTokens: [
      '"love"', '"career"', '"health"', '"money"', '"energy"', '"daily_focus"',
      '"notification"', '"title"', '"short"', '"detail"', '"suggestion"',
      '"dos"', '"donts"',
    ],
  },
  {
    key: 'personality_rules',
    label: 'Kişilik Analizi — Kurallar',
    description: 'Kişilik analizinin yazım tarzı ve gezegen yorumlama kuralları. Çıktı formatı ayrı iki prompt\'ta.',
    defaultText: defaults.PERSONALITY_RULES,
    minLength: 200,
    maxLength: 40_000,
    requiredTokens: [],
  },
  {
    key: 'personality_profile_format',
    label: 'Kişilik Analizi — Profil Çıktı Formatı',
    description: 'Özet, güçlü yönler ve gizli özellikler parçasının JSON şablonu.',
    defaultText: defaults.PERSONALITY_PROFILE_FORMAT,
    minLength: 80,
    maxLength: 10_000,
    requiredTokens: ['"summary"', '"strengths"', '"hiddenTraits"'],
  },
  {
    key: 'personality_planet_format',
    label: 'Kişilik Analizi — Gezegen Çıktı Formatı',
    description: 'Gezegen parçalarının JSON şablonu. {{PLANETS}} yer tutucusu o istekteki gezegen satırlarıyla doldurulur — silinirse gezegen yorumu üretilemez.',
    defaultText: defaults.PERSONALITY_PLANET_FORMAT,
    minLength: 60,
    maxLength: 10_000,
    requiredTokens: ['{{PLANETS}}', '"planets"'],
  },
];

const REGISTRY_BY_KEY = new Map(PROMPT_REGISTRY.map((p) => [p.key, p]));

function getPromptMeta(key) {
  return REGISTRY_BY_KEY.get(key) || null;
}

function listPromptMeta() {
  return PROMPT_REGISTRY.map(({ key, label, description, minLength, maxLength, requiredTokens }) =>
    ({ key, label, description, minLength, maxLength, requiredTokens }));
}

// ─── Doğrulama ────────────────────────────────────────────────────────────────

/**
 * Prompt metnini kaydedilmeden ÖNCE doğrular; okuma yolunda da aynı kontrol
 * uygulanır, böylece elle DB'ye yazılmış bozuk bir satır üretime sızmaz.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
function validatePrompt(key, content) {
  const meta = getPromptMeta(key);
  if (!meta) return { ok: false, error: 'Bilinmeyen prompt anahtarı' };

  if (typeof content !== 'string') return { ok: false, error: 'Prompt metni olmalı' };

  const text = content.replace(/\r\n/g, '\n');
  if (text.trim().length === 0) return { ok: false, error: 'Prompt boş olamaz' };

  if (text.length < meta.minLength) {
    return { ok: false, error: `Prompt çok kısa (${text.length} karakter, en az ${meta.minLength} olmalı)` };
  }
  if (text.length > meta.maxLength) {
    return { ok: false, error: `Prompt çok uzun (${text.length} karakter, en fazla ${meta.maxLength} olabilir)` };
  }

  const missing = meta.requiredTokens.filter((token) => !text.includes(token));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Şu zorunlu ifadeler metinden silinmiş: ${missing.join(', ')}. ` +
             'Bunlar silinirse model beklenen alanları üretmez ve uygulama o bölümleri boş gösterir.',
    };
  }

  return { ok: true };
}

// ─── Çözümleme (saf fonksiyon — test edilebilir) ─────────────────────────────

/**
 * DB'den gelen satırlardan hangi metnin kullanılacağına karar verir.
 * Ağ erişimi yok; fallback davranışının tamamı burada test edilebiliyor.
 *
 * @param {string} key
 * @param {Array|null} rows - PostgREST cevabı (aktif satır filtresiyle çekilmiş)
 * @returns {{ text: string, version: number|null, source: 'db'|'default', reason: string }}
 */
function resolveActiveRow(key, rows) {
  const meta = getPromptMeta(key);
  if (!meta) return { text: '', version: null, source: 'default', reason: 'unknown-key' };

  const fallback = (reason) => ({ text: meta.defaultText, version: null, source: 'default', reason });

  if (!Array.isArray(rows) || rows.length === 0) return fallback('db-empty');

  const row = rows.find((r) => r && typeof r === 'object' && r.content != null) || null;
  if (!row) return fallback('row-missing');

  const check = validatePrompt(key, row.content);
  if (!check.ok) {
    console.warn(`[Prompt] '${key}' v${row.version ?? '?'} doğrulamadan geçmedi (${check.error}) — koddaki varsayılan kullanılıyor.`);
    return fallback('invalid-content');
  }

  return {
    text: String(row.content).replace(/\r\n/g, '\n'),
    version: row.version ?? null,
    source: 'db',
    reason: 'db-active',
    updatedAt: row.created_at || null,
  };
}

// ─── Supabase erişimi ─────────────────────────────────────────────────────────

function dbConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  return url && key ? { url, key } : null;
}

async function pgrest(path, { method = 'GET', body = null, prefer = null, timeoutMs = READ_TIMEOUT_MS } = {}) {
  const cfg = dbConfig();
  if (!cfg) throw new Error('Supabase env var eksik');

  const headers = { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` };
  if (body) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;

  const res = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try { message = JSON.parse(text).message || text; } catch { /* düz metin */ }
    throw new Error(`Supabase ${res.status}: ${String(message).slice(0, 200)}`);
  }
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const ACTIVE_SELECT = 'select=version,content,created_at,note,created_by';

function activeRowQuery(key) {
  return `${TABLE}?prompt_key=eq.${encodeURIComponent(key)}&is_active=is.true&${ACTIVE_SELECT}&limit=1`;
}

// ─── Önbellek ─────────────────────────────────────────────────────────────────

const cache = new Map(); // key → { text, version, source, expiresAt }

function invalidatePromptCache(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

function cacheStatus() {
  return [...cache.entries()].map(([key, v]) => ({
    key, source: v.source, version: v.version ?? null, expiresInMs: Math.max(0, v.expiresAt - Date.now()),
  }));
}

// ─── Okuma (AI yolunda kullanılan) ───────────────────────────────────────────

/**
 * Üretimde kullanılacak prompt metnini döndürür. ASLA hata fırlatmaz —
 * her başarısızlık koddaki varsayılana düşer.
 */
async function getPrompt(key) {
  const meta = getPromptMeta(key);
  if (!meta) {
    // Kod hatası (yanlış anahtar sabiti). Üretimi durdurmamak için boş dönmek
    // yerine erken ve gürültülü patlıyoruz; anahtarlar testlerde doğrulanıyor.
    throw new Error(`Bilinmeyen prompt anahtarı: ${key}`);
  }

  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.text;

  if (!dbConfig()) {
    cache.set(key, { text: meta.defaultText, version: null, source: 'default', expiresAt: Date.now() + CACHE_TTL_MS });
    return meta.defaultText;
  }

  try {
    const rows = await pgrest(activeRowQuery(key));
    const resolved = resolveActiveRow(key, rows);
    cache.set(key, {
      text: resolved.text,
      version: resolved.version,
      source: resolved.source,
      expiresAt: Date.now() + (resolved.source === 'db' ? CACHE_TTL_MS : FAIL_CACHE_TTL_MS),
    });
    return resolved.text;
  } catch (err) {
    console.warn(`[Prompt] '${key}' okunamadı (${err.message}) — koddaki varsayılan kullanılıyor.`);
    cache.set(key, { text: meta.defaultText, version: null, source: 'default', expiresAt: Date.now() + FAIL_CACHE_TTL_MS });
    return meta.defaultText;
  }
}

// ─── Panel için okuma ─────────────────────────────────────────────────────────

/**
 * Panelde gösterilecek durum. Kayıtlı sürüm doğrulamadan geçmiyorsa metni yine
 * de döndürür (sahibi düzeltebilsin diye) ama `invalid` işaretiyle: üretimde o
 * sürüm kullanılmıyor.
 */
async function readPromptState(key) {
  const meta = getPromptMeta(key);
  if (!meta) throw new Error(`Bilinmeyen prompt anahtarı: ${key}`);

  const base = {
    key: meta.key,
    label: meta.label,
    description: meta.description,
    minLength: meta.minLength,
    maxLength: meta.maxLength,
    requiredTokens: meta.requiredTokens,
    defaultText: meta.defaultText,
    defaultLength: meta.defaultText.length,
  };

  if (!dbConfig()) {
    return { ...base, source: 'default', content: meta.defaultText, version: null,
             warning: 'Supabase yapılandırılmamış — yalnızca koddaki varsayılan kullanılıyor.' };
  }

  try {
    const rows = await pgrest(activeRowQuery(key));
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || row.content == null) {
      return { ...base, source: 'default', content: meta.defaultText, version: null };
    }
    const check = validatePrompt(key, row.content);
    return {
      ...base,
      source: check.ok ? 'db' : 'default',
      content: String(row.content),
      version: row.version ?? null,
      updatedAt: row.created_at || null,
      note: row.note || null,
      invalid: !check.ok,
      warning: check.ok ? null
        : `Kayıtlı sürüm geçersiz (${check.error}) — üretimde koddaki varsayılan kullanılıyor.`,
    };
  } catch (err) {
    return { ...base, source: 'default', content: meta.defaultText, version: null,
             warning: `Veritabanı okunamadı (${err.message}) — koddaki varsayılan kullanılıyor.` };
  }
}

async function listPromptState() {
  return Promise.all(PROMPT_REGISTRY.map((p) => readPromptState(p.key)));
}

const PREVIEW_CHARS = 240;

async function getHistory(key, limit = MAX_HISTORY) {
  if (!getPromptMeta(key)) throw new Error(`Bilinmeyen prompt anahtarı: ${key}`);
  if (!dbConfig()) return [];
  const safeLimit = Math.min(MAX_HISTORY, Math.max(1, Number(limit) || MAX_HISTORY));
  const rows = await pgrest(
    `${TABLE}?prompt_key=eq.${encodeURIComponent(key)}&select=version,note,created_at,created_by,is_active,content` +
    `&order=version.desc&limit=${safeLimit}`
  );
  if (!Array.isArray(rows)) return [];
  // Tam metin ayrı uçtan çekiliyor; liste sadece önizleme taşısın.
  return rows.map((r) => ({
    version: r.version,
    note: r.note || null,
    createdAt: r.created_at,
    createdBy: r.created_by || null,
    isActive: !!r.is_active,
    length: typeof r.content === 'string' ? r.content.length : 0,
    preview: typeof r.content === 'string' ? r.content.slice(0, PREVIEW_CHARS) : '',
  }));
}

async function getVersionContent(key, version) {
  if (!getPromptMeta(key)) throw new Error(`Bilinmeyen prompt anahtarı: ${key}`);
  const v = Number(version);
  if (!Number.isInteger(v) || v < 1) throw new Error('Geçersiz sürüm numarası');
  if (!dbConfig()) throw new Error('Supabase yapılandırılmamış');
  const rows = await pgrest(
    `${TABLE}?prompt_key=eq.${encodeURIComponent(key)}&version=eq.${v}&select=version,content,note,created_at&limit=1`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new Error(`v${v} bulunamadı`);
  return { version: row.version, content: String(row.content ?? ''), note: row.note || null, createdAt: row.created_at };
}

// ─── Yazma ────────────────────────────────────────────────────────────────────

function validationError(message) {
  const err = new Error(message);
  err.validation = true;
  return err;
}

/**
 * Yeni sürüm kaydeder. Geçmiş append-only: eski satırlar silinmez, sadece
 * is_active bayrağı taşınır — böylece her düzenleme geri alınabilir.
 */
async function savePrompt(key, content, { note = null, createdBy = 'dashboard' } = {}) {
  const meta = getPromptMeta(key);
  if (!meta) throw validationError('Bilinmeyen prompt anahtarı');

  const normalized = typeof content === 'string' ? content.replace(/\r\n/g, '\n') : content;
  const check = validatePrompt(key, normalized);
  if (!check.ok) throw validationError(check.error);

  if (!dbConfig()) throw new Error('Supabase yapılandırılmamış — prompt kaydedilemiyor');

  const latest = await pgrest(
    `${TABLE}?prompt_key=eq.${encodeURIComponent(key)}&select=version&order=version.desc&limit=1`
  );
  const nextVersion = (Array.isArray(latest) && latest[0]?.version ? Number(latest[0].version) : 0) + 1;

  // Kısmi unique index anahtar başına tek aktif satıra izin veriyor; önce eskiyi
  // pasifleştiriyoruz. Araya giren bir hata olursa hiçbir satır aktif kalmaz →
  // üretim koddaki varsayılana düşer, yani bozuk değil sadece güncellenmemiş olur.
  await pgrest(`${TABLE}?prompt_key=eq.${encodeURIComponent(key)}&is_active=is.true`, {
    method: 'PATCH',
    body: { is_active: false },
    prefer: 'return=minimal',
    timeoutMs: WRITE_TIMEOUT_MS,
  });

  const inserted = await pgrest(TABLE, {
    method: 'POST',
    prefer: 'return=representation',
    timeoutMs: WRITE_TIMEOUT_MS,
    body: {
      prompt_key: key,
      version: nextVersion,
      content: normalized,
      note: note ? String(note).slice(0, 200) : null,
      created_by: createdBy,
      is_active: true,
    },
  });

  invalidatePromptCache(key);
  const row = Array.isArray(inserted) ? inserted[0] : null;
  return { key, version: nextVersion, createdAt: row?.created_at || null };
}

/**
 * Eski bir sürümü yeniden aktif eder. Satır taşımak yerine içeriği YENİ bir
 * sürüm olarak yazıyoruz — geçmiş böylece doğrusal kalıyor ve geri alma da
 * geri alınabiliyor.
 */
async function revertPrompt(key, version) {
  const target = await getVersionContent(key, version);
  const check = validatePrompt(key, target.content);
  if (!check.ok) throw validationError(`v${target.version} bugünkü kurallardan geçmiyor: ${check.error}`);
  return savePrompt(key, target.content, { note: `v${target.version} geri alındı` });
}

/**
 * Koddaki varsayılana döner: tüm sürümler pasifleştirilir, satırlar korunur.
 * Aktif satır kalmadığı için getPrompt() prompt-defaults.js'i kullanır.
 */
async function resetPrompt(key) {
  if (!getPromptMeta(key)) throw validationError('Bilinmeyen prompt anahtarı');
  if (!dbConfig()) throw new Error('Supabase yapılandırılmamış');
  await pgrest(`${TABLE}?prompt_key=eq.${encodeURIComponent(key)}&is_active=is.true`, {
    method: 'PATCH',
    body: { is_active: false },
    prefer: 'return=minimal',
    timeoutMs: WRITE_TIMEOUT_MS,
  });
  invalidatePromptCache(key);
  return { key, source: 'default' };
}

module.exports = {
  getPrompt,
  validatePrompt,
  resolveActiveRow,
  readPromptState,
  listPromptState,
  listPromptMeta,
  getPromptMeta,
  getHistory,
  getVersionContent,
  savePrompt,
  revertPrompt,
  resetPrompt,
  invalidatePromptCache,
  cacheStatus,
  PROMPT_KEYS: PROMPT_REGISTRY.map((p) => p.key),
};
