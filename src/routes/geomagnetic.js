'use strict';

const https = require('https');
const { writeJson, internalError, badRequest } = require('../utils/http');
const { isValidLatitude, isValidLongitude } = require('../utils/validate');

// ─── NOAA API endpoints (free, no API key needed) ────────────────────────────
const NOAA_KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

// ─── In-memory cache (refresh every 30 min) ──────────────────────────────────
let cachedData = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// ─── Static fallback when NOAA is completely unavailable ─────────────────────
// Represents a calm day (Kp ~1.5) so the app still functions
// Uses new NOAA object format: { time_tag, Kp, a_running, station_count }
const NOAA_FALLBACK = Array.from({ length: 8 }, (_, i) => {
  const d = new Date(Date.now() - (7 - i) * 3 * 60 * 60 * 1000);
  return {
    time_tag: d.toISOString(),
    Kp: 1.5,
    a_running: 3,
    station_count: 10,
  };
});

// ─── Normalize NOAA rows ──────────────────────────────────────────────────────
// NOAA değiştirdi: eskiden array-of-arrays (header + rows), artık array-of-objects.
// Her iki formatı da destekle.
function normalizeRows(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const first = raw[0];

  // Yeni format: array of objects { time_tag, Kp, ... }
  if (typeof first === 'object' && !Array.isArray(first) && first !== null) {
    return raw.map(r => ({
      time_tag: r.time_tag || '',
      kp: parseFloat(r.Kp ?? r.kp ?? 0),
      stationCount: parseInt(r.station_count ?? 0, 10),
    }));
  }

  // Eski format: first row is header, rest are data arrays
  // ["time_tag", "Kp", "Kp_fraction", "a_running", "station_count"]
  const dataRows = Array.isArray(first) && typeof first[0] === 'string' && isNaN(parseFloat(first[1]))
    ? raw.slice(1)  // skip header row
    : raw;

  return dataRows.map(r => ({
    time_tag: r[0] || '',
    kp: parseFloat(r[1] ?? 0),
    stationCount: parseInt(r[4] ?? 0, 10),
  }));
}

// ─── Fetch JSON from NOAA ────────────────────────────────────────────────────
function fetchNoaaKp() {
  return new Promise((resolve, reject) => {
    https.get(NOAA_KP_URL, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Failed to parse NOAA response'));
        }
      });
    }).on('error', reject);
  });
}

// ─── Kp → Sürekli uyku skoru ────────────────────────────────────────────────
// Anchor noktaları arası lineer interpolasyon — her Kp değeri farklı skor üretir.
// Ör: Kp 1.0→95, Kp 1.5→91, Kp 2.0→88, Kp 2.5→84, Kp 3.0→80
function computeSleepScore(kp) {
  const anchors = [
    [0, 100],
    [1, 95],
    [3, 80],
    [4, 65],
    [5, 48],
    [7, 28],
    [9, 10],
  ];

  if (kp <= anchors[0][0]) return anchors[0][1];
  if (kp >= anchors[anchors.length - 1][0]) return anchors[anchors.length - 1][1];

  for (let i = 0; i < anchors.length - 1; i++) {
    const [x0, y0] = anchors[i];
    const [x1, y1] = anchors[i + 1];
    if (kp >= x0 && kp <= x1) {
      const t = (kp - x0) / (x1 - x0);
      return Math.round(y0 + t * (y1 - y0));
    }
  }
  return 50;
}

