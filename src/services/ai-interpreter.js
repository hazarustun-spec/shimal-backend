const { toTR } = require('../utils/zodiac-tr');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// gemini-2.5-flash ve -flash-lite yeni API key'lerine kapatıldı ("no longer
// available to new users" → 404).
//
// Model seçimi ölçümle yapıldı (aynı günlük içgörü prompt'u, 3291 token girdi):
//
//   model                  düşünme  cevap  süre    maliyet/içgörü
//   gemini-3.6-flash          2737   1693  23.0s   $0.0382
//   gemini-3-flash-preview    1531   1812  20.5s   $0.0071
//   gemini-3.1-flash-lite        0   1901  10.0s   $0.0037  ← seçilen
//   gemini-3.5-flash-lite        0   1948   9.1s   $0.0059
//
// "flash" modelleri düşünmeyi KAPATMAYA İZİN VERMİYOR (aşağıdaki nota bak) ve
// düşünme token'ları çıktı olarak faturalanıyor → 10 kat maliyet. Lite modeller
// zaten düşünmüyor. Kalite karşılaştırmasında lite, transit/natal verisini daha
// somut kullandığı için ayrıca geri adım değil.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite';

// Lite modellerde düşünme sıfır, ama GEMINI_MODEL bir "flash" modeline
// çevrilirse düşünme token'ları maxOutputTokens bütçesinden yenir ve cevap
// yarıda kesilir. Bu katsayı o durumda emniyet payı bırakır; faturalama gerçek
// token'lar üzerinden olduğu için lite kullanırken maliyeti etkilemez.
const THINKING_HEADROOM = Number(process.env.GEMINI_THINKING_HEADROOM) || 3;

// Gemini 3.x outputTokenLimit. Headroom çarpımı bunu aşarsa API 400 döner.
const GEMINI_OUTPUT_LIMIT = 65536;
const { sanitizeForAI } = require('../utils/validate');

// Prompt metinleri prompt-defaults.js'te; üretimde kullanılan sürüm
// prompt-store.js üzerinden gelir (panelden düzenlenebilir, DB okunamazsa
// koddaki varsayılana düşer).
const { getPrompt } = require('./prompt-store');
const { renderPlanetChunkFormat } = require('./prompt-defaults');

const AI_TIMEOUT_MS = 120000;
const MAX_RETRIES = 2;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`AI response timed out after ${ms / 1000}s`)), ms)
    ),
  ]);
}

/**
 * Metindeki İLK dengeli JSON nesnesini çıkarır.
 *
 * Eski yöntem `/\{[\s\S]*\}/` idi: ilk `{`'ten SON `}`'e kadar her şeyi
 * alıyordu. Model JSON'dan sonra açıklama yazdığında ve o açıklamada bir `}`
 * geçtiğinde, eşleşen metin geçerli JSON'ın ötesine taşıyor ve ayrıştırma
 * "Unexpected non-whitespace character after JSON" ile çöküyordu. Üretim
 * loglarında en sık görülen hata buydu; denemeler tükenince kullanıcı
 * haritasıyla ilgisi olmayan genel fallback metnini alıyordu.
 *
 * Süslü parantezleri sayarken string içindekileri ve kaçışlı karakterleri
 * atlıyor, sayaç sıfıra döndüğü yerde kesiyor.
 */
function extractBalancedJSON(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  // Dengelenmedi → cevap kesilmiş. Kalanı döndür, aşağıdaki onarım denesin.
  return text.slice(start);
}

