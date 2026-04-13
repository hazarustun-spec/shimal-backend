-- Tüm migration'ları tek seferde çalıştırmak için bu dosyayı Supabase SQL Editor'a yapıştır.
-- Idempotent — birden fazla kez çalıştırmak güvenli.
--
-- Sırayla:
--   001_otp_lockouts     → OTP brute-force lockout persistence
--   002_cron_locks       → Distributed cron job lock
--   003_session_tokens   → Proper rotatable session tokens
--   004_enable_rls       → Row Level Security tüm tablolar
--   005_cron_key_failures → Cron key brute-force lockout persistence
--   006_error_logs        → Dashboard persistent error log
--   007_revenue_events    → RevenueCat webhook event storage
--   008_cron_runs         → Cron job run history for dashboard monitoring

-- ═════════════════════════════════════════════════════════════════════════════
-- 001 — OTP LOCKOUTS
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS otp_lockouts (
  identifier   TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  lockouts     INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_lockouts_locked_until
  ON otp_lockouts(locked_until)
  WHERE locked_until IS NOT NULL;
ALTER TABLE otp_lockouts ENABLE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- 002 — CRON LOCKS
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cron_locks (
  job_name     TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL,
  instance_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cron_locks_locked_until
  ON cron_locks(locked_until);
ALTER TABLE cron_locks ENABLE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- 003 — SESSION TOKENS (users tablosuna kolon ekle)
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS session_token_rotated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_session_token_hash
  ON users(session_token_hash)
  WHERE session_token_hash IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 005 — CRON KEY FAILURES
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cron_key_failures (
  ip           TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  locked_until BIGINT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_cron_key_failures_locked_until
  ON cron_key_failures(locked_until)
  WHERE locked_until IS NOT NULL;
ALTER TABLE cron_key_failures ENABLE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- 006 — ERROR LOGS (dashboard persistent error log)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS error_logs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source     TEXT NOT NULL,
  message    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at
  ON error_logs(created_at DESC);
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- 007 — REVENUE EVENTS (RevenueCat webhook)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS revenue_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      TEXT NOT NULL,
  user_id         UUID,
  rc_customer_id  TEXT,
  product_id      TEXT,
  amount_usd      NUMERIC(10,2),
  currency        TEXT DEFAULT 'USD',
  is_trial        BOOLEAN DEFAULT FALSE,
  period_type     TEXT,
  environment     TEXT DEFAULT 'PRODUCTION',
  event_at        TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload     JSONB
);
CREATE INDEX IF NOT EXISTS idx_revenue_events_event_at ON revenue_events(event_at DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_events_user_id ON revenue_events(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_events_type ON revenue_events(event_type);
ALTER TABLE revenue_events ENABLE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- 008 — CRON RUNS (cron job monitoring)
-- ═════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cron_runs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name        TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',
  users_processed INTEGER DEFAULT 0,
  users_failed    INTEGER DEFAULT 0,
  duration_ms     INTEGER,
  error_message   TEXT,
  metadata        JSONB
);
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(status) WHERE status != 'success';
ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;

-- ═════════════════════════════════════════════════════════════════════════════
-- 004 — ROW LEVEL SECURITY (tüm tablolar) — EN SON ÇALIŞTIR
-- ═════════════════════════════════════════════════════════════════════════════

-- users
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "users_service_role_only" ON users;
CREATE POLICY "users_service_role_only" ON users
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- daily_insights
ALTER TABLE daily_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "daily_insights_service_role_only" ON daily_insights;
CREATE POLICY "daily_insights_service_role_only" ON daily_insights
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- feedback
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "feedback_service_role_only" ON feedback;
CREATE POLICY "feedback_service_role_only" ON feedback
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- otp_lockouts (003'te ENABLE edildi, policy eksikse ekle)
DROP POLICY IF EXISTS "otp_lockouts_service_role_only" ON otp_lockouts;
CREATE POLICY "otp_lockouts_service_role_only" ON otp_lockouts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cron_locks
DROP POLICY IF EXISTS "cron_locks_service_role_only" ON cron_locks;
CREATE POLICY "cron_locks_service_role_only" ON cron_locks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cron_key_failures
DROP POLICY IF EXISTS "cron_key_failures_service_role_only" ON cron_key_failures;
CREATE POLICY "cron_key_failures_service_role_only" ON cron_key_failures
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- error_logs
DROP POLICY IF EXISTS "error_logs_service_role_only" ON error_logs;
CREATE POLICY "error_logs_service_role_only" ON error_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- revenue_events
DROP POLICY IF EXISTS "revenue_events_service_role_only" ON revenue_events;
CREATE POLICY "revenue_events_service_role_only" ON revenue_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- cron_runs
DROP POLICY IF EXISTS "cron_runs_service_role_only" ON cron_runs;
CREATE POLICY "cron_runs_service_role_only" ON cron_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- crash_reports (varsa)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'crash_reports') THEN
    ALTER TABLE crash_reports ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "crash_reports_service_role_only" ON crash_reports;
    CREATE POLICY "crash_reports_service_role_only" ON crash_reports
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- failed_insights (varsa)
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'failed_insights') THEN
    ALTER TABLE failed_insights ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "failed_insights_service_role_only" ON failed_insights;
    CREATE POLICY "failed_insights_service_role_only" ON failed_insights
      FOR ALL TO service_role USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- DOĞRULAMA
-- ═════════════════════════════════════════════════════════════════════════════
-- Migration sonrası şunu çalıştırıp sonucu kontrol et:
--
--   SELECT tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'public' ORDER BY tablename;
--
-- Tüm tabloların rowsecurity = true olması gerekir.
