-- Distributed cron lock table
-- LOW-2 fix: Çoklu Railway instance'ında cron job'ların duplicate çalışmasını engeller
--
-- Bu tabloyu Supabase SQL Editor'da bir kez çalıştır.
-- Tablo yoksa backend fail-open mode'da çalışmaya devam eder (tek instance için sorun yok).

CREATE TABLE IF NOT EXISTS cron_locks (
  job_name     TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL,
  instance_id  TEXT NOT NULL
);

-- Süresi dolmuş kilitleri hızlı silmek için index
CREATE INDEX IF NOT EXISTS idx_cron_locks_locked_until
  ON cron_locks(locked_until);

-- RLS: sadece service role erişebilir
ALTER TABLE cron_locks ENABLE ROW LEVEL SECURITY;
