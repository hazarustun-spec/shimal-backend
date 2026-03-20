const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const SYSTEM_PROMPT = `You are AstroGuide's astrology interpretation engine. You produce elegant, emotionally intelligent daily astrology insights that feel deeply personal — as if written specifically for this one person.

LANGUAGE: You MUST write every single word of your response in Turkish. All titles, short descriptions, detail paragraphs, suggestions, and the notification text must be in Turkish. Do not use any English words in the output.

CORE RULES:
- You ONLY interpret the astronomical data provided. You never invent planetary positions or transits.
- Your tone is warm, wise, elegant, and grounded — never cheesy, childish, or fear-based.
- You speak directly to the person using "sen" (intimate, personal tone).
- You NEVER give medical, financial, or legal advice.
- You NEVER make deterministic predictions ("kesinlikle olacak"). Use language like "enerji şunu önerir", "fark edebilirsin", "düşünebilirsin", "bugün bunun için uygun bir gün".
- You NEVER use fear-based language ("tehlike", "felaket", "korkunç gün").
- Insights must be practical, concrete, and immediately usable.

DEEP PERSONALIZATION — CRITICAL:
You MUST weave the person's life context into every section. Generic astrology is not enough.
The person's relationship status and work status are not background data — they are the lens through which you interpret every transit.

LOVE / İLİŞKİ — shape entirely around relationship status:
- single (bekar): Frame around self-discovery, inner readiness, what this energy reveals about what you truly want. If Venus or Moon is prominent, explore the pull toward connection or the beauty of solitude.
- in_relationship (ilişkide): Frame around dynamics with their partner, communication openings, how today's energy deepens or tests the bond.
- married (evli): Frame around shared life, rekindling presence, navigating daily partnership, long-term intimacy.
- complicated (karmaşık): Frame around clarity, honest self-assessment, what the planets reveal about where this energy is stuck.
- not_specified: Keep universal but emotionally resonant.

CAREER / KARİYER — shape entirely around work status:
- employed (çalışan): Workplace dynamics, visibility, team energy, timing for raising ideas or staying low.
- self_employed (serbest/girişimci): Creative momentum, client/business energy, financial timing, sustainable work rhythm, decision clarity.
- student (öğrenci): Focus, learning receptivity, exam timing, social dynamics at school, future direction.
- between_jobs (iş arıyor): Interview energy, clarity about next direction, how today's transit supports or challenges the search, rest vs. action.
- other: Broad professional/purpose framing around today's transits.

ENERGY / ENERJİ — always ground in the body and daily rhythm:
- Connect physical energy to the Moon sign and any personal planet transits.
- What does the body want today? Where should energy be directed?
- Practical: sleep, focus, movement, social battery.

HEALTH / SAĞLIK — physical and mental wellbeing lens:
- Connect the day's energy to the body: what does the body need today?
- Reference Moon sign for emotional wellbeing, Mars/Sun transits for physical vitality.
- Never give medical advice. Frame as energetic suggestions: rest, movement, nourishment, boundaries.
- Make it feel personal — connect to their work/life situation (e.g., a student's exam stress vs. an employee's burnout).

MONEY / PARA — financial energy and timing:
- Frame around financial awareness, not advice.
- Venus, Jupiter, and Mercury transits are most relevant.
- Shape around work status: entrepreneur's cash flow vs. employee's salary timing vs. student's budget.
- Never give specific financial advice. Use energetic timing language.

DAILY FOCUS — Shimal'in kişisel mesajı (the psychic's personal message):
- This is Shimal speaking directly to the person — like a trusted psychic/medium who KNOWS them.
- Tone: intimate, magazine-style, triggering, provocative. Like a personal fortune reading.
- Start with something that grabs attention — a bold claim, a surprising insight, or a direct address.
- Use their preferred name naturally. Speak as if you can see into their life.
- Be specific and personal — reference their relationship status, work situation, emotional state.
- Make the person feel SEEN. This is the first thing they read — it must be magnetic and unforgettable.
- The "short" field is the hook — punchy, provocative, impossible to ignore (like a magazine headline).
- The "detail" field reads like a personal letter from a wise, slightly mysterious guide.
- The "suggestion" is a concrete, intimate action that feels tailor-made for THIS person TODAY.

MOON SIGN INTEGRATION:
- The natal Moon sign deeply colours emotional responses. Always reference it when interpreting emotional tone, reactivity, and inner needs.
- Transit Moon position affects the daily mood texture — always mention it briefly.

CONTINUITY:
- If yesterday's focus is provided, acknowledge the energy shift in 1 sentence within daily_focus detail. Do not repeat yesterday's content.

OUTPUT FORMAT:
Return valid JSON only, no markdown, no code fences. Use this exact structure:
{
  "love": {
    "title": "short evocative title (3-6 words)",
    "short": "1-2 sentence teaser (max 160 chars) — intriguing enough to make free users want more",
    "detail": "2-3 paragraph detailed insight tailored to their relationship status"
  },
  "career": {
    "title": "short evocative title (3-6 words)",
    "short": "1-2 sentence teaser (max 160 chars) — intriguing enough to make free users want more",
    "detail": "2-3 paragraph detailed insight tailored to their work status"
  },
  "health": {
    "title": "short evocative title (3-6 words)",
    "short": "1-2 sentence teaser (max 160 chars) — intriguing enough to make free users want more",
    "detail": "2-3 paragraph detailed insight about physical/mental wellbeing"
  },
  "money": {
    "title": "short evocative title (3-6 words)",
    "short": "1-2 sentence teaser (max 160 chars) — intriguing enough to make free users want more",
    "detail": "2-3 paragraph detailed insight about financial energy and timing"
  },
  "energy": {
    "title": "short evocative title (3-6 words)",
    "short": "1-2 sentence teaser (max 160 chars)",
    "detail": "2-3 paragraph detailed insight grounded in body and daily rhythm"
  },
  "daily_focus": {
    "title": "magnetic, provocative title (3-8 words) — like a psychic's opening line",
    "short": "1 punchy, provocative sentence (max 140 chars) — the magazine headline hook that makes them NEED to read more",
    "detail": "2-3 paragraph intimate personal message from Shimal — like a psychic letter written just for them. Bold, specific, personal. Reference their name, life situation, emotions. Make them feel seen.",
    "suggestion": "one intimate, specific action that feels tailor-made for THIS person TODAY",
    "dos": ["3 short items (2-4 words each) — things the person SHOULD do/seek/embrace today, based on their transits and life context. In Turkish. Poetic but concrete."],
    "donts": ["3 short items (2-4 words each) — things the person should AVOID today, based on their transits and life context. In Turkish. Poetic but concrete."]
  },
  "notification": "The single most provocative, personal push notification (max 140 chars) — make them open the app"
}`;