function parseJSONResponse(text) {
  try {
    return JSON.parse(text);
  } catch (parseError) {
    const balanced = extractBalancedJSON(text);
    const jsonMatch = balanced ? [balanced] : null;
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (_) {
        // JSON was truncated (max_tokens hit) — try to repair
        let truncated = jsonMatch[0];
        // Close any open strings
        const quoteCount = (truncated.match(/(?<!\\)"/g) || []).length;
        if (quoteCount % 2 !== 0) truncated += '"';
        // Close brackets/braces
        const opens = (truncated.match(/[{[]/g) || []).length;
        const closes = (truncated.match(/[}\]]/g) || []).length;
        for (let i = 0; i < opens - closes; i++) {
          // Check if last open was [ or {
          const lastOpen = truncated.lastIndexOf('[') > truncated.lastIndexOf('{') ? ']' : '}';
          truncated += lastOpen;
        }
        try {
          return JSON.parse(truncated);
        } catch (__) {
          // Last resort: strip trailing incomplete values
          truncated = truncated.replace(/,\s*"[^"]*"?\s*$/, '');
          truncated = truncated.replace(/,\s*$/, '');
          // Re-close
          const o2 = (truncated.match(/[{[]/g) || []).length;
          const c2 = (truncated.match(/[}\]]/g) || []).length;
          for (let i = 0; i < o2 - c2; i++) truncated += '}';
          return JSON.parse(truncated);
        }
      }
    }
    throw new Error(`Failed to parse AI response as JSON: ${parseError.message}`);
  }
}

async function createGeminiMessage({ system, userPrompt, maxTokens, temperature }) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is missing');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify({
      // System prompt is identical on every call → auto implicit-cached (input savings).
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature,
        // maxOutputTokens düşünme token'larını DA kapsıyor. Gemini 3.x'te
        // düşünme kapatılamadığı için çağıranların verdiği bütçe burada
        // THINKING_HEADROOM ile çarpılıyor — aksi halde model bütçeyi
        // düşünmeye harcayıp finishReason: MAX_TOKENS ile JSON'u yarıda kesiyor.
        maxOutputTokens: Math.min(Math.ceil(maxTokens * THINKING_HEADROOM), GEMINI_OUTPUT_LIMIT),
        // Guarantees syntactically valid JSON output.
        responseMimeType: 'application/json',
        // thinkingConfig GÖNDERİLMİYOR. Gemini 3.x `thinkingBudget: 0` için
        // 400 INVALID_ARGUMENT döndürüyor; `thinkingLevel` / `thinking_level`
        // ise v1beta'da da v1alpha'da da tanınmıyor ("Cannot find field").
        // Yani düşünmeyi kapatmanın bir yolu yok — bütçeyi büyütüp yaşıyoruz.
      },
      // Emotional / relationship astrology text is benign; prevent false-positive safety blocks.
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
      ],
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Gemini request failed');
  }

  const candidate = payload?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text).filter(Boolean).join('');

  // safeJsonParse kırpılmış JSON'u sessizce onarıyor, yani MAX_TOKENS tek başına
  // hataya dönüşmüyor — yarım cümlelik bir içgörü üretiliyor. Loglanmazsa fark
  // edilmez; görülürse THINKING_HEADROOM artırılmalı.
  if (candidate?.finishReason === 'MAX_TOKENS') {
    const u = payload?.usageMetadata || {};
    console.warn(
      `[Gemini] Çıktı kırpıldı (MAX_TOKENS). model=${GEMINI_MODEL} ` +
      `düşünme=${u.thoughtsTokenCount ?? '?'} cevap=${u.candidatesTokenCount ?? '?'} ` +
      `bütçe=${Math.min(Math.ceil(maxTokens * THINKING_HEADROOM), GEMINI_OUTPUT_LIMIT)}`
    );
  }

  if (!text) {
    const blockReason = payload?.promptFeedback?.blockReason;
    const finishReason = candidate?.finishReason;
    throw new Error(
      blockReason
        ? `Gemini blocked prompt: ${blockReason}`
        : `Gemini response had no text (finishReason: ${finishReason || 'unknown'})`
    );
  }

  return text.trim();
}

