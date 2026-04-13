const { toTR } = require('../utils/zodiac-tr');
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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

async function createAnthropicMessage({ system, userPrompt, maxTokens, temperature }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is missing');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      temperature,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Anthropic request failed');
  }

  const text = payload?.content?.[0]?.text;
  if (!text) {
    throw new Error('Anthropic response did not include text content');
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

  const userPrompt = `Bu kişi için bugünün kişiselleştirilmiş astroloji içgörüsünü oluştur.

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
ÖNEMLİ HATIRLATMA: 3 paragrafı \\n\\n ile ayır. İlk 2 paragraf kendi başına tatmin edici olmalı. 3. paragraf natal haritaya dayalı derin kişisel içgörü olmalı. Toplam mesajda en fazla 2-3 cümle zorluk/risk olsun, geri kalanı pozitif ve motive edici olsun. Spesifik saat verme, klişe kalıpları tekrarlama.

Yalnızca yukarıdaki gerçek astronomik verileri kullanarak JSON içgörüsünü oluştur.`;

  return withRetry(async () => {
    const text = await withTimeout(
      createAnthropicMessage({
        system: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 3500,
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

const PERSONALITY_SYSTEM_PROMPT = `Sen Shimal'ın kişilik analizi motorusun. Kişinin doğum haritasına dayalı derin, detaylı ve kişiye özel bir kişilik profili oluşturuyorsun.

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

GÜÇLÜ YÖNLER: Natal açılardan ve gezegen yerleşimlerinden 5-7 somut güçlü yön çıkar. Soyut değil, pratik ve gerçek hayata dokunan.
GİZLİ ÖZELLİKLER: Kişinin farkında olmadığı ama haritasında açıkça görünen 5-7 özellik. Sürpriz etkisi yaratsın.

EV SİSTEMİ: Gezegen hangi evdeyse, o evin temasını yoruma yansıt:
1. ev: Kimlik | 2. ev: Değerler/para | 3. ev: İletişim | 4. ev: Ev/aile
5. ev: Yaratıcılık/aşk | 6. ev: Sağlık/rutin | 7. ev: İlişkiler | 8. ev: Dönüşüm
9. ev: Felsefe/yolculuk | 10. ev: Kariyer | 11. ev: Topluluk | 12. ev: Bilinçaltı

ÇIKTI FORMATI — Yalnızca geçerli JSON döndür:
{
  "summary": "4-5 cümle genel kişilik profili. Kim olduğunu, nasıl hissettirdiğini, hayata nasıl yaklaştığını özetle.",
  "planets": {
    "Sun": { "title": "Güneş Burcun: [Burç Adı]", "sign": "[Burç]", "house": [ev numarası], "interpretation": "En az 10 cümle detaylı yorum..." },
    "Moon": { "title": "Ay Burcun: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Mercury": { "title": "Merkür: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Venus": { "title": "Venüs: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Mars": { "title": "Mars: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Jupiter": { "title": "Jüpiter: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Saturn": { "title": "Satürn: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Uranus": { "title": "Uranüs: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Neptune": { "title": "Neptün: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Pluto": { "title": "Plüton: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "TrueNode": { "title": "Kuzey Düğüm: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." },
    "Chiron": { "title": "Chiron: [Burç Adı]", "sign": "[Burç]", "house": [ev], "interpretation": "..." }
  },
  "strengths": ["somut güçlü yön 1 (1-2 cümle açıklama)", "...", "...en az 5 madde"],
  "hiddenTraits": ["gizli özellik 1 (1-2 cümle açıklama)", "...", "...en az 5 madde"]
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

Bu kişinin haritasındaki HER gezegen için en az 10 cümlelik derin, kişiye özel yorum yaz. Genel burç yorumu değil — bu kişinin spesifik gezegen-burç-ev kombinasyonuna dayalı benzersiz bir analiz olsun.`;

  const PERSONALITY_TIMEOUT_MS = 300000; // 5 minutes — personality is a large one-time generation
  return withRetry(async () => {
    const text = await withTimeout(
      createAnthropicMessage({
        system: PERSONALITY_SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 12000,
        temperature: 0.7,
      }),
      PERSONALITY_TIMEOUT_MS
    );
    return parseJSONResponse(text);
  }, 1); // Only 1 retry for personality (it's expensive)
}

module.exports = {
  generateDailyInsight,
  generatePersonalityAnalysis,
  buildFallbackInsight,
};