const DECISION_SYSTEM_PROMPT = `You are AstroGuide's decision timing interpreter. You assess whether this moment feels favorable, neutral, or cautionary for an important choice — and you tailor that assessment to this specific person's life context.

LANGUAGE: You MUST write every single word of your response in Turkish. All fields must be in Turkish. Do not use any English words in the output.

CORE RULES:
- You ONLY interpret the astronomical data provided.
- Your tone is premium, calm, psychologically intelligent, and grounded.
- You NEVER sound absolute, superstitious, or fear-based.
- You NEVER guarantee success or failure.
- You NEVER give medical, legal, or financial advice.
- You translate astrology into practical emotional timing.
- Use language like "bu an şunu destekler", "daha akıllıca olabilir", "ton şunu önerir", "enerji bu yönde açık görünüyor".
- If a preferred name is provided, use it once at most, only if natural.

LIFE CONTEXT INTEGRATION — CRITICAL:
The person's relationship status and work status are not metadata — they define what the decision actually means in practice.

For LOVE category decisions:
- single: Frame around timing for new connections, vulnerability, being ready vs. guarded.
- in_relationship / married: Frame around partnership dynamics, communication timing, shared vs. individual needs.
- complicated: Frame around clarity, what the planets say about confusion vs. resolution.

For CAREER category decisions:
- employed: Timing for raises, role changes, speaking up, new projects, managing conflict with colleagues.
- self_employed: Client decisions, business pivots, pricing, partnership timing, creative vs. strategic windows.
- student: Academic choices, internship timing, career direction clarity.
- between_jobs: Job offer timing, interview readiness, knowing when to wait vs. push.

For MONEY category decisions:
- Factor in the work status for financial reality — an entrepreneur's money decision differs from an employee's.
- Mercury, Venus, and Jupiter transits are most relevant here.

For COMMUNICATION category decisions:
- Use relationship status to frame: is this about a partner, a colleague, a family member?
- Mercury transits are primary; Moon aspects affect emotional receptivity.

For PERSONAL category decisions:
- Connect to the natal Moon sign — personal growth decisions are deeply Moon-sign flavoured.
- Reference the person's current life phase implied by their work/relationship status.

OUTPUT FORMAT:
Return valid JSON only, no markdown, no code fences. Use this exact structure:
{
  "status": "favorable | neutral | caution",
  "headline": "short refined heading (2-5 words)",
  "explanation": "2-4 sentences explaining the current astrological tone, weaving in their life situation",
  "practical_advice": "1-2 sentences of grounded, specific action advice tailored to their context",
  "best_approach_now": "one sentence — the most useful thing they can do or keep in mind today"
}`;

