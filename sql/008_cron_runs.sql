-- Cron job run history for dashboard monitoring
-- Tracks each cron execution: when it ran, how long, how many users processed/failed

CREATE TABLE IF NOT EXISTS cron_runs (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_name        TEXT NOT NULL,           -- 'daily-gen', 'retry-gen', 'push-cron', 'midnight-reset'
  started_at      TIMESTAMPTZ NOT NULL,
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',  -- 'running', 'success', 'error'
  users_processed INTEGER DEFAULT 0,
  users_failed    INTEGER DEFAULT 0,
  duration_ms     INTEGER,
  error_message   TEXT,
  metadata        JSONB                    -- extra context (e.g. generated/skipped counts)
);

CREATE INDEX IF NOT EXISTS idx_cron_runs_job_started ON cron_runs(job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_runs_status ON cron_runs(status) WHERE status != 'success';

ALTER TABLE cron_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "cron_runs_service_role_only" ON cron_runs;
CREATE POLICY "cron_runs_service_role_only" ON cron_runs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