// ─── Kp → Sleep impact mapping ───────────────────────────────────────────────
function getSleepImpact(kp) {
  const kpNum = parseFloat(kp);
  const sleepScore = computeSleepScore(kpNum);

  if (kpNum <= 1) return {
    level: 'sakin',
    levelEn: 'quiet',
    stormCategory: null,
    color: '#4CAF50',
    emoji: '😴',
    sleepQuality: 'çok_iyi',
    sleepScore,
    title: 'Kozmik Sessizlik',
    message: 'Manyetik alan tamamen sakin. Derin ve dinlendirici bir uyku için ideal gece.',
    advice: 'Bu geceyi değerlendir — vücudun en derin REM döngülerine ulaşabilir.',
    tips: [
      'Normal uyku saatine sadık kal',
      'Uyumadan önce 15 dakika nefes egzersizi yap',
      'Karanlık ve sessiz bir ortam hazırla'
    ]
  };

  if (kpNum <= 3) return {
    level: 'hafif',
    levelEn: 'light',
    stormCategory: null,
    color: '#8BC34A',
    emoji: '🌙',
    sleepQuality: 'iyi',
    sleepScore,
    title: 'Hafif Kozmik Aktivite',
    message: 'Manyetik alanda küçük dalgalanmalar var ama uyku kaliteni etkilemeyecek seviyede.',
    advice: 'Rahat bir gece geçireceksin. Rüyaların biraz daha canlı olabilir.',
    tips: [
      'Yatmadan 1 saat önce ekranları kapat',
      'Hafif bir bitki çayı iç',
      'Uyku düzenini koru'
    ]
  };

  if (kpNum <= 4) return {
    level: 'aktif',
    levelEn: 'active',
    stormCategory: null,
    color: '#FFC107',
    emoji: '⚡',
    sleepQuality: 'orta',
    sleepScore,
    title: 'Aktif Manyetik Alan',
    message: 'Dünya\'nın manyetik alanı normalden aktif. Hassas kişilerde uyku kalitesi düşebilir.',
    advice: 'Uykuya geçiş biraz uzayabilir. Gevşeme teknikleri uygula.',
    tips: [
      'Yatmadan 2 saat önce kafein alma',
      'Lavanta yağı veya magnezyum takviyesi düşün',
      'Meditasyon veya progresif kas gevşetme dene',
      'Oda sıcaklığını 18-20°C arasında tut'
    ]
  };

  if (kpNum <= 5) return {
    level: 'fırtına',
    levelEn: 'storm',
    stormCategory: 'G1',
    color: '#FF9800',
    emoji: '🌩',
    sleepQuality: 'düşük',
    sleepScore,
    title: 'Jeomanyetik Fırtına (G1)',
    message: 'Küçük çaplı jeomanyetik fırtına aktif. Uyku döngülerin bozulabilir, gece uyanmaları olası.',
    advice: 'Bu gece normalden 30 dakika erken yat. Vücudunun ekstra dinlenmeye ihtiyacı var.',
    tips: [
      'Normalden 30 dakika erken yat',
      'Magnezyum takviyesi al',
      'Ağır yemeklerden kaçın',
      'Mavi ışık filtresi kullan',
      'Uyandığında endişelenme — bu kozmik, geçici'
    ]
  };

  if (kpNum <= 7) return {
    level: 'güçlü_fırtına',
    levelEn: 'strong_storm',
    stormCategory: kpNum <= 6 ? 'G2' : 'G3',
    color: '#F44336',
    emoji: '🔴',
    sleepQuality: 'çok_düşük',
    sleepScore,
    title: `Güçlü Jeomanyetik Fırtına (${kpNum <= 6 ? 'G2' : 'G3'})`,
    message: 'Güçlü jeomanyetik fırtına yaşanıyor. Uyku kalitesi ciddi şekilde etkilenebilir. Baş ağrısı, huzursuzluk ve gece uyanmaları olası.',
    advice: 'Bu gece sabırlı ol. Uyuyamazsan zorla — kalk, kitap oku, tekrar dene.',
    tips: [
      '1 saat erken yat',
      'Kafein ve alkol kesinlikle alma',
      'Sıcak duş al (vücut sıcaklığı düşüşü uykuyu tetikler)',
      'Beyaz gürültü veya doğa sesleri aç',
      'Uyuyamazsan zorlanma, 20 dakika sonra tekrar dene',
      'Yarın gün içinde 20 dakika şekerleme yapabilirsin'
    ]
  };

  // Kp 8-9: Extreme
  return {
    level: 'aşırı_fırtına',
    levelEn: 'extreme_storm',
    stormCategory: kpNum <= 8 ? 'G4' : 'G5',
    color: '#9C27B0',
    emoji: '🟣',
    sleepQuality: 'çok_düşük',
    sleepScore,
    title: `Aşırı Jeomanyetik Fırtına (${kpNum <= 8 ? 'G4' : 'G5'})`,
    message: 'Nadir görülen şiddetli jeomanyetik fırtına! Dünya çapında uyku kalitesi etkileniyor. Baş ağrısı, anksiyete ve uykusuzluk yaygın.',
    advice: 'Bu çok nadir bir kozmik olay. Kendine nazik davran, yarın daha iyi olacak.',
    tips: [
      'Beklentilerini düşür — bu gece kaliteli uyku zor',
      'Rahatlatıcı müzik veya meditasyon dinle',
      'Sıcak duş + magnezyum + karanlık oda',
      'Gece uyanırsan panik yapma — tüm dünya aynı etkide',
      'Yarın hafif tempo ile geçir',
      'Bol su iç'
    ]
  };
}