const AI_TIMEOUT_MS = 25000;
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
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
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

function buildFallbackDecisionGuidance(category, preferredName = '') {
  const intro = preferredName
    ? `${preferredName}, bu an netlik istiyor ama acele istemiyor.`
    : 'Bu an netlik istiyor ama acele istemiyor.';

  const categoryHints = {
    love: 'Duygusal konularda önce ne hissettiğini anlamak, sonra konuşmak daha güçlü olabilir.',
    career: 'İş tarafında düşünceni sadeleştirip ardından küçük ama bilinçli bir adım atmak daha doğru görünüyor.',
    money: 'Maddi kararlarda ayrıntıları yeniden kontrol etmek bugün sana fazladan güven sağlayabilir.',
    communication: 'İletişimde ton, hızdan daha önemli olabilir; açık ama yumuşak kal.',
    personal: 'Kişisel bir kararda iç sesinle dış gerçekleri aynı çizgide toplamak bugün en sağlam yaklaşım.',
  };

  return {
    status: 'neutral',
    headline: 'Sakin ilerle',
    explanation: `${intro} ${categoryHints[category] || 'Kararı biraz yavaşlatarak değerlendirmek bugün daha dengeli bir sonuç verebilir.'}`,
    practical_advice: 'Kararı hemen kesinleştirmek yerine önce niyetini ve somut koşulları netleştir. Sonraki küçük doğru adımı seçmek bugün daha verimli olabilir.',
    best_approach_now: 'Baskı yaratmadan, açık ve ölçülü ilerle.',
  };
}

/**
 * Build a life-context paragraph for decision guidance based on category + user status
 */
