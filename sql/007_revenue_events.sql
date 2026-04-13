-- RevenueCat webhook event storage for dashboard revenue tracking

CREATE TABLE IF NOT EXISTS revenue_events (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type      TEXT NOT NULL,          -- INITIAL_PURCHASE, RENEWAL, CANCELLATION, etc.
  user_id         UUID,                   -- FK to users.id (nullable for unknown users)
  rc_customer_id  TEXT,                   -- RevenueCat app_user_id
  product_id      TEXT,                   -- e.g. "shimal_premium_monthly"
  amount_usd      NUMERIC(10,2),          -- revenue in USD (after Apple's cut)
  currency        TEXT DEFAULT 'USD',
  is_trial        BOOLEAN DEFAULT FALSE,
  period_type     TEXT,                   -- TRIAL, NORMAL, INTRO
  environment     TEXT DEFAULT 'PRODUCTION',  -- PRODUCTION or SANDBOX
  event_at        TIMESTAMPTZ NOT NULL,   -- when the event occurred
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_payload     JSONB                   -- full webhook payload for debugging
);

CREATE INDEX IF NOT EXISTS idx_revenue_events_event_at ON revenue_events(event_at DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_events_user_id ON revenue_events(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_revenue_events_type ON revenue_events(event_type);

ALTER TABLE revenue_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "revenue_events_service_role_only" ON revenue_events;
CREATE POLICY "revenue_events_service_role_only" ON revenue_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);
