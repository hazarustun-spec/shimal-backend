'use strict';

const https = require('https');
const { writeJson, internalError } = require('../utils/http');

// ─── NOAA API endpoints (free, no API key needed) ────────────────────────────
const NOAA_KP_URL = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';

// ─── In-memory cache (refresh every 30 min) ──────────────────────────────────
let cachedData = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

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

// ─── Kp → Sleep impact mapping ───────────────────────────────────────────────
function getSleepImpact(kp) {
  const kpNum = parseFloat(kp);

  if (kpNum <= 1) return {
    level: 'sakin',
    levelEn: 'quiet',
    stormCategory: null,
    color: '#4CAF50',
    emoji: '😴',
    sleepQuality: 'çok_iyi',
    sleepScore: 95,
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
    sleepScore: 85,
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
    sleepScore: 70,
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
    sleepScore: 55,
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
    sleepScore: 35,
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
    sleepScore: 20,
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
    const lat = parseFloat(url.searchParams.get('lat') || '39.9'); // Default: Ankara
    const lon = parseFloat(url.searchParams.get('lon') || '32.8');

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
          writeJson(res, 503, { error: 'Jeomanyetik veri şu an alınamıyor. Lütfen daha sonra tekrar deneyin.' });
          return;
        }
        // Use stale cache
      }
    }

    // Parse NOAA data — array of arrays, first row is header
    // Format: ["time_tag", "Kp", "Kp_fraction", "a_running", "station_count"]
    const rows = cachedData.slice(1); // Skip header
    if (rows.length === 0) {
      writeJson(res, 503, { error: 'NOAA verisinde kayıt bulunamadı.' });
      return;
    }

    // Get latest and last 8 entries (24 hours, 3h intervals)
    const latest = rows[rows.length - 1];
    const last24h = rows.slice(-8);

    const currentKp = parseFloat(latest[1]);
    const maxKp24h = Math.max(...last24h.map(r => parseFloat(r[1])));
    const avgKp24h = last24h.reduce((sum, r) => sum + parseFloat(r[1]), 0) / last24h.length;

    // Calculate sleep impact
    const sleepImpact = getSleepImpact(currentKp);
    const latitudeImpact = getLatitudeImpact(lat);

    // Adjust sleep score based on latitude
    const adjustedScore = Math.max(5, Math.min(100,
      Math.round(sleepImpact.sleepScore * (2 - latitudeImpact.factor))
    ));

    // Build 24h history for chart
    const history = last24h.map(row => ({
      time: row[0],
      kp: parseFloat(row[1]),
    }));

    // Tonight forecast (simple: use trend)
    const recentTrend = rows.length >= 2
      ? parseFloat(rows[rows.length - 1][1]) - parseFloat(rows[rows.length - 2][1])
      : 0;

    let tonightForecast = 'sakin';
    if (currentKp >= 5 || recentTrend > 1) tonightForecast = 'fırtınalı';
    else if (currentKp >= 3 || recentTrend > 0.5) tonightForecast = 'aktif';

    const response = {
      timestamp: new Date().toISOString(),
      location: { latitude: lat, longitude: lon },

      current: {
        kp: currentKp,
        time: latest[0],
        stationCount: parseInt(latest[4] || '0'),
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