/**
 * Retry wrapper with exponential backoff
 */
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, ...
        console.warn(`[AI] Attempt ${attempt + 1} failed: ${err.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

/**
 * Fallback content when AI is completely unreachable
 */
function buildFallbackInsight(sunSign) {
  return {
    love: {
      title: "Kalbin bilir",
      short: "Bugün duygularına alan aç.",
      detail: "Bugün kozmik enerjiler, duygusal farkındalığını ön plana çıkarıyor. Kendi kalbinin sesini dinle — cevaplar orada gizli."
    },
    career: {
      title: "Sabırlı adımlar",
      short: "Bugün stratejik düşün, acele etme.",
      detail: "İş hayatında bugün temkinli ama kararlı bir enerji hakim. Büyük hamleler yerine küçük ama etkili adımlar at."
    },
    energy: {
      title: "Dengeyi bul",
      short: "Bedenini dinle, enerjini koru.",
      detail: "Bugünün enerjisi denge üzerine kurulu. Kendine vakit ayır, nefes al ve ihtiyaçlarına kulak ver."
    },
    health: {
      title: "Bedenin konuşuyor",
      short: "Bugün bedeninin sana söylediği bir şey var.",
      detail: "Kozmik enerjiler bedenine dikkat etmeni söylüyor. Kendine nazik ol, sınırlarını koru."
    },
    money: {
      title: "Finansal farkındalık",
      short: "Bugün maddi kararlarında sezgilerine güven.",
      detail: "Finansal enerjiler bugün farkındalık istiyor. Büyük harcamalardan önce bir nefes al."
    },
    daily_focus: {
      title: "Shimal sana bakıyor",
      short: "Shimal'in sana bir mesajı var.",
      detail: `${sunSign} burcu olarak bugün, iç sesin sana rehberlik ediyor. Büyük resme bak ama anın güzelliğini kaçırma. Küçük sezgilerine güven — onlar seni doğru yöne taşıyacak.`,
      suggestion: "Bugün beş dakika sessizce otur ve zihnini dinle.",
      dos: ["Sezgilerine güven", "Doğaya çık", "Sessizlik anları"],
      donts: ["Acele kararlar", "Eski tartışmalar", "Aşırı kafein"]
    },
    notification: "Shimal'in sana bir mesajı var — bugün bunu kaçırma. ✨"
  };
}

/**
 * Generate personalized daily insights using Claude AI
 *
 * @param {object} params
 * @param {string} params.natalSummary - Text summary of user's natal chart
 * @param {string} params.transitSummary - Text summary of today's transits and aspects
 * @param {string} params.gender - User's gender
 * @param {string} params.relationshipStatus - User's relationship status
 * @param {string} params.workStatus - User's work status
 * @param {string} params.sunSign - User's sun sign
 * @param {string} [params.preferredName] - Preferred form of address
 * @returns {object} Structured daily insights
 */
async function generateDailyInsight({
  natalSummary,
  transitSummary,
  gender,
  relationshipStatus,
  workStatus,
  sunSign,
  moonSign,
  ascendantSign,
  preferredName,
  birthPlace,
  yesterdayFocus,
  feedbackSummary,
  quiz = null,
  isPremium = true, // default true → an accidental omission never degrades a paying user
}) {
  // Sanitize user-controlled fields before injecting into AI prompt
  const safeName = sanitizeForAI(preferredName, 50);
  const safeYesterday = yesterdayFocus ? yesterdayFocus.substring(0, 200) : '';

  const yesterdayLine = safeYesterday
    ? `\nYESTERDAY'S FOCUS (reference the energy shift in 1 sentence, don't repeat content):\n"${safeYesterday}"\n`
    : '';

  // Son 14 gündeki feedback özeti — AI'ya kullanıcının nelerden hoşlanıp hoşlanmadığını anlat
  let feedbackLine = '';
  if (feedbackSummary && (feedbackSummary.negatives.length > 0 || feedbackSummary.positives.length > 0)) {
    const lines = ['', 'GERİ BİLDİRİM KILAVUZU (son 14 gün, bu kullanıcı):'];
    if (feedbackSummary.negatives.length > 0) {
      lines.push('Bu kullanıcı şu bölümleri "benimle ilgili değil" olarak işaretledi:');
      for (const neg of feedbackSummary.negatives) {
        lines.push(`  • ${neg}`);
      }
      lines.push('→ Bu alanlarda klişeden kaç, kişinin gerçek bağlamına dokun, genel-geçer ifadelerden uzak dur.');
      lines.push('→ Natal haritasındaki spesifik yerleşimleri ve transitleri daha net referans al.');
    }
    if (feedbackSummary.positives.length > 0) {
      lines.push('Bu kullanıcı şu bölümleri "benimle ilgili" olarak işaretledi (tekrar tekrar):');
      for (const pos of feedbackSummary.positives) {
        lines.push(`  • ${pos}`);
      }
      lines.push('→ Bu bölümlerdeki tonu ve derinliği koru — çalışan yaklaşımı sürdür.');
    }
    feedbackLine = lines.join('\n') + '\n';
  }

  // ── Onboarding anketi ──────────────────────────────────────────────────────
  // Bu beş alan doğum haritasından TÜRETİLEMEZ. Aynı burçtan iki kullanıcının
  // birbirine benzeyen yorumlar almasının başlıca sebebi, prompt'un yalnızca
  // haritadan türeyen verilerle beslenmesiydi: aynı gün + aynı güneş burcu =
  // neredeyse aynı girdi. Bunlar girdiyi kişi bazında ayrıştırıyor.
  const QUIZ_TEXT = {
    focus: {
      love:   'Şu sıralar en çok aşk ve ilişkileri düşünüyor — aşk bölümünü en somut ve en uzun bölüm yap, diğerlerini kısalt.',
      career: 'Şu sıralar en çok kariyer ve parayı düşünüyor — kariyer ve para bölümlerini öne çıkar, somut zamanlama ver.',
      health: 'Şu sıralar en çok sağlık ve enerjiyi düşünüyor — enerji ve sağlık bölümlerini derinleştir, bedensel ritme değin.',
      self:   'Şu sıralar en çok kendini tanımayı düşünüyor — günlük odağı iç gözleme çevir, davranış kalıplarına ayna tut.',
    },
    astrologyLevel: {
      beginner: 'Astrolojiye yeni — terim kullanma. "Merkür retro" deme, ne hissedeceğini anlat. Sembolü değil sonucu yaz.',
      casual:   'Astrolojiyi orta düzeyde biliyor — tanıdık terimleri (retro, transit, yükselen) açıklamadan kullanabilirsin, ama cümleyi terime boğma.',
      advanced: 'Astrolojiyi ileri düzeyde biliyor — ev, açı, orb, derece detaylarını doğrudan kullan. Yüzeysel kalırsan güvenini kaybedersin.',
    },
    birthTimeAccuracy: {
      exact:       'Doğum saati kesin — yükselen ve ev yerleşimlerini güvenle kullan.',
      approximate: 'Doğum saati yaklaşık — yükselen ve ev yorumlarını temkinli kur, gezegen açılarına daha çok yaslan.',
      unsure:      'Doğum saati belirsiz — yükselen ve ev yerleşimlerine DAYANMA. Güneş, Ay ve gezegen açılarından konuş.',
    },
    supportStyle: {
      advice:        'Zor günde net tavsiye istiyor — her bölümde yapılabilir tek bir somut eylem söyle. Duygusal yumuşatma yerine yön ver.',
      validation:    'Zor günde anlaşılmak istiyor — önce hissi adlandır, sonra bağlamı ver. Emir kipinden kaçın.',
      understanding: 'Zor günde nedenini anlamak istiyor — sebep-sonuç kur, "şu transit şuna yol açıyor" diye açıkla.',
      space:         'Zor günde alan istiyor — baskı kurma, "şunu yapmalısın" deme. Sakin, alçak sesli, seçenek bırakan bir ton kullan.',
    },
    lifePhase: {
      starting:   'Hayatında bir şeye BAŞLIYOR — ilk adım, momentum ve cesaret temaları öne çıksın.',
      sustaining: 'Hayatında bir şeyi SÜRDÜRÜYOR — dayanıklılık, ritim ve tükenmeden devam etme temaları öne çıksın.',
      ending:     'Hayatında bir şeyi BİTİRİYOR — kapanış, bırakma ve yas temalarına yer ver; yeni başlangıç dayatma.',
      searching:  'Yön ARIYOR, arada kalmış — belirsizliği normalleştir, tek doğru yol dayatma, küçük denemeler öner.',
    },
  };

  let quizLine = '';
  if (quiz) {
    const parts = [];
    for (const [field, map] of Object.entries(QUIZ_TEXT)) {
      const value = quiz[field];
      if (value && map[value]) parts.push(`- ${map[value]}`);
    }
    if (parts.length > 0) {
      quizLine = `\nKULLANICININ KENDİ BEYANI (haritadan türetilemez — bu kişiyi diğerlerinden ayıran şey budur, MUTLAKA uygula):\n${parts.join('\n')}\n`;
    }
  }

  const relationshipContext = {
    single: 'Bekar — aşk bölümünü öz-keşif, iç hazırlık ve gerçek arzuları fark etme üzerine kur.',
    in_relationship: 'İlişkide — aşk bölümünü partnerle dinamikler, iletişim fırsatları ve bağı derinleştirme üzerine kur.',
    married: 'Evli — aşk bölümünü ortaklık dinamikleri, uzun vadeli yakınlık ve birlikte yaşam üzerine kur.',
    complicated: 'Karmaşık ilişki durumu — aşk bölümünü netlik, dürüst öz değerlendirme ve sınırlar üzerine kur.',
    not_specified: 'İlişki durumu belirtilmemiş — evrensel ama duygusal olarak yankı uyandıran bir çerçeve kur.',
  }[relationshipStatus] || 'İlişki durumu bilinmiyor.';

  const workContext = {
    employed: 'Çalışan — kariyer bölümünü işyeri dinamikleri, görünürlük ve strateji üzerine kur.',
    self_employed: 'Serbest/girişimci — kariyer bölümünü yaratıcı momentum, müşteri/iş enerjisi, finansal zamanlama ve sürdürülebilir ritim üzerine kur.',
    student: 'Öğrenci — kariyer bölümünü odaklanma, akademik zamanlama, öğrenme kapasitesi ve gelecek yön üzerine kur.',
    between_jobs: 'İş arıyor — kariyer bölümünü röportaj enerjisi, yön netliği, sabır ile atılım arasındaki denge üzerine kur.',
    other: 'Farklı çalışma durumu — kariyer bölümünü amaç, üretkenlik ve profesyonel büyüme üzerine kur.',
    not_specified: 'Çalışma durumu belirtilmemiş.',
  }[workStatus] || 'Çalışma durumu bilinmiyor.';

  const sunSignTR = toTR(sunSign);
  const moonSignTR = moonSign ? toTR(moonSign) : null;

  const ascendantSignTR = ascendantSign ? toTR(ascendantSign) : null;

  const safeBirthPlace = birthPlace ? sanitizeForAI(birthPlace, 100) : null;

  // Free users never see the premium 3rd paragraph — don't generate it (saves ~1/3 output cost).
  const freeTierOverride = isPremium
    ? ''
    : `⚠️ BU KULLANICI ÜCRETSİZ (FREE) — ÇOK ÖNEMLİ:
Her bölümün "detail" alanında SADECE 2 PARAGRAF üret (P1 + P2, \\n\\n ile ayrılmış).
3. PREMIUM paragrafı KESİNLİKLE ÜRETME. Sistem talimatındaki "3 paragraf" kuralı bu kullanıcı için GEÇERSİZ — 2 paragraf yaz.
daily_focus.detail de SADECE 2 PARAGRAF olsun.
`;

  const paragraphReminder = isPremium
    ? 'ÖNEMLİ HATIRLATMA: 3 paragrafı \\n\\n ile ayır. İlk 2 paragraf kendi başına tatmin edici olmalı. 3. paragraf natal haritaya dayalı derin kişisel içgörü olmalı.'
    : 'ÖNEMLİ HATIRLATMA: Her "detail" SADECE 2 PARAGRAF (\\n\\n ile ayrılmış) olsun. Premium 3. paragrafı ÜRETME. İki paragraf tek başına tatmin edici olmalı.';

  const userPrompt = `Bu kişi için bugünün kişiselleştirilmiş astroloji içgörüsünü oluştur.
${freeTierOverride}
KİŞİ:
- Güneş burcu: ${sunSignTR}
- Ay burcu: ${moonSignTR || 'Belirtilmemiş'}
- Yükselen burcu: ${ascendantSignTR || 'Belirtilmemiş'}
- Cinsiyet: ${gender}
- İlişki durumu: ${relationshipStatus}
- Çalışma durumu: ${workStatus}
- Tercih edilen isim: ${safeName || 'Belirtilmemiş'}
- Doğum yeri: ${safeBirthPlace || 'Belirtilmemiş'}

