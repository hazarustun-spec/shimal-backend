-- Persistent error log for dashboard
-- In-memory buffer kayboluyordu restart'larda, artık Supabase'de tutuluyor.
-- Dashboard GET /dashboard/stats bu tabloyu okuyarak son hataları gösterir.

CREATE TABLE IF NOT EXISTS error_logs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source     TEXT NOT NULL,
  message    TEXT NOT NULL
);

-- Son hataları hızlı çekmek için
CREATE INDEX IF NOT EXISTS idx_error_logs_created_at
  ON error_logs(created_at DESC);

-- 30 günden eski logları otomatik temizle (opsiyonel cron ile)
-- DELETE FROM error_logs WHERE created_at < NOW() - INTERVAL '30 days';

ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "error_logs_service_role_only" ON error_logs;
CREATE POLICY "error_logs_service_role_only" ON error_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
