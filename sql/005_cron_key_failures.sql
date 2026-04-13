-- Cron key brute-force lockout persistence
-- ARCH-3: Restart sonrası lockout state'i korunur
--
-- İzlenen: CRON_API_KEY'e yapılan başarısız denemeler (per-IP)
-- 5 hata → 30 dk kilit (backend/src/utils/http.js checkCronKey)

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

DROP POLICY IF EXISTS "cron_key_failures_service_role_only" ON cron_key_failures;
CREATE POLICY "cron_key_failures_service_role_only" ON cron_key_failures
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