KİŞİSEL BAĞLAM:
${relationshipContext}
${workContext}
Ay burcu (${moonSignTR || 'bilinmiyor'}) duygusal tepkileri ve iç ihtiyaçları renklendirir — enerji ve günlük odak bölümlerinde bunu mutlaka yansıt.

NATAL HARİTA:
${natalSummary}

BUGÜNÜN TRANSİTLERİ VE NATAL HARİTAYA OLAN AÇILAR:
${transitSummary}
${quizLine}${yesterdayLine}${feedbackLine}
${paragraphReminder} Toplam mesajda en fazla 2-3 cümle zorluk/risk olsun, geri kalanı pozitif ve motive edici olsun. Spesifik saat verme.

AYNILAŞMAYA KARŞI — BU EN ÖNEMLİ KURAL:
Bu metni aynı gün başka kullanıcılar da alacak. Aralarındaki tek fark natal
harita ve yukarıdaki kişisel beyanlar. Metnin, burcu aynı olan başka birine
kopyalanabiliyorsa YANLIŞ yazmışsın demektir.

- Her bölümde, YUKARIDAKİ natal listeden en az bir spesifik yerleşimi adıyla
  kullan (gezegen + burç + ev, ya da somut bir açı). "Venüs'ün 7. evinde"
  gibi. Genel burç yorumu yazma.
