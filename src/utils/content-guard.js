'use strict';

// Kullanıcıdan gelen serbest metni AI prompt'una koymadan önce denetler.
// `sanitizeForAI` isimler gibi kısa alanları temizler; bu modül ise metni
// olduğu gibi geçirmeden ÖNCE reddedip reddetmeyeceğimize karar verir.

const MAX_LEN = 500;

// Prompt injection kalıpları. İngilizce + Türkçe karşılıkları.
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\b[\s\S]{0,20}\b(previous|prior|above|all|your)?\b[\s\S]{0,20}\b(instruction|instructions|prompt|prompts|rule|rules)\b/i,
  /\b(act|behave|respond)\s+as\b[\s\S]{0,20}\b(a|an|another|different)?\b[\s\S]{0,20}\b(ai|assistant|model|bot|system|developer|admin)\b/i,
  /\b(you\s+are\s+now|from\s+now\s+on|pretend\s+to\s+be|roleplay\s+as)\b/i,
  /\b(system|developer)\s*(prompt|message|instruction)\b/i,
  /\b(reveal|show|print|repeat|output)\b[\s\S]{0,20}\b(your|the)\b[\s\S]{0,20}\b(prompt|instruction|instructions|system)\b/i,
  /\b(jailbreak|dan\s+mode|bypass\s+(your\s+)?(filter|restriction|guardrail))/i,
  // Türkçe
  /\b(önceki|yukarıdaki|tüm)\s+(talimat|kural|komut)/i,
  /\btalimatlar[ıi]n[ıi]\s+(unut|yok\s*say|görmezden)/i,
  /\b(bundan\s+sonra|artık)\s+sen\b/i,
  /\bsistem\s+(prompt|mesaj|talimat)/i,
];

// Rol/kanal taklidi — chat formatını taklit edip mesaj sınırını kırma girişimi.
const ROLE_MARKER_RE = /^\s*(system|assistant|user|human)\s*:/im;

/**
 * Serbest metni AI'ya göndermeden önce denetler.
 * @param {string} text
 * @param {number} [maxLen=500]
 * @returns {{safe: boolean, reason: string|null}}
 */
function checkContent(text, maxLen = MAX_LEN) {
  if (typeof text !== 'string' || text.length === 0) {
    return { safe: false, reason: 'empty' };
  }
  if (text.length > maxLen) {
    return { safe: false, reason: 'too_long' };
  }
  // Control karakterler (satır sonu hariç) — görünmez payload taşıma girişimi.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) {
    return { safe: false, reason: 'control_chars' };
  }
  if (ROLE_MARKER_RE.test(text)) {
    return { safe: false, reason: 'role_marker' };
  }
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) {
      return { safe: false, reason: 'injection' };
    }
  }
  return { safe: true, reason: null };
}

module.exports = { checkContent, MAX_LEN };
