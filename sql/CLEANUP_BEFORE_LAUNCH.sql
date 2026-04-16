-- ============================================================
-- SHIMAL — App Store Öncesi Temizlik
-- Supabase SQL Editor'da çalıştır
-- ============================================================

-- ─── 1. TÜM TEST VERİSİNİ TEMİZLE ──────────────────────────
-- Önce var olan tabloları tespit edip sadece onları temizler.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'daily_insights', 'feedback', 'failed_insights',
      'otp_lockouts', 'cron_locks', 'cron_key_failures',
      'cron_runs', 'error_logs', 'revenue_events',
      'crash_reports', 'users'
    ])
  LOOP
    IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('TRUNCATE TABLE public.%I CASCADE', t);
      RAISE NOTICE 'Truncated: %', t;
    ELSE
      RAISE NOTICE 'Skipped (not found): %', t;
    END IF;
  END LOOP;
END $$;

-- ─── 2. MEVCUT TABLOLAR ────────────────────────────────────
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

-- ─── 3. PUBLIC FONKSİYONLAR ────────────────────────────────
SELECT p.proname AS function_name, pg_get_function_arguments(p.oid) AS arguments
FROM pg_proc p JOIN pg_namespace n ON p.pronamespace = n.oid
WHERE n.nspname = 'public' ORDER BY p.proname;

-- ─── 4. TRIGGER'LAR ────────────────────────────────────────
SELECT trigger_name, event_object_table, action_timing, event_manipulation
FROM information_schema.triggers WHERE trigger_schema = 'public'
ORDER BY event_object_table;

-- ─── 5. EXTENSION'LAR ──────────────────────────────────────
SELECT extname, extversion FROM pg_extension ORDER BY extname;
