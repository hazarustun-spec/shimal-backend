'use strict';

const { toTR, ZODIAC_TR } = require('../src/utils/zodiac-tr');
const { isValidDeviceId, isValidBirthDate, isValidBirthTime, isValidPhone, isValidOtp, isValidText } = require('../src/utils/validate');
const { keyMatches, checkOwnership } = require('../src/utils/http');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

// ─── Zodiac Translation ──────────────────────────────────────────────────────
console.log('\n--- zodiac-tr ---');
assert(toTR('Aries') === 'Koç', 'Aries → Koç');
assert(toTR('Virgo') === 'Başak', 'Virgo → Başak');
assert(toTR('Pisces') === 'Balık', 'Pisces → Balık');
assert(toTR('Gemini') === 'İkizler', 'Gemini → İkizler');
assert(toTR('Unknown') === 'Unknown', 'Unknown stays Unknown');
assert(Object.keys(ZODIAC_TR).length === 12, '12 zodiac signs defined');

// ─── Validation ──────────────────────────────────────────────────────────────
console.log('--- validate ---');
// DeviceId
assert(isValidDeviceId('AAAABBBB-1111-2222-3333-444455556666'), 'valid UUID deviceId');
assert(isValidDeviceId('8E5BCF7E-42B6-4433-8834-6FE5919A27CE'), 'valid uppercase UUID');
assert(!isValidDeviceId(''), 'empty deviceId rejected');
assert(!isValidDeviceId('abc'), 'too short deviceId rejected');
assert(!isValidDeviceId('hello world!'), 'special chars rejected');

// BirthDate
assert(isValidBirthDate('1995-03-15'), 'valid birthDate');
assert(isValidBirthDate('2000-01-01'), 'year 2000 valid');
assert(!isValidBirthDate('1800-01-01'), 'year 1800 rejected');
assert(!isValidBirthDate('2099-01-01'), 'future date rejected');
assert(!isValidBirthDate('not-a-date'), 'non-date rejected');
assert(!isValidBirthDate(''), 'empty rejected');

// BirthTime
assert(isValidBirthTime('14:30'), 'valid time');
assert(isValidBirthTime('00:00'), 'midnight valid');
assert(isValidBirthTime('23:59'), '23:59 valid');
assert(!isValidBirthTime('25:00'), 'hour 25 rejected');
assert(!isValidBirthTime('12:60'), 'minute 60 rejected');
assert(!isValidBirthTime('abc'), 'non-time rejected');

// Phone
assert(isValidPhone('+905551234567'), 'Turkish phone valid');
assert(isValidPhone('5551234567'), 'without + valid');
assert(!isValidPhone('123'), 'too short rejected');
assert(!isValidPhone(''), 'empty rejected');

// OTP
assert(isValidOtp('1234'), '4 digit OTP');
assert(isValidOtp('123456'), '6 digit OTP');
assert(!isValidOtp('abc'), 'non-digit rejected');
assert(!isValidOtp('12'), 'too short rejected');

// Text
assert(isValidText('Merhaba'), 'normal text valid');
assert(!isValidText(''), 'empty rejected');
assert(!isValidText('a'.repeat(501)), 'over 500 chars rejected');

// ─── API key comparison ──────────────────────────────────────────────────────
console.log('--- http.keyMatches ---');
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
assert(keyMatches(KEY_A, KEY_A) === true, 'identical keys match');
assert(keyMatches(KEY_A, KEY_B) === false, 'different keys of equal length rejected');
assert(keyMatches(KEY_A, 'short') === false, 'shorter key rejected');
assert(keyMatches(KEY_A, KEY_A + 'x') === false, 'longer key rejected');
assert(keyMatches(KEY_A, '') === false, 'empty client key rejected');
// Tek karakter farkı da reddedilmeli — timingSafeEqual kısa devre yapmıyor.
assert(keyMatches(KEY_A, 'a'.repeat(63) + 'b') === false, 'single trailing char difference rejected');
assert(keyMatches(KEY_A, 'b' + 'a'.repeat(63)) === false, 'single leading char difference rejected');

// ─── AI cevabı ayrıştırma ────────────────────────────────────────────────────
// Üretimde en sık görülen hata buydu: model JSON'dan sonra açıklama yazıyor,
// eski `/\{[\s\S]*\}/` deseni son `}`'e kadar her şeyi alıp çöküyordu. Sonuç,
// kullanıcının haritasıyla ilgisi olmayan genel fallback metnini görmesiydi.
console.log('--- ai-interpreter.parseJSONResponse ---');
const { parseJSONResponse, extractBalancedJSON } = require('../src/services/ai-interpreter');

