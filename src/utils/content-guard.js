'use strict';

/**
 * Content moderation for user-submitted text (Shimal'e Sor questions).
 * Blocks profanity, prompt injection attempts, and off-topic abuse.
 *
 * Defenses:
 *  - Unicode normalization (NFC) to prevent char-variant bypasses
 *  - Whitespace collapsing (tabs, newlines, multi-space)
 *  - Zero-width character stripping
 *  - Leetspeak deobfuscation
 *  - Turkish diacritic normalization
 */

// ─── Pre-processing ──────────────────────────────────────────────────────────

/** Strip zero-width chars, control chars, collapse whitespace */
function normalize(text) {
  return text
    // Unicode NFC normalization
    .normalize('NFC')
    // Remove zero-width spaces, joiners, soft hyphens, etc.
    .replace(/[\u200B-\u200F\u2028-\u202F\u2060\uFEFF\u00AD]/g, '')
    // Remove all control chars except newline/tab
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    // Collapse all whitespace (spaces, tabs, newlines) to single space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Convert common leetspeak substitutions to letters */
function deobfuscate(text) {
  const map = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's',
    '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i',
  };
  return text.replace(/[013457@$!]/g, c => map[c] || c);
}

/** Normalize Turkish diacritics to ASCII equivalents for pattern matching */
function normalizeTurkish(text) {
  const map = { 'ı': 'i', 'İ': 'I', 'ğ': 'g', 'Ğ': 'G', 'ü': 'u', 'Ü': 'U', 'ş': 's', 'Ş': 'S', 'ö': 'o', 'Ö': 'O', 'ç': 'c', 'Ç': 'C' };
  return text.replace(/[ıİğĞüÜşŞöÖçÇ]/g, c => map[c] || c);
}

// ─── Blocked Patterns ─────────────────────────────────────────────────────────

const BLOCKED_PATTERNS = [
  // Turkish profanity (checked against normalized text)
  /\b(sik|amk|orospu|pic|yarrak|got\s*ver|anan|siktir|amcik|pezevenk)\b/i,
  /\b(sikerim|sikeyim|siktir|bok|gerizekal[iı]|salak|aptal|mal)\b/i,
  // English profanity
  /\b(fuck|shit|bitch|asshole|dick|cunt|nigger|faggot)\b/i,
  // Prompt injection — broad patterns (.*? allows words between key terms)
  /ignore.{0,30}(instructions|rules|prompts|guidelines)/i,
  /forget.{0,30}(instructions|rules|context|guidelines)/i,
  /disregard.{0,30}(instructions|rules|prompts)/i,
  /override.{0,30}(instructions|rules|behavior|safety)/i,
  /you\s+are\s+now\s+a/i,
  /from\s+now\s+on\s+you\s+are/i,
  /act\s+as\s+(a|an)\s+(?!astrol)/i,
  /pretend\s+(you|to)\s+(are|be)\s+(not|no longer)/i,
  /system\s*prompt/i,
  /\bDAN\b/,
  /jailbreak/i,
  /bypass\s+(your|the|all)\s+(rules|filters|restrictions|safety)/i,
  /reveal.{0,20}(system|initial|original|hidden).{0,15}(prompt|instructions|rules)/i,
  /what.{0,10}your.{0,15}(system|initial|original).{0,10}(prompt|instructions)/i,
  /show.{0,15}(system|initial|original).{0,10}(prompt|instructions)/i,
  /repeat.{0,15}(system|initial).{0,10}(prompt|instructions)/i,
  /output.{0,15}(system|initial).{0,10}(prompt|instructions)/i,
  /print.{0,15}(system|initial).{0,10}(prompt|instructions)/i,
  // Code / technical injection
  /\b(eval|exec|import|require|fetch|XMLHttpRequest|document\.|window\.)\b/i,
  /[<>{}[\]\\`]/,  // HTML/code chars in astrology question = suspicious
  // Harmful intent
  /how\s+to\s+(hack|exploit|attack|steal|kill|bomb|poison|suicide)/i,
  /nasil\s+(hack|saldir|oldur|patlat|zehirle|intihar)/i,
  /\b(bomb|weapon|drug|cocaine|heroin)\b/i,
];

// Max question length
const MAX_QUESTION_LENGTH = 500;

/**
 * Checks user input for blocked content.
 * @param {string} text - The user's question/input
 * @returns {{ safe: boolean, reason?: string }}
 */
function checkContent(text) {
  if (!text || typeof text !== 'string') {
    return { safe: true };
  }

  if (text.length > MAX_QUESTION_LENGTH) {
    return { safe: false, reason: 'Soru çok uzun. Lütfen daha kısa bir soru yazın.' };
  }

  // Pre-process: normalize, deobfuscate, then check patterns
  const cleaned = normalize(text);
  const deobfuscated = deobfuscate(cleaned);
  const turkishNorm = normalizeTurkish(deobfuscated);

  // Check all three variants against patterns
  const variants = [cleaned, deobfuscated, turkishNorm];

  for (const variant of variants) {
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(variant)) {
        return {
          safe: false,
          reason: 'Bu içerik uygunsuz bulundu. Lütfen astroloji ile ilgili bir soru sorun.'
        };
      }
    }
  }

  return { safe: true };
}

module.exports = { checkContent };
