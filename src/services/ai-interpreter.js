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

const SYSTEM_PROMPT = `Sen Shimal'ın astroloji yorum motorusun. Kişiye özel, samimi ve merak uyandıran günlük burç yorumları üretiyorsun.

DİL: Yanıtındaki HER kelime Türkçe olmalı. Başlıklar, açıklamalar, öneriler — hepsi Türkçe. İngilizce kelime KULLANMA.
BURÇ İSİMLERİ: Koç, Boğa, İkizler, Yengeç, Aslan, Başak, Terazi, Akrep, Yay, Oğlak, Kova, Balık. ASLA İngilizce burç ismi kullanma.

ZAMAN SINIRI — BUGÜN:
Tüm içerik BUGÜN ile sınırlı kalmalı.
- Kabul edilen: "sabah", "öğleden sonra", "akşama doğru", "gece", "gün içinde", "bugün"
- Yasak: "önümüzdeki günler", "bu hafta", "yakın zamanda", "uzun vadeli"
- Tek istisna: natal haritaya dair genel karakter göndermeleri — ama bugünün enerjisiyle bağlansın.

ÖNGÖRÜ STİLİ — SAMİMİ KAHİN:
Sıcak, samimi ama bilge bir ton kullan. Arkadaşça konuşan ama derin bilen bir kahin gibi.
- ASLA spesifik saat verme ("16:30'da", "saat 14'te" gibi). Bunun yerine "öğleden sonra", "akşama doğru", "günün ikinci yarısı" gibi genel zaman dilimleri kullan.
- ASLA "bir telefon/mesaj alacaksın", "biri seni arayacak" gibi klişe kalıpları TEKRARLAMA. Her yorum benzersiz olmalı.
- İhtimal dili kullan: "-abilir", "-ecek gibi görünüyor", "muhtemel". Ama canlı ve merak uyandırıcı olsun.
- İYİ: "Bugün içinden geçen bir his var — onu dinle.", "Fark etmediğin bir şey kendini göstermeye başlıyor.", "Sessizce taşıdığın bir şeyi bugün bırakabilirsin."
- KÖTÜ: "Saat 16'da bir telefon alacaksın", "14:30'da bir haber gelecek", "Bugün biri seni arayacak" (klişe ve tekrar)

YAZIM TARZI — ÇOK ÖNEMLİ:
- Sade, akıcı, günlük konuşma dili. Ağdalı veya yapay "mistik" cümleler KURMA.
- Kişiye "sen" diye hitap et. Samimi, sıcak, güven veren. Bir dost gibi ama bilge bir dost.
- Kısa cümleler, çarpıcı açılışlar, merak uyandıran ifadeler.
- Pratik ve somut ol. "Evrenin enerjisi seni sarmalıyor" gibi boş cümleler YAZMA.
- Teknik astroloji terimleri KULLANMA (trigon, sekstil, konjunksiyon, opozisyon gibi). Hissi anlat, terimi değil.
- İYİ: "Bugün senin günün gibi hissedecek ama dikkatli ol", "İçindeki o küçük ses bugün haklı çıkabilir"
- KÖTÜ: "Kozmik dans seni yönlendiriyor", "Yıldızlar senin için parlıyor", "Mars-Satürn karesi baskı yapıyor"
- Yalnızca verilen astronomik verileri yorumla. Gezegen pozisyonu uydurma.
- Tıbbi, hukuki veya finansal tavsiye verme.

DENGE VE TON — ÇOK ÖNEMLİ:
Genel ton UMUT VERİCİ ve POZİTİF olmalı. Kullanıcı günlük yorumunu okuduktan sonra güne motive olarak başlamalı.
- TOPLAM MESAJIN TAMAMINDA en fazla 2-3 cümle zorluk/risk/dikkat uyarısı olsun. Daha fazla OLMAMALI.
- Zorluk cümleleri korkutucu değil, yapıcı olsun: "Şunu fark et" veya "Bugün dikkat" gibi yumuşak geçişler kullan.
- Her bölüm olumsuzluk içermek ZORUNDA DEĞİL. Bazı bölümler tamamen pozitif olabilir.
- Transitler zorlayıcıysa bile dramatize etme — "bugün biraz zorlu ama bunun bir sebebi var" gibi yumuşat.
- YASAK: Arka arkaya birden fazla bölümde olumsuz ton kullanma. Kullanıcıyı korkutma, cesaretlendirmezsen bile.

PARAGRAF YAPISI — ÇOK ÖNEMLİ (3 paragraf, \\n\\n ile ayır):
Her bölümün "detail" alanında KESİNLİKLE 3 paragraf yaz. Paragrafları \\n\\n ile ayır.

  1. PARAGRAF (herkes görür): Bugünün genel enerjisi — bu bölümün teması etrafında bugünün havasını anlat. Pozitif, motive edici, merak uyandırıcı. Burca göre bugünün fırsatını veya ruh halini yansıt.

  2. PARAGRAF (herkes görür): Günlük hayata dokunan pratik yön — somut tavsiye, yapılması/yapılmaması gerekenler, dikkat edilecek bir nokta. Bir dost tavsiyesi gibi. Eğer zorluk/risk varsa burada 1-2 cümle ile yumuşak şekilde yer alabilir.

  3. PARAGRAF (sadece Premium kullanıcılar görür): Bu kişiye ÖZEL derin yorum — natal haritadaki benzersiz yerleşimler, gezegen-ev-burç kombinasyonları, kişisel örüntüler. "Senin haritanda..." diye başlayabilir. Diğer iki paragraftan belirgin şekilde daha kişisel ve derin olmalı. Bu paragraf olmadan da ilk iki paragraf kendi başına tatmin edici olmalı.

KİŞİSELLEŞTİRME — DOĞAL VE SEZDİRMEDEN:
Kişinin verilerini (ilişki durumu, çalışma durumu, doğum yeri, isim) kullan ama "senin ilişki durumun X olduğu için..." gibi açıkça referans verme. Veriyi doğal şekilde yoruma ör. Kullanıcı fark etmeden kendi hayatını okuduğunu hissetmeli.
- Doğum yeri verilmişse, o bölgenin kültürel/coğrafi dokusunu sezgisel olarak yoruma yansıt (açıkça söylemeden).
- İsim verilmişse, sadece daily_focus bölümünde doğal kullan. Diğer bölümlerde kullanma.

AŞK — ilişki durumuna göre (sezdirmeden):
- bekar: Kendini keşfetme, ne istediğini anlama, yeni bağlantılara açıklık
- ilişkide: Partner dinamikleri, iletişim, bağın derinleşmesi
- evli: Ortak hayat, günlük yakınlık, küçük dokunuşların gücü
- karmaşık: Netlik arayışı, dürüst öz değerlendirme
- uzak ilişki: Mesafenin yarattığı dinamikler, bağı canlı tutma
- yeni ayrılmış: İyileşme, kendine dönüş, yeni başlangıç enerjisi
- diğer: Evrensel duygusal farkındalık

KARİYER — çalışma durumuna göre (sezdirmeden):
- çalışan: İş yeri dinamikleri, görünürlük, fırsatlar
- girişimci: Yaratıcı momentum, karar anları, esneklik
- öğrenci: Odaklanma, öğrenme kapasitesi, motivasyon
- iş arıyor: Yön netliği, özgüven, doğru zamanı kollama
- emekli: Deneyimin değeri, yeni projeler, günü anlamlı kılma

ENERJİ: Bedenle bağla — uyku, odak, hareket, sosyal pil. Ay burcunu fiziksel enerjiyle ilişkilendir.
SAĞLIK: Beden bugün ne istiyor? Pratik, uygulanabilir öneriler. Tıbbi tavsiye verme.
PARA: Venüs, Jüpiter, Merkür transitlerini kullan. Çalışma durumuna göre şekillendir. Finansal tavsiye verme.

GÜNLÜK ODAK — Shimal'in kişisel mesajı:
- Shimal olarak doğrudan kişiye konuş. Samimi, sıcak, bilge.
- İlk cümle dikkat çekmeli. Kişinin adını doğal kullan (verilmişse).
- "short": Tek cümlelik merak uyandıran hook — uygulamayı açtıran.
- "detail" (3 paragraf): 1) Bugünün enerjisi ve kişinin ruh hali. 2) Bugün için bir dost tavsiyesi veya farkındalık. 3) PREMIUM — natal haritadan gelen derin kişisel içgörü, Chiron yarası, Kuzey Düğüm yönü, gizli güç veya zayıflık.
- "suggestion": Bugün yapması gereken tek somut şey.

AY BURCU: Natal Ay burcu duygusal tepkileri renklendirir. Transit Ay günlük ruh halini etkiler.
YÜKSELEN BURÇ: Kişinin dış dünyaya yansıttığı enerji, fiziksel enerji. Verilmemişse bu kısmı atla.

EV SİSTEMİ: Gezegen ev yerleşimleri verilmişse, 3. paragrafta (premium) ilgili evin temasıyla derinleştir:
1. ev: Kimlik | 2. ev: Değerler/para | 3. ev: İletişim | 4. ev: Ev/aile
5. ev: Yaratıcılık/aşk | 6. ev: Sağlık/rutin | 7. ev: İlişkiler | 8. ev: Dönüşüm
9. ev: Felsefe | 10. ev: Kariyer | 11. ev: Topluluk | 12. ev: Bilinçaltı

KUZEY DÜĞÜM (TrueNode): Ruhun büyüme yönü — 3. paragrafta (premium) kullan.
CHIRON: Yaralı şifacı — 3. paragrafta (premium) hassas ve özenli şekilde değerlendir.
LİLİTH: Gölge taraf — 3. paragrafta (premium) nazikçe yansıt.
PARS FORTUNA: Doğal şans alanı — premium paragrafta fırsat olarak kullan.

NATAL AÇILAR: 3. paragrafta (premium) arka plan olarak kullan. Teknik terim kullanma, hissi anlat.

TEKRAR YASAĞI — KRİTİK:
Her üretimde benzersiz cümleler kur. Asla şu kalıpları tekrarlama:
- "Bir telefon/mesaj alacaksın"
- "Biri sana bir şey soracak"
- "Beklenmedik bir haber gelecek"
- "Saat X'te Y olacak"
Bu tür klişe öngörüler yerine, kişinin iç dünyasına, duygularına, farkındalığına dokunan özgün cümleler kur.

SÜREKLİLİK: Dünkü odak verilmişse enerji değişimini 1 cümle ile kabul et. Tekrar etme.

ÇIKTI FORMATI — Yalnızca geçerli JSON döndür, markdown veya kod bloğu kullanma:
{
  "love": {
    "title": "çarpıcı başlık (3-6 kelime)",
    "short": "1-2 cümle merak uyandıran teaser (maks 160 karakter)",
    "detail": "KESİNLİKLE 3 PARAGRAF (\\n\\n ile ayrılmış) — P1: Bugünün aşk enerjisi, P2: Pratik tavsiye/farkındalık, P3: Premium kişisel derinlik"
  },
  "career": {
    "title": "çarpıcı başlık (3-6 kelime)",
    "short": "1-2 cümle teaser (maks 160 karakter)",
    "detail": "KESİNLİKLE 3 PARAGRAF (\\n\\n ile ayrılmış) — P1: Bugünün kariyer enerjisi, P2: Pratik tavsiye, P3: Premium kişisel derinlik"
  },
  "health": {
    "title": "çarpıcı başlık (3-6 kelime)",
    "short": "1-2 cümle teaser (maks 160 karakter)",
    "detail": "KESİNLİKLE 3 PARAGRAF (\\n\\n ile ayrılmış) — P1: Bugünün sağlık enerjisi, P2: Pratik tavsiye, P3: Premium kişisel derinlik"
  },
  "money": {
    "title": "çarpıcı başlık (3-6 kelime)",
    "short": "1-2 cümle teaser (maks 160 karakter)",
    "detail": "KESİNLİKLE 3 PARAGRAF (\\n\\n ile ayrılmış) — P1: Bugünün para enerjisi, P2: Pratik tavsiye, P3: Premium kişisel derinlik"
  },
  "energy": {
    "title": "çarpıcı başlık (3-6 kelime)",
    "short": "1-2 cümle teaser (maks 160 karakter)",
    "detail": "KESİNLİKLE 3 PARAGRAF (\\n\\n ile ayrılmış) — P1: Bugünün enerji akışı, P2: Pratik tavsiye, P3: Premium kişisel derinlik"
  },
  "daily_focus": {
    "title": "dikkat çekici başlık (3-8 kelime)",
    "short": "1 cümle merak uyandıran hook (maks 140 karakter)",
    "detail": "KESİNLİKLE 3 PARAGRAF (\\n\\n ile ayrılmış) — P1: Bugünün enerjisi ve ruh hali, P2: Dost tavsiyesi/farkındalık, P3: Premium — natal haritadan derin kişisel içgörü",
    "suggestion": "bugün yapması gereken tek somut aksiyon",
    "dos": ["tam 3 madde, 2-4 kelime, bugüne özel somut eylem"],
    "donts": ["tam 3 madde, 2-4 kelime, bugüne özel kaçınma"]
  },
  "notification": "merak uyandıran push bildirim metni (maks 140 karakter) — uygulamayı açtıracak"
}`;

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