- Bugünün transitini o yerleşime BAĞLA. Transit tek başına anlatılırsa herkese
  aynı şey gider; asıl kişiselleştirme transit × natal kesişimidir.
- Şu kalıpları KULLANMA: "bugün enerjin yüksek", "içgüdülerine güven",
  "evrenin sana bir mesajı var", "kendine zaman ayır", "değişime açık ol",
  "kalbini dinle". Bunlar herkese uyar, dolayısıyla hiç kimseye uymaz.
- Aynı cevapta iki bölüm birbirine benzemesin. Aşk ve kariyer aynı cümle
  yapısıyla başlıyorsa yeniden yaz.
- Somut hayat alanı adlandır (mesaj atmak, toplantı, uyku düzeni, kardeş,
  fatura, yolculuk) — soyut "enerji/titreşim/akış" dilinden kaçın.

Yalnızca yukarıdaki gerçek astronomik verileri kullanarak JSON içgörüsünü oluştur.`;

  // Panelden düzenlenmiş sürüm varsa o, yoksa koddaki varsayılan. getPrompt
  // hata fırlatmaz — DB erişilemese de üretim devam eder.
  const systemPrompt = await getPrompt('daily_system');

  return withRetry(async () => {
    const text = await withTimeout(
      createGeminiMessage({
        system: systemPrompt,
        userPrompt,
        maxTokens: 4096, // headroom over old 3500 — Gemini tokenizer differs; avoid mid-JSON truncation
        temperature: 0.7,
      }),
      AI_TIMEOUT_MS
    );
    const parsed = parseJSONResponse(text);

    // Safety net: daily_focus.dos / donts ZORUNLU. AI atlarsa fallback'ten doldur.
    if (parsed && parsed.daily_focus) {
      if (!Array.isArray(parsed.daily_focus.dos) || parsed.daily_focus.dos.length === 0) {
        parsed.daily_focus.dos = ['Sezgilerine güven', 'Bugüne odaklan', 'Küçük bir mola ver'];
        console.warn('[AI] daily_focus.dos eksik — fallback dolduruldu');
      }
      if (!Array.isArray(parsed.daily_focus.donts) || parsed.daily_focus.donts.length === 0) {
        parsed.daily_focus.donts = ['Eski tartışma açma', 'Aceleci karar verme', 'Kendini fazla zorlama'];
        console.warn('[AI] daily_focus.donts eksik — fallback dolduruldu');
      }
    }

    return parsed;
  });
}

// ─── Personality Analysis ────────────────────────────────────────────────────

// 12 gezegen × en az 10 cümle tek istekte 3 dakikayı aşıyordu. Gruplar paralel
// üretilip birleştiriliyor → duvar saati en yavaş gruba iniyor.
const PLANET_GROUPS = [
  ['Sun', 'Moon', 'Mercury', 'Venus'],
  ['Mars', 'Jupiter', 'Saturn', 'Uranus'],
  ['Neptune', 'Pluto', 'TrueNode', 'Chiron'],
];

/**
 * Generate one-time personality analysis from natal chart
 */
async function generatePersonalityAnalysis({ natalSummary, gender, relationshipStatus, workStatus, sunSign, moonSign, ascendantSign, preferredName, quiz = null }) {
  const safeName = sanitizeForAI(preferredName, 50);
  const sunSignTR = toTR(sunSign);
  const moonSignTR = moonSign ? toTR(moonSign) : null;
  const ascendantSignTR = ascendantSign ? toTR(ascendantSign) : null;

  // Anketten yalnızca kişilik metnini gerçekten etkileyen ikisi: terim yoğunluğu
  // ve doğum saatinin güvenilirliği. Saat belirsizse yükselen/ev yorumlarına
  // yaslanmak uydurma olur.
  let quizLine = '';
  if (quiz) {
    const parts = [];
    if (quiz.astrologyLevel === 'beginner') {
      parts.push('- Astrolojiye yeni: terim kullanma, sembolü değil sonucu anlat.');
    } else if (quiz.astrologyLevel === 'advanced') {
      parts.push('- Astrolojiyi ileri düzeyde biliyor: ev, açı ve derece detaylarını doğrudan kullan, yüzeysel kalma.');
    }
    if (quiz.birthTimeAccuracy === 'unsure') {
      parts.push('- Doğum saati belirsiz: yükselen ve EV yerleşimlerine dayanan iddialardan kaçın, gezegen açılarından konuş.');
    } else if (quiz.birthTimeAccuracy === 'approximate') {
      parts.push('- Doğum saati yaklaşık: ev yorumlarını temkinli kur.');
    }
    if (parts.length > 0) quizLine = `\nKULLANICININ BEYANI (uygula):\n${parts.join('\n')}\n`;
  }

  const userPrompt = `Bu kişinin doğum haritasına dayalı kapsamlı kişilik analizi oluştur.

