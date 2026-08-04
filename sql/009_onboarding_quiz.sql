-- 009_onboarding_quiz.sql
--
-- İlk açılıştaki "Seni tanıyalım" anketinin cevaplarını saklar.
--
-- Bu anket (LoyaltyFlowView) dört soru soruyor ve cevapları hiçbir yere
-- yazmıyordu; yalnızca akışı uzatıp arka planda içgörü üretimine zaman
-- kazandırmak için vardı. Oysa sorduğu şeylerin hepsi doğum haritasından
-- TÜRETİLEMEYEN bilgiler — yani günlük yorumu kişiselleştirmek için elimizdeki
-- en değerli sinyaller. Aynı burçtan iki kullanıcının birbirine benzeyen
-- yorumlar almasının sebeplerinden biri buydu.
--
-- Anket kayıttan SONRA, ana ekranda gösteriliyor. O yüzden değerler register
-- payload'ında değil, ayrı bir PUT /api/user/quiz çağrısıyla geliyor.
--
-- Hepsi nullable: anketi görmemiş mevcut kullanıcılar ve akışı yarıda bırakan
-- kullanıcılar için NULL kalır, prompt tarafı bunu tolere eder.

alter table public.users
  -- "Bugünlerde hangisi zihnini daha çok meşgul ediyor?"
  -- love | career | health | self
  add column if not exists quiz_focus text,

  -- "Astrolojiyle aran nasıl?" → yorumun terim yoğunluğunu belirler
  -- beginner | casual | advanced
  add column if not exists quiz_astrology_level text,

  -- "Doğum saatini ne kadar kesin biliyorsun?"
  -- Yükselen ve ev yerleşimlerine ne kadar güvenerek yorum yapılacağını belirler.
  -- exact | approximate | unsure
  add column if not exists quiz_birth_time_accuracy text,

  -- "Günlük yorumunu genelde ne zaman okumak istersin?"
  -- morning | midday | evening
  add column if not exists quiz_reading_time text,

  -- YENİ: "Zor bir gün geçirdiğinde en çok ne işine yarar?"
  -- Yorumun TONUNU belirler — aynı transit, farklı anlatım.
  -- advice | validation | understanding | space
  add column if not exists quiz_support_style text,

  -- YENİ: "Şu an hayatında hangisi daha doğru?"
  -- Yorumun ÇERÇEVESİNİ belirler. Doğum haritasından türetilemez ve zamanla
  -- değişir; başlangıç ile bitiriş dönemindeki iki kişiye aynı metni yazmamak
  -- için en güçlü ayırt edici.
  -- starting | sustaining | ending | searching
  add column if not exists quiz_life_phase text,

  -- Anketin ne zaman tamamlandığı. Cevaplar eskidikçe (özellikle life_phase)
  -- yeniden sorulabilsin diye tutuluyor.
  add column if not exists quiz_completed_at timestamptz;

comment on column public.users.quiz_focus is
  'Onboarding anketi: kullanıcının şu anki odak alanı (love|career|health|self)';
comment on column public.users.quiz_life_phase is
  'Onboarding anketi: hayat evresi (starting|sustaining|ending|searching) — zamanla değişir';
