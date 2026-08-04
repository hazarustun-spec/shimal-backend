# Secret rotasyonu — Ağustos 2026

`railway variables` çıktısı bir konuşma kaydına düştüğü için aşağıdaki
değerlerin tamamı yanmış sayılır. Ayrıca üçünde değerin kendisi de yanlıştı.

Sıra önemli: **3 → 1 → 2**. Supabase anahtarı en riskli olan, OneSignal ise
tek başına deploy gerektirmiyor.

Her `railway variable set` sonrası **`railway redeploy`** gerekiyor.
`railway restart` YETMEZ — deployment'ın env anlık görüntüsünü koruyor.

---

## 1. SHIMAL_SESSION_SECRET

**Sorun:** değeri, sızmış eski API anahtarına (`3b1575…f22846`) sabitlenmişti.
Legacy HMAC oturum token'ı bu secret'tan türetildiği için, değeri bilen herkes
herhangi bir cihaz için geçerli token üretebiliyordu.

**Kod tarafı çözüldü** (commit `e55b840`): legacy HMAC doğrulaması tamamen
kaldırıldı. Artık bu secret oturum doğrulamasında kullanılmıyor.

Geriye tek kullanımı kaldı: `crash-report.js:16` bunu cihaz kimliklerini
sözde-anonimleştirmek için salt olarak kullanıyor. Rotasyon yalnızca bundan
sonraki kaza raporlarının pseudonym'lerini değiştirir — eski raporlarla
eşleşme kaybolur, başka etkisi yok.

```bash
railway variable set SHIMAL_SESSION_SECRET="$(openssl rand -hex 32)"
railway redeploy --yes
```

## 2. ONESIGNAL_API_KEY

**Sorun:** değer literal `your-onesignal-rest-api-key` — `.env.example`'dan
kopyalanıp doldurulmamış. Yani push bildirimleri üretimde **hiç çalışmıyor**.

App Store açıklamasında "Her sabah bildirim" vaadi var ve inceleme sırasında
test edilebilir; gönderimden önce düzeltilmeli.

`ONESIGNAL_APP_ID` (`d91f48df-…`) gerçek görünüyor, ona dokunma.

1. onesignal.com → Shimal uygulaması → **Settings → Keys & IDs**
2. **REST API Key**'i kopyala

```bash
railway variable set ONESIGNAL_API_KEY="<rest-api-key>"
railway redeploy --yes
```

Doğrulama: bir bildirim tetikle ve Railway loglarına bak.
- `[Push] Sent to …` → çalışıyor
- `[Push] OneSignal reddetti (HTTP 401)` → anahtar hâlâ yanlış
- `[Push] OneSignal yapılandırılmamış …` → placeholder hâlâ duruyor

(Bu iki log satırı `e55b840` ile eklendi. Öncesinde başarısız çağrılar da
"Sent" olarak loglanıyordu, arızanın fark edilmeme sebebi buydu.)

## 3. SUPABASE_SERVICE_KEY — en riskli

**Sorun:** değer `sb_publishable_H10Ik…` ile başlıyor. Bu, tarayıcıya
konulmak üzere tasarlanmış **anon/publishable** anahtar; gizli sayılmaz ve
Row Level Security'ye tabidir. Servis anahtarı `sb_secret_` (yeni format) veya
`eyJ…` (legacy JWT service_role) ile başlar.

Backend bu anahtarla çalışabildiğine göre `users` tablosunda RLS ya kapalı ya
da çok geniş. Bu durumda herkese açık olması tasarlanmış bir anahtar tüm
kullanıcı tablosuna (e-posta, doğum verisi, push token) erişiyor demektir.

**Önce teşhis** — Supabase → Table Editor → `users` → RLS durumuna bak.

Ya da dışarıdan dene (satır okumadan, yalnızca sayım):

```bash
curl -s -D- -o /dev/null \
  -H "apikey: <publishable-key>" \
  -H "Prefer: count=exact" -H "Range: 0-0" \
  "https://cfwynqoyvbaqawvujypj.supabase.co/rest/v1/users?select=id" \
  | grep -i "content-range\|^HTTP"
```

- `HTTP/2 200` + `content-range: 0-0/<sayı>` → **tablo dışarıdan okunabiliyor,
  acil.** RLS kapalı demektir.
- `401` / `content-range: */0` → RLS koruyor, yalnızca anahtar tipi yanlış.

**Düzeltme:**

1. Supabase → **Settings → API Keys** → secret (`service_role`) anahtarını al
2. Railway'e yaz:
   ```bash
   railway variable set SUPABASE_SERVICE_KEY="<sb_secret_...>"
   railway redeploy --yes
   ```
3. Yukarıdaki teşhis 200 döndüyse: `users` (ve diğer tablolar) için RLS'i aç.
   Backend `service_role` ile RLS'i baypas eder, yani politika yazmaya gerek
   yok — uygulama Supabase'e doğrudan hiç bağlanmıyor, her şey backend
   üzerinden geçiyor.
4. Eski publishable anahtarı Supabase panelinden döndür (rotate).

Deploy sonrası boot logunda şu satır **görünmemeli**:

```
[Startup] UYARI: SUPABASE_SERVICE_KEY bir publishable/anon anahtar gibi görünüyor
```

---

## Rotasyona girmeyen (bilinçli)

**DASHBOARD_SECRET** — değeri `shimal-admin-2026`, tahmin edilebilir ve
dashboard token'ı bununla HMAC'leniyor (`dashboard.js:46`). Dashboard kullanıcı
listesini e-posta ve push token ile döndürüyor. Kullanıcı isteğiyle bu turda
dokunulmadı; ele alınınca `openssl rand -hex 32` yeterli.

## Sonrası

- `SHIMAL_API_KEY` bu kayıtta göründü. Ama zaten her IPA'nın içinde gidiyor,
  yani hiçbir zaman gizli değildi — gerçek koruma oturum token'ında. Yine de
  değiştirilirse yeni bir iOS build gerekir (`AppConfig.swift` 4 parçalı).
- `CRON_API_KEY` ve `REVENUECAT_WEBHOOK_SECRET` de kayda düştü. İkisi de
  gerçek secret; rotasyonu ucuz:
  ```bash
  railway variable set CRON_API_KEY="$(openssl rand -hex 32)"
  railway variable set REVENUECAT_WEBHOOK_SECRET="$(openssl rand -hex 32)"
  railway redeploy --yes
  ```
  REVENUECAT_WEBHOOK_SECRET değişirse RevenueCat → Integrations → Webhooks
  altındaki Authorization header'ı da güncellenmeli, yoksa webhook 401 alır.
- `API_KEY_ENFORCE` kodda karşılığı olmayan ölü değişken, silinebilir:
  `railway variable delete API_KEY_ENFORCE`