// ─── Get latitude zone impact ────────────────────────────────────────────────
function getLatitudeImpact(latitude) {
  const absLat = Math.abs(latitude);
  if (absLat >= 60) return { zone: 'kutup', factor: 1.5, note: 'Kutup bölgesinde jeomanyetik etki çok güçlü hissedilir.' };
  if (absLat >= 45) return { zone: 'yüksek_enlem', factor: 1.25, note: 'Yüksek enlemde jeomanyetik aktivite daha belirgin hissedilir.' };
  if (absLat >= 30) return { zone: 'orta_enlem', factor: 1.0, note: 'Orta enlemde standart etki beklenir.' };
  return { zone: 'düşük_enlem', factor: 0.75, note: 'Ekvatora yakın bölgelerde jeomanyetik etki daha az hissedilir.' };
}

// ─── Main handler ────────────────────────────────────────────────────────────
async function handleGeomagnetic(req, res, _params, url) {
  try {
    // Parametre validation — lat/lon float range kontrolü (şekil bozuk = 400)
    const rawLat = url.searchParams.get('lat');
    const rawLon = url.searchParams.get('lon');
    const lat = rawLat !== null ? parseFloat(rawLat) : 39.9; // Default: Ankara
    const lon = rawLon !== null ? parseFloat(rawLon) : 32.8;

    if (rawLat !== null && !isValidLatitude(lat)) {
      return badRequest(res, 'Geçersiz enlem (-90 ile 90 arası olmalı)');
    }
    if (rawLon !== null && !isValidLongitude(lon)) {
      return badRequest(res, 'Geçersiz boylam (-180 ile 180 arası olmalı)');
    }

    // Fetch NOAA data (with cache)
    const now = Date.now();
    if (!cachedData || now - cacheTimestamp > CACHE_TTL_MS) {
      try {
        cachedData = await fetchNoaaKp();
        cacheTimestamp = now;
        console.log('[Geomagnetic] NOAA data refreshed');
      } catch (fetchErr) {
        console.error('[Geomagnetic] NOAA fetch failed:', fetchErr.message);
        if (!cachedData) {
          console.warn('[Geomagnetic] No cache available, using static fallback data');
          cachedData = NOAA_FALLBACK;
          // Don't update cacheTimestamp so we retry NOAA on next request
        }
        // Use stale/fallback cache
      }
    }

    // Normalize rows — handles both old array format and new object format
    let rows = normalizeRows(cachedData);
    if (rows.length === 0) {
      console.warn('[Geomagnetic] Empty rows after normalize, using fallback data');
      rows = normalizeRows(NOAA_FALLBACK);
    }

    // Get latest and last 8 entries (24 hours, 3h intervals)
    const latest = rows[rows.length - 1];
    const last24h = rows.slice(-8);

    const currentKp = latest.kp;
    const maxKp24h = Math.max(...last24h.map(r => r.kp));
    const avgKp24h = last24h.reduce((sum, r) => sum + r.kp, 0) / last24h.length;

    // Calculate sleep impact
    const sleepImpact = getSleepImpact(currentKp);
    const latitudeImpact = getLatitudeImpact(lat);

    // Adjust sleep score based on latitude
    const adjustedScore = Math.max(5, Math.min(100,
      Math.round(sleepImpact.sleepScore * (2 - latitudeImpact.factor))
    ));

    // Build 24h history for chart
    const history = last24h.map(row => ({
      time: row.time_tag,
      kp: row.kp,
    }));

    // Tonight forecast (simple: use trend)
    const recentTrend = rows.length >= 2
      ? rows[rows.length - 1].kp - rows[rows.length - 2].kp
      : 0;

    let tonightForecast = 'sakin';
    if (currentKp >= 5 || recentTrend > 1) tonightForecast = 'fırtınalı';
    else if (currentKp >= 3 || recentTrend > 0.5) tonightForecast = 'aktif';

    const response = {
      timestamp: new Date().toISOString(),
      location: { latitude: lat, longitude: lon },

      current: {
        kp: currentKp,
        time: latest.time_tag,
        stationCount: latest.stationCount,
      },

      last24h: {
        maxKp: Math.round(maxKp24h * 10) / 10,
        avgKp: Math.round(avgKp24h * 10) / 10,
        history,
      },

      sleep: {
        ...sleepImpact,
        adjustedScore,
        latitudeZone: latitudeImpact.zone,
        latitudeNote: latitudeImpact.note,
      },

      tonight: {
        forecast: tonightForecast,
        forecastLabel: tonightForecast === 'fırtınalı' ? 'Fırtınalı Gece' : tonightForecast === 'aktif' ? 'Aktif Gece' : 'Sakin Gece',
      },
    };

    writeJson(res, 200, response);
  } catch (error) {
    internalError(res, error, '[Geomagnetic] Error:', 'Jeomanyetik veri işlenirken hata oluştu.');
  }
}

module.exports = [
  ['GET', /^\/api\/geomagnetic$/, handleGeomagnetic],
];