assert(parseJSONResponse('{"a":1}').a === 1, 'düz JSON ayrıştırılır');

assert(
  parseJSONResponse('```json\n{"a":1}\n```').a === 1,
  'markdown fence içindeki JSON ayrıştırılır'
);

// Asıl regresyon: JSON'dan sonra gelen ve içinde } geçen açıklama metni.
assert(
  parseJSONResponse('{"a":1}\n\nUmarım bu yardımcı olur {tebrikler}').a === 1,
  'JSON sonrası süslü parantez içeren metin yok sayılır'
);

// String içindeki süslü parantez derinliği bozmamalı.
assert(
  parseJSONResponse('{"a":"} kapanis degil","b":2}').b === 2,
  'string içindeki } sayaç bozmaz'
);

// Kaçışlı tırnak string sınırını bozmamalı.
assert(
  parseJSONResponse('{"a":"tirnak \\" icinde","b":3}').b === 3,
  'kaçışlı tırnak string sınırını bozmaz'
);

// İç içe nesne varken ilk dengeli nesne alınmalı.
assert(
  parseJSONResponse('{"a":{"b":{"c":4}}} sonrasi cop }').a.b.c === 4,
  'iç içe nesnelerde doğru kapanış bulunur'
);

assert(extractBalancedJSON('yok') === null, 'süslü parantez yoksa null döner');

// Kesilmiş cevap onarım yoluna düşmeli, hata fırlatmamalı.
{
  let repaired = null;
  try { repaired = parseJSONResponse('{"a":1,"b":"yarim'); } catch (_) { repaired = null; }
  assert(repaired !== null && repaired.a === 1, 'kesilmiş JSON onarılır');
}

// ─── Ownership check (fail-closed) ───────────────────────────────────────────
// Bu uç noktalar eskiden session token'ı opsiyonel sayıyordu: token yoksa
// uyarı basılıp istek GEÇİRİLİYORDU. API anahtarı her IPA'nın içinde gittiği
// için gizli değil, dolayısıyla anahtar + bilinen bir device UUID başkasının
// satırını okumaya yetiyordu. Aşağıdaki üç durum da 2xx dönmemeli.

const DEV_A = 'AAAABBBB-1111-2222-3333-444455556666';
const DEV_B = 'CCCCDDDD-9999-8888-7777-666655554444';

/** node:http ServerResponse'un checkOwnership'in dokunduğu kadarını taklit eder */
function mockRes() {
  return {
    statusCode: null,
    payload: null,
    setHeader() {},
    writeHead(code) { this.statusCode = code; },
    end(body) { this.payload = JSON.parse(body); },
  };
}

const mockReq = (headers) => ({ headers, url: '/api/user/' + DEV_A });

async function ownershipTests() {
  console.log('--- http.checkOwnership ---');

  // x-device-id hiç yok
  let res = mockRes();
  let ok = await checkOwnership(mockReq({}), res, DEV_A);
  assert(ok === false, 'missing x-device-id rejected');
  assert(res.statusCode === 401, 'missing x-device-id → 401');

  // Başka birinin cihazını istemek
  res = mockRes();
  ok = await checkOwnership(mockReq({ 'x-device-id': DEV_B }), res, DEV_A);
  assert(ok === false, 'device id mismatch rejected');
  assert(res.statusCode === 403, 'device id mismatch → 403');

  // Regresyon koruması: doğru cihaz ama session token yok.
  // Eskiden burası `true` dönüyordu — açığın ta kendisi.
  res = mockRes();
  ok = await checkOwnership(mockReq({ 'x-device-id': DEV_A }), res, DEV_A);
  assert(ok === false, 'missing session token rejected (read endpoints too)');
  assert(res.statusCode === 401, 'missing session token → 401');

  // Boş string token da eksik sayılmalı
  res = mockRes();
  ok = await checkOwnership(
    mockReq({ 'x-device-id': DEV_A, 'x-session-token': '' }), res, DEV_A);
  assert(ok === false, 'empty session token rejected');
  assert(res.statusCode === 401, 'empty session token → 401');
}

// ─── Summary ─────────────────────────────────────────────────────────────────
ownershipTests().then(() => {
  console.log(`\n═══════════════════════════`);
  console.log(`  ✓ Passed: ${passed}`);
  console.log(`  ✗ Failed: ${failed}`);
  console.log(`  Total:    ${passed + failed}`);
  console.log(`═══════════════════════════\n`);

  process.exit(failed > 0 ? 1 : 0);
});