KİŞİ:
- Güneş burcu: ${sunSignTR}
- Ay burcu: ${moonSignTR || 'Belirtilmemiş'}
- Yükselen burcu: ${ascendantSignTR || 'Belirtilmemiş'}
- Cinsiyet: ${gender}
- İlişki durumu: ${relationshipStatus}
- Çalışma durumu: ${workStatus}
- İsim: ${safeName || 'Belirtilmemiş'}

NATAL HARİTA (tüm gezegen konumları, evler, açılar):
${natalSummary}
${quizLine}
KALIP CÜMLE YASAĞI — EN ÇOK BURADA HATA YAPILIYOR:
Aynı gezegen aynı burçta olan herkese yazılabilecek bir cümle kurma. Ayırt
edici olan gezegenin burcu değil, BURÇ + EV + AÇI üçlüsüdür.

- Her gezegen yorumunda o gezegenin EVİNİ ve varsa bir AÇISINI cümlenin içine
  ör. Yalnız burçtan konuşursan burç yorumu yazmış olursun.
- Şu boş kalıpları kullanma: "derin bir iç dünyan var", "güçlü bir sezgiye
  sahipsin", "insanlar sana güvenir", "mükemmeliyetçi olabilirsin",
  "duygularını içine atarsın". Bunlar herkeste doğru çıkar, dolayısıyla hiçbir
  şey söylemez.
