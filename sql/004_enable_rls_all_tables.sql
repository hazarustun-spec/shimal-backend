-- Row Level Security — tüm tablolar için defense-in-depth
-- ARCH-2: SUPABASE_SERVICE_KEY sızsa bile RLS politika kontrolü devreye girer
--
-- Backend service role kullanıyor (bypass_rls özelliği var), bu yüzden normal
-- çalışma etkilenmez. Ama eğer service key değil anon key kullanılırsa (yanlışlıkla
-- veya sızma sonrası) RLS hiçbir satıra erişim vermez.
--
-- Bu migration idempotent — birden fazla çalıştırmak güvenli.

-- ─── users ───────────────────────────────────────────────────────────────────
ALTER TABLE users ENABLE ROW LEVEL SECURITY;

-- Mevcut politikaları temizle (idempotency için)
DROP POLICY IF EXISTS "users_service_role_only" ON users;
DROP POLICY IF EXISTS "users_deny_anon" ON users;

-- Service role (backend) tüm işlemleri yapabilir
CREATE POLICY "users_service_role_only" ON users
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Anon ve authenticated role'ler için HİÇBİR erişim yok
-- (CREATE POLICY olmadan ENABLE RLS = default deny)

-- ─── daily_insights ──────────────────────────────────────────────────────────
ALTER TABLE daily_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "daily_insights_service_role_only" ON daily_insights;
CREATE POLICY "daily_insights_service_role_only" ON daily_insights
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── feedback ────────────────────────────────────────────────────────────────
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "feedback_service_role_only" ON feedback;
CREATE POLICY "feedback_service_role_only" ON feedback
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ─── crash_reports ───────────────────────────────────────────────────────────
-- Tablo varsa RLS enable et
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'crash_reports') THEN
    ALTER TABLE crash_reports ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "crash_reports_service_role_only" ON crash_reports;
    CREATE POLICY "crash_reports_service_role_only" ON crash_reports
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ─── failed_insights ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'failed_insights') THEN
    ALTER TABLE failed_insights ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "failed_insights_service_role_only" ON failed_insights;
    CREATE POLICY "failed_insights_service_role_only" ON failed_insights
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ─── otp_lockouts ────────────────────────────────────────────────────────────
-- Zaten 001 migration'da RLS aktif edilmişti, policy eksikse ekle
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'otp_lockouts') THEN
    ALTER TABLE otp_lockouts ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "otp_lockouts_service_role_only" ON otp_lockouts;
    CREATE POLICY "otp_lockouts_service_role_only" ON otp_lockouts
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ─── cron_locks ──────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'cron_locks') THEN
    ALTER TABLE cron_locks ENABLE ROW LEVEL SECURITY;
    DROP POLICY IF EXISTS "cron_locks_service_role_only" ON cron_locks;
    CREATE POLICY "cron_locks_service_role_only" ON cron_locks
      FOR ALL
      TO service_role
      USING (true)
      WITH CHECK (true);
  END IF;
END $$;

-- ─── Doğrulama sorgusu ───────────────────────────────────────────────────────
-- Migration sonrası bu query'yi çalıştırıp tüm tabloların RLS'li olduğunu doğrula:
--
--   SELECT tablename, rowsecurity
--   FROM pg_tables
--   WHERE schemaname = 'public'
--   ORDER BY tablename;
--
-- Hepsinin rowsecurity = true olması gerekir.
