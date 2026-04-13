-- Proper rotatable session tokens
-- ARCH-1: HMAC-based stateless token'ları DB-stored random token'larla değiştir
--
-- Bu tabloyu Supabase SQL Editor'da bir kez çalıştır.
-- Migration backward-compatible: kolon NULL ise eski HMAC token fallback devreye girer.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS session_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS session_token_rotated_at TIMESTAMPTZ;

-- Hızlı lookup için index (device_id zaten PK/unique olduğu için ayrı index gerek yok,
-- ama hash alanının null olmayan kayıtlarını bulmak için partial index eklenebilir)
CREATE INDEX IF NOT EXISTS idx_users_session_token_hash
  ON users(session_token_hash)
  WHERE session_token_hash IS NOT NULL;