- İki gezegen yorumu aynı cümle yapısıyla başlamasın.
- Çelişkiyi saklama: haritada gerilim varsa (kare, karşıt) bunu bir kişilik
  çelişkisi olarak yaz. En kişisel kısım budur; herkesi olumlayan metin
  kimseyi tarif etmez.

Yorumların derin ve kişiye özel olsun. Genel burç yorumu değil — bu kişinin spesifik gezegen-burç-ev kombinasyonuna dayalı benzersiz bir analiz olsun.`;

  // Parça başına timeout. Eskiden tek istek 5 dakikaya kadar bekleyebiliyordu;
  // artık parçalar paralel ve her biri çok daha küçük.
  const CHUNK_TIMEOUT_MS = 90000;

  async function chunk(system, extraInstruction, maxTokens) {
    return withRetry(async () => {
      const text = await withTimeout(
        createGeminiMessage({
          system,
          userPrompt: extraInstruction ? `${userPrompt}\n\n${extraInstruction}` : userPrompt,
          maxTokens,
          temperature: 0.7,
        }),
        CHUNK_TIMEOUT_MS
      );
      return parseJSONResponse(text);
    }, 1); // Kişilik analizi pahalı — tek deneme hakkı.
  }

  // Prompt'ları tek seferde çöz; dört parça da aynı kural metnini paylaşıyor.
  const [rules, profileFormat, planetFormat] = await Promise.all([
    getPrompt('personality_rules'),
    getPrompt('personality_profile_format'),
    getPrompt('personality_planet_format'),
  ]);

  // Dört istek paralel: üç gezegen grubu + özet/güçlü yönler/gizli özellikler.
  // Duvar saati toplam değil, en yavaş parçanın süresi kadar.
  const [profile, ...planetChunks] = await Promise.all([
    chunk(`${rules}\n\n${profileFormat}`, null, 3000),
    ...PLANET_GROUPS.map((keys) =>
      chunk(
        `${rules}\n\n${renderPlanetChunkFormat(planetFormat, keys)}`,
        `Yalnızca şu gezegenleri yorumla: ${keys.join(', ')}. Her biri için en az 10 cümle yaz.`,
        6000
      )
    ),
  ]);

  const planets = {};
  for (const part of planetChunks) {
    Object.assign(planets, part?.planets || {});
  }

  const missing = PLANET_GROUPS.flat().filter((k) => !planets[k]);
  if (missing.length > 0) {
    console.warn(`[Gemini] Kişilik analizinde eksik gezegen: ${missing.join(', ')}`);
  }

  return {
    summary: profile?.summary || '',
    planets,
    strengths: profile?.strengths || [],
    hiddenTraits: profile?.hiddenTraits || [],
  };
}

module.exports = {
  generateDailyInsight,
  generatePersonalityAnalysis,
  buildFallbackInsight,
  // Test için: model cevabını ayrıştırmak üretimdeki en kırılgan adım.
  parseJSONResponse,
  extractBalancedJSON,
};