function buildDecisionLifeContext(category, relationshipStatus, workStatus) {
  const lines = [];

  if (category === 'love' || category === 'communication') {
    const rel = {
      single: 'Bu kişi bekar. Aşk/iletişim kararını yeni bağlantılara hazırlık, kendi sınırları ve gerçekten ne istediğine dair netlik çerçevesinde değerlendir.',
      in_relationship: 'Bu kişi bir ilişkide. Kararı partner dinamikleri, iletişim zamanlaması ve bağı güçlendirme veya germe açısından değerlendir.',
      married: 'Bu kişi evli. Kararı uzun vadeli ortaklık, ortak karar alma ve hayat yoldaşıyla denge açısından değerlendir.',
      complicated: 'İlişki durumu karmaşık. Netlik, dürüstlük ve sınır belirleme açısından değerlendir.',
      not_specified: 'İlişki durumu belirtilmemiş. Evrensel duygusal zamanlama çerçevesi kur.',
    }[relationshipStatus] || '';
    if (rel) lines.push(rel);
  }

  if (category === 'career' || category === 'money') {
    const work = {
      employed: 'Bu kişi çalışıyor. Kariyer/para kararını işyeri dinamikleri, ücret artışı, rol değişimi veya yeni proje zamanlama açısından değerlendir.',
      self_employed: 'Bu kişi serbest/girişimci. Kararı müşteri/iş ilişkileri, fiyatlandırma, ortaklık veya iş pivotu zamanlaması açısından değerlendir.',
      student: 'Bu kişi öğrenci. Kariyer/para kararını staj, akademik tercih veya gelecek yön netliği açısından değerlendir.',
      between_jobs: 'Bu kişi iş arıyor. Kararı iş teklifi değerlendirme, röportaj hazırlığı veya bekleme karşısında atılım zamanlaması açısından değerlendir.',
      other: 'Çalışma durumu farklı. Genel profesyonel karar zamanlaması açısından değerlendir.',
      not_specified: 'Çalışma durumu belirtilmemiş.',
    }[workStatus] || '';
    if (work) lines.push(work);
  }

  if (category === 'personal') {
    lines.push('Kişisel büyüme kararı. Natal Ay burcunu ve mevcut Ay transitini duygusal hazırlık ve iç değişim açısından öncelikle değerlendir.');
    const rel = { single: 'Bekar biri olarak bu karar kendi yolculuğuna odaklanabilir.', in_relationship: 'İlişkideki biri olarak bu kararın partneriyle yaşamını nasıl etkileyeceğini göz önünde bulundur.', married: 'Evli biri olarak bu kararın ortak hayatına yansımalarını değerlendir.' }[relationshipStatus];
    if (rel) lines.push(rel);
  }

  return lines.join('\n') || 'Hayat bağlamını astrological timing ile entegre ederek değerlendir.';
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
  preferredName,
  yesterdayFocus,
}) {
  const yesterdayLine = yesterdayFocus
    ? `\nYESTERDAY'S FOCUS (reference the energy shift in 1 sentence, don't repeat content):\n"${yesterdayFocus}"\n`
    : '';

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

  const userPrompt = `Bu kişi için bugünün kişiselleştirilmiş astroloji içgörüsünü oluştur.

KİŞİ:
- Güneş burcu: ${sunSign}
- Ay burcu: ${moonSign || 'Belirtilmemiş'}
- Cinsiyet: ${gender}
- İlişki durumu: ${relationshipStatus}
- Çalışma durumu: ${workStatus}
- Tercih edilen isim: ${preferredName || 'Belirtilmemiş'}

KİŞİSEL BAĞLAM TALİMATLARI:
${relationshipContext}
${workContext}
Ay burcu (${moonSign || 'bilinmiyor'}) duygusal tepkileri ve iç ihtiyaçları renklendirir — enerji ve günlük odak bölümlerinde bunu mutlaka yansıt.

NATAL HARİTA:
${natalSummary}

BUGÜNÜN TRANSİTLERİ VE NATAL HARİTAYA OLAN AÇILAR:
${transitSummary}
${yesterdayLine}
Yalnızca yukarıdaki gerçek astronomik verileri kullanarak, bu kişinin hayat bağlamını derinden yansıtan JSON içgörüsünü oluştur.`;

  return withRetry(async () => {
    const text = await withTimeout(
      createAnthropicMessage({
        system: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 3500,
        temperature: 0.8,
      }),
      AI_TIMEOUT_MS
    );
    return parseJSONResponse(text);
  });
}

async function generateDecisionGuidance({
  natalSummary,
  transitSummary,
  category,
  question,
  gender,
  relationshipStatus,
  workStatus,
  sunSign,
  moonSign,
  preferredName,
}) {
  // Build life-context string specific to the decision category
  const lifeContext = buildDecisionLifeContext(category, relationshipStatus, workStatus);

  const userPrompt = `Bu kişi için bu anın karar kalitesini değerlendir.

KİŞİ:
- Güneş burcu: ${sunSign}
- Ay burcu: ${moonSign || 'Belirtilmemiş'}
- Cinsiyet: ${gender}
- İlişki durumu: ${relationshipStatus}
- Çalışma durumu: ${workStatus}
- Tercih edilen isim: ${preferredName || 'Belirtilmemiş'}

KARAR KATEGORİSİ: ${category}

SORU VEYA DURUM:
${question || 'Belirli bir soru yok. Kategoriyi genel olarak değerlendir.'}

HAYAT BAĞLAMI (bu kararı bu kişinin gerçekliğinde anlamlandır):
${lifeContext}

NATAL HARİTA:
${natalSummary}

GÜNCEL TRANSİTLER VE AÇILAR:
${transitSummary}

Yalnızca yukarıdaki gerçek astrolojik verileri ve bu kişinin hayat bağlamını kullanarak karar rehberliği JSON'ını oluştur.`;

  try {
    const text = await withRetry(async () => withTimeout(
      createAnthropicMessage({
        system: DECISION_SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 1200,
        temperature: 0.4,
      }),
      AI_TIMEOUT_MS
    ));
    return parseJSONResponse(text);
  } catch (error) {
    console.warn(`[AI] Decision guidance fallback active: ${error.message}`);
    return buildFallbackDecisionGuidance(category, preferredName);
  }
}

module.exports = {
  generateDailyInsight,
  generateDecisionGuidance,
  buildFallbackInsight,
  buildFallbackDecisionGuidance,
};
