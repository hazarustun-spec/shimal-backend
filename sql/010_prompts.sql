-- 010_prompts.sql
--
-- AI prompt'larının sürümlenmiş kaydı.
--
-- Prompt metinleri bugüne kadar yalnızca kodda (src/services/prompt-defaults.js)
-- duruyordu; bir cümleyi değiştirmek deploy gerektiriyordu. Bu tablo, panelden
-- (dashboard → Prompt'lar) yapılan düzenlemeleri saklar.
--
-- SÜRÜMLEME: Tablo append-only. Her kaydetme prompt_key için version = max+1
-- olan YENİ bir satır yazar; eski satır silinmez, sadece is_active bayrağı
-- taşınır. Böylece her düzenleme geri alınabilir ve kimin ne zaman ne yazdığı
-- kayıtta kalır. "Geri al" da eski içeriği yeni bir sürüm olarak yazar.
--
-- VARSAYILANA DÖNÜŞ: Anahtarın tüm satırları is_active = false yapılır. Aktif
-- satır bulunmadığında backend koddaki varsayılanı kullanır — yani tablo boş
-- olsa da, hiç çalıştırılmasa da uygulama çalışmaya devam eder. Bu migration
-- opsiyoneldir: çalıştırılmazsa panel "kaydedilemiyor" der, üretim etkilenmez.

CREATE TABLE IF NOT EXISTS ai_prompts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_key  TEXT    NOT NULL,          -- 'daily_system', 'personality_rules', ...
  version     INTEGER NOT NULL,          -- anahtar başına 1'den artan
  content     TEXT    NOT NULL,
  note        TEXT,                      -- düzenleme notu ("ton yumuşatıldı" gibi)
  created_by  TEXT    DEFAULT 'dashboard',
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (prompt_key, version)
);

-- Anahtar başına en fazla tek aktif sürüm. Uygulama önce eskiyi pasifleştirip
-- sonra yeni satırı yazıyor; bu index o sıranın bozulmasına izin vermiyor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_prompts_active
  ON ai_prompts(prompt_key)
  WHERE is_active;

-- Sürüm geçmişi listesi ve sonraki sürüm numarası için
CREATE INDEX IF NOT EXISTS idx_ai_prompts_key_version
  ON ai_prompts(prompt_key, version DESC);

ALTER TABLE ai_prompts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ai_prompts_service_role_only" ON ai_prompts;
CREATE POLICY "ai_prompts_service_role_only" ON ai_prompts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
