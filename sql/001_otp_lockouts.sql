-- OTP brute-force lockout persistence
-- HIGH-6 fix: Rate limit state'i restart'larda korunur
--
-- Bu tabloyu Supabase SQL Editor'da bir kez çalıştır.
-- Tablo yoksa backend in-memory mode'da çalışmaya devam eder (graceful degradation).

CREATE TABLE IF NOT EXISTS otp_lockouts (
  identifier   TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  lockouts     INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Süresi geçmiş kilitleri temizlemek için index
CREATE INDEX IF NOT EXISTS idx_otp_lockouts_locked_until
  ON otp_lockouts(locked_until)
  WHERE locked_until IS NOT NULL;

-- RLS: sadece service role yazabilir/okuyabilir (anon hiçbir şey yapamaz)
ALTER TABLE otp_lockouts ENABLE ROW LEVEL SECURITY;

-- Otomatik temizlik: 30 gündür güncellenmemiş ve aktif kilit olmayan kayıtları sil
-- (opsiyonel, cron ile çalıştırılabilir)
-- DELETE FROM otp_lockouts
-- WHERE updated_at < NOW() - INTERVAL '30 days'
--   AND (locked_until IS NULL OR locked_until < EXTRACT(EPOCH FROM NOW()) * 1000);