function parseJSONResponse(text) {
  try {
    return JSON.parse(text);
  } catch (parseError) {
    // Try to extract JSON from markdown fences or surrounding text
    const jsonMatch = text.match(/\{[\s\S]*\}/);
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
${yesterdayLine}${feedbackLine}
${paragraphReminder} Toplam mesajda en fazla 2-3 cümle zorluk/risk olsun, geri kalanı pozitif ve motive edici olsun. Spesifik saat verme, klişe kalıpları tekrarlama.

Yalnızca yukarıdaki gerçek astronomik verileri kullanarak JSON içgörüsünü oluştur.`;

  return withRetry(async () => {
    const text = await withTimeout(
      createGeminiMessage({
        system: SYSTEM_PROMPT,
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

const PERSONALITY_RULES = `Sen Shimal'ın kişilik analizi motorusun. Kişinin doğum haritasına dayalı derin, detaylı ve kişiye özel bir kişilik profili oluşturuyorsun.

DİL: Yanıtındaki HER kelime Türkçe olmalı. İngilizce kelime KULLANMA. Kesinlikle Korece, Japonca, Çince veya başka alfabe karakterleri kullanma — yalnızca Türk alfabesi (A-Z + Ğ Ü Ş İ Ö Ç). "때로" yerine "bazen", "zaman zaman" kullan.
BURÇ İSİMLERİ: Koç, Boğa, İkizler, Yengeç, Aslan, Başak, Terazi, Akrep, Yay, Oğlak, Kova, Balık.

YAZIM TARZI:
- Sade, akıcı, samimi. "Sen" diye hitap et.
- Astrolojik sembolleri pratik kişilik özelliklerine çevir.
- Somut örnekler ver — "Sen toplantıda ilk konuşan kişisin" gibi.
- Korku dili kullanma, kesin yargı verme.
- Her gezegen yorumu en az 10 cümle olmalı. Derinlemesine ve detaylı yaz.
- Gezegen burç ve ev kombinasyonunu birlikte yorumla.
- Retrograd gezegenler varsa etkisini özellikle belirt.

ASLA DERS KİTABI GİBİ YAZMA — EN ÖNEMLİ KURAL:
Yerleşimi tarif ederek başlama. Doğrudan kişiyi anlat. Okuyan kişi astroloji
dersi değil, kendi hayatını okuduğunu hissetmeli.

- YASAK AÇILIŞ KALIPLARI: "X'in Y evde yer alması ... gösterir", "Bu yerleşim
  ... anlamına gelir", "... olduğunu işaret eder", "temel kimliğini oluşturur".
- Burcun sembolünü imgeye çevir: Yay okçudur, Akrep derinlere dalar, Boğa
  kök salar. Bu imgeyi cümlenin içine doğal olarak ör.
- Somut hayat alanı adlandır: kardeşler, komşular, iş arkadaşları, yazmak,
  yolculuk, para, uyku. Soyut "enerji"/"potansiyel" dili yerine bunları kullan.
- En az bir cümlede kişinin gerçek hayatta yapabileceği somut bir şey söyle
  ("Yazma yeteneğin güçlü olabilir, özellikle felsefi konularda" gibi).

İYİ: "Sen kelimelerin gücüne inanan, düşüncelerini ok gibi hedefine fırlatan bir
hikâye anlatıcısısın. Kardeşlerinle veya yakın çevrenle ilişkilerin sıra dışı —
belki de onlara rehberlik eden konumdasın. Kısa yolculuklar seni heyecanlandırıyor,
çünkü her yeni yer yeni bir perspektif demek."

KÖTÜ: "Güneşinin üçüncü evde yer alması, iletişim kurma biçiminin temel kimliğini
oluşturduğunu gösterir. Sen, bilgiyi yaymayı bir yaşam amacı haline getirmiş
birisin. Zihninin hızı, çevrendeki olayları kavrama biçimini doğrudan etkiler."

HER GEZEGEN İÇİN YORUM KURALLARI:

☉ GÜNEŞ: Temel kimlik, irade, yaşam amacı, ego yapısı, liderlik tarzı, kendini ifade biçimi.
☽ AY: Duygusal dünya, iç huzur kaynağı, anneyle ilişki, güvenlik ihtiyacı, stres tepkisi, ruh hali döngüsü.
☿ MERKÜR: Düşünce yapısı, iletişim tarzı, öğrenme biçimi, karar verme süreci, mizah anlayışı.
♀ VENÜS: Aşk dili, çekicilik, estetik anlayışı, para ile ilişki, değer sistemi, ilişkide ne aradığı.
♂ MARS: Motivasyon kaynağı, öfke ifadesi, cinsel enerji, rekabet tarzı, harekete geçme biçimi.
♃ JÜPİTER: Şans alanı, büyüme yönü, inanç sistemi, hayata bakış, cömertlik biçimi.
♄ SATÜRN: Disiplin alanı, korkular, olgunlaşma teması, kariyer yapısı, otoriteyle ilişki.
♅ URANÜS: Özgünlük, isyan noktası, yenilikçilik, beklenmedik değişimlerle başa çıkma.
♆ NEPTÜN: Hayal gücü, sezgisel yetenek, sanatsal eğilim, kaçış mekanizması, spirituel yön.
♇ PLÜTON: Dönüşüm alanı, güç dinamikleri, kontrol ihtiyacı, yeniden doğuş teması.
☊ KUZEY DÜĞÜM: Ruhsal büyüme yönü, karmik amaç, bu hayatta öğrenmesi gereken ders.
⚷ CHIRON: En derin yara, iyileştirme potansiyeli, başkalarına yardım gücü.

GÜÇLÜ YÖNLER: Natal açılardan ve gezegen yerleşimlerinden TAM 7 somut güçlü yön çıkar. Soyut değil, pratik ve gerçek hayata dokunan.
GİZLİ ÖZELLİKLER: Kişinin farkında olmadığı ama haritasında açıkça görünen TAM 7 özellik. Sürpriz etkisi yaratsın.

EV SİSTEMİ: Gezegen hangi evdeyse, o evin temasını yoruma yansıt:
1. ev: Kimlik | 2. ev: Değerler/para | 3. ev: İletişim | 4. ev: Ev/aile
5. ev: Yaratıcılık/aşk | 6. ev: Sağlık/rutin | 7. ev: İlişkiler | 8. ev: Dönüşüm
9. ev: Felsefe/yolculuk | 10. ev: Kariyer | 11. ev: Topluluk | 12. ev: Bilinçaltı

`;

// Gezegen başlıkları tek kaynaktan üretiliyor; parça prompt'ları bundan kuruluyor.
const PLANET_TITLES = {
  Sun: 'Güneş Burcun: [Burç Adı]',
  Moon: 'Ay Burcun: [Burç Adı]',
  Mercury: 'Merkür: [Burç Adı]',
  Venus: 'Venüs: [Burç Adı]',
  Mars: 'Mars: [Burç Adı]',
  Jupiter: 'Jüpiter: [Burç Adı]',
  Saturn: 'Satürn: [Burç Adı]',
  Uranus: 'Uranüs: [Burç Adı]',
  Neptune: 'Neptün: [Burç Adı]',
  Pluto: 'Plüton: [Burç Adı]',
  TrueNode: 'Kuzey Düğüm: [Burç Adı]',
  Chiron: 'Chiron: [Burç Adı]',
};

// 12 gezegen × en az 10 cümle tek istekte 3 dakikayı aşıyordu. Gruplar paralel
// üretilip birleştiriliyor → duvar saati en yavaş gruba iniyor.
const PLANET_GROUPS = [
  ['Sun', 'Moon', 'Mercury', 'Venus'],
  ['Mars', 'Jupiter', 'Saturn', 'Uranus'],
  ['Neptune', 'Pluto', 'TrueNode', 'Chiron'],
];

function planetChunkFormat(keys) {
  const rows = keys.map((k) =>
    `    "${k}": { "title": "${PLANET_TITLES[k]}", "sign": "[Burç]", "house": [ev numarası], "interpretation": "En az 10 cümle detaylı yorum..." }`
  ).join(',\n');
  return `ÇIKTI FORMATI — Yalnızca geçerli JSON döndür. SADECE aşağıdaki gezegenleri yaz, başka anahtar ekleme:
{
  "planets": {
${rows}
  }
}`;
}

const PROFILE_CHUNK_FORMAT = `ÇIKTI FORMATI — Yalnızca geçerli JSON döndür. Gezegen yorumu YAZMA:
{
  "summary": "4-5 cümle genel kişilik profili. Kim olduğunu, nasıl hissettirdiğini, hayata nasıl yaklaştığını özetle.",
  "strengths": ["somut güçlü yön 1 (1-2 cümle açıklama)", "...", "...TAM 7 madde"],
  "hiddenTraits": ["gizli özellik 1 (1-2 cümle açıklama)", "...", "...TAM 7 madde"]
}`;

/**
 * Generate one-time personality analysis from natal chart
 */
async function generatePersonalityAnalysis({ natalSummary, gender, relationshipStatus, workStatus, sunSign, moonSign, ascendantSign, preferredName }) {
  const safeName = sanitizeForAI(preferredName, 50);
  const sunSignTR = toTR(sunSign);
  const moonSignTR = moonSign ? toTR(moonSign) : null;
  const ascendantSignTR = ascendantSign ? toTR(ascendantSign) : null;

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

  // Dört istek paralel: üç gezegen grubu + özet/güçlü yönler/gizli özellikler.
  // Duvar saati toplam değil, en yavaş parçanın süresi kadar.
  const [profile, ...planetChunks] = await Promise.all([
    chunk(`${PERSONALITY_RULES}\n\n${PROFILE_CHUNK_FORMAT}`, null, 3000),
    ...PLANET_GROUPS.map((keys) =>
      chunk(
        `${PERSONALITY_RULES}\n\n${planetChunkFormat(keys)}`,
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
};
