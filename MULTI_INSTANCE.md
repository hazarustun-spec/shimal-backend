# Multi-Instance Deployment Notes

Shimal backend şu anda **single-instance** olarak Railway'de çalışıyor. Multi-instance'a geçişte bilinmesi gereken trade-off'ları ve ne yapıldığını özetler.

## 🟢 Multi-instance'ta Çalışan Güvenlik Kontrolleri

Bu state'ler Supabase'de persist ediliyor → tüm instance'lar aynı state'i paylaşıyor:

| Kontrol | Nerede | Tablo |
|---|---|---|
| OTP brute-force lockout | `utils/rate-limit.js` | `otp_lockouts` |
| Cron key brute-force lockout | `utils/http.js` | `cron_key_failures` |
| Cron job distributed lock | `utils/cron-lock.js` | `cron_locks` |
| Session tokens | `utils/session-token.js` | `users.session_token_hash` |

Yukarıdaki kontroller **instance sayısından bağımsız** doğru çalışır. Restart-a-deploy saldırısı yok.

## 🟡 Multi-instance'ta Best-Effort Olan Kontroller

Bu state'ler in-memory — her instance kendi sayacını tutar:

| Kontrol | Nerede | Neden Persist Edilmedi |
|---|---|---|
| IP rate limit (60 req/dk vs.) | `utils/rate-limit.js` → `stores` Map | Her request için DB write çok pahalı (~50ms latency) |
| Device rate limit | `utils/rate-limit.js` → `deviceStores` Map | Aynı neden |
| Bot detection (IP → device set) | `utils/rate-limit.js` → `ipDeviceMap` | Heuristic; kısa pencere (5dk) |
| /24 subnet OTP limit | `utils/rate-limit.js` → `subnetOtpStore` | Düşük frekans ama yine de per-request |

### Multi-instance etkileri

Eğer N instance varsa:
- IP başına gerçek limit ≈ `tier.max × N`. Örneğin STRICT (3/dk) → 2 instance'ta attacker IP başına ~6/dk yapabilir.
- Attacker aynı IP'den request'lerini farklı instance'lara yönlendiremez (Railway load balancer sticky değil ama 60s pencerede birkaç instance'a dağılabilir).
- Bot detection'da aynı IP farklı instance'larda farklı device set'leri görür → botnet tespiti geç kalabilir.

**Değerlendirme**: Kritik güvenlik kontrolleri (OTP lockout, session token) persist, kaba rate limit'ler best-effort. Tipik saldırı için "2 instance × 3 req/dk = 6 req/dk" hâlâ kabul edilebilir.

## 🔴 Multi-instance'a Geçiş Kontrol Listesi

Railway Pro plan'a geçip N > 1 instance çalıştırmak istersen:

### Zorunlu adımlar
1. **SQL migration'ları çalıştır** (henüz yapılmadıysa):
   - `sql/001_otp_lockouts.sql`
   - `sql/002_cron_locks.sql`
   - `sql/003_session_tokens.sql`
   - `sql/004_enable_rls_all_tables.sql`
   - `sql/005_cron_key_failures.sql`

2. **Session secret consistency** — Tüm instance'larda `SHIMAL_SESSION_SECRET` ENV var'ı AYNI olmalı (Railway shared variables kullan).

3. **Cron job uniqueness** — `cron-lock.js` zaten distributed lock uyguluyor; her cron job sadece bir instance'ta çalışır.

### Opsiyonel iyileştirmeler

**Redis entegrasyonu** (rate limit presisyonu için):

```bash
# Railway'de Redis add-on ekle
# REDIS_URL env var otomatik set edilir
```

Sonra `utils/rate-limit.js`'i Redis INCR/EXPIRE ile güncelle:

```javascript
const redis = require('redis');
const client = redis.createClient({ url: process.env.REDIS_URL });

async function checkIpRateLimitRedis(ip, tier) {
  const key = `rl:${tier}:${ip}`;
  const count = await client.incr(key);
  if (count === 1) await client.expire(key, tier.windowMs / 1000);
  return count <= tier.max;
}
```

Bu ~1-2ms latency ekler (Supabase ~50ms'ye göre 25x daha hızlı).

### Sticky session (opsiyonel)

Railway'de sticky session yoksa da sorun değil — session token'lar stateless (DB'de). Ama cron lock + OTP lockout zaten instance-agnostic olduğu için sticky gerekmiyor.

## 📊 Özet

| Özellik | Single | Multi (N instance, no Redis) | Multi + Redis |
|---|---|---|---|
| OTP brute-force | ✅ | ✅ | ✅ |
| Session tokens | ✅ | ✅ | ✅ |
| Cron jobs | ✅ | ✅ | ✅ |
| IP rate limit | ✅ kesin | ⚠️ ~N× gevşek | ✅ kesin |
| Bot detection | ✅ | ⚠️ kısmi | ✅ |
| Cron key lockout | ✅ | ✅ | ✅ |

**Öneri**: Kullanıcı sayısı 10k altındaysa single instance yeterli. Üzerine çıkarsan Railway Pro + Redis ekle.
