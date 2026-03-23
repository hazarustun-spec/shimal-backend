'use strict';

// ─── Patterns ─────────────────────────────────────────────────────────────────

const DEVICE_ID_RE = /^[A-Fa-f0-9-]{8,64}$/;
const BIRTH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BIRTH_TIME_RE = /^\d{2}:\d{2}$/;
const PHONE_RE = /^\+?\d{7,15}$/;
const OTP_RE = /^\d{4,8}$/;

// ─── Validators ───────────────────────────────────────────────────────────────

function isValidDeviceId(v) {
  return typeof v === 'string' && DEVICE_ID_RE.test(v);
}

function isValidBirthDate(v) {
  if (typeof v !== 'string' || !BIRTH_DATE_RE.test(v)) return false;
  const d = new Date(v + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  const year = d.getUTCFullYear();
  return year >= 1900 && d <= new Date();
}

function isValidBirthTime(v) {
  if (typeof v !== 'string' || !BIRTH_TIME_RE.test(v)) return false;
  const [h, m] = v.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function isValidPhone(v) {
  return typeof v === 'string' && PHONE_RE.test(v);
}

function isValidOtp(v) {
  return typeof v === 'string' && OTP_RE.test(v);
}

function isValidText(v, maxLen = 500) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

/**
 * Sanitize a name/text field before sending to AI prompt.
 * Strips anything that looks like an instruction or injection attempt.
 */
function sanitizeForAI(text, maxLen = 50) {
  if (!text || typeof text !== 'string') return '';
  // Remove control chars, newlines, tabs
  let clean = text.replace(/[\x00-\x1f\x7f]/g, '');
  // Remove anything that looks like prompt injection keywords
  clean = clean.replace(/\b(ignore|forget|system|prompt|instruction|override|bypass|reveal|act as|pretend|you are)\b/gi, '');
  // Only allow letters, numbers, spaces, common Turkish chars, hyphens
  clean = clean.replace(/[^a-zA-ZçÇğĞıİöÖşŞüÜ0-9\s\-']/g, '');
  // Collapse multiple spaces
  clean = clean.replace(/\s+/g, ' ').trim();
  // Enforce max length
  return clean.substring(0, maxLen);
}

module.exports = {
  isValidDeviceId,
  isValidBirthDate,
  isValidBirthTime,
  isValidPhone,
  isValidOtp,
  isValidText,
  sanitizeForAI,
};
