/**
 * Push notification service using OneSignal REST API
 * For production, you'll need a OneSignal account and configure it for iOS
 */

const ONESIGNAL_API_URL = 'https://onesignal.com/api/v1';

// .env.example'dan kopyalanıp doldurulmadan bırakılan değerler. Bunlar
// "tanımlı" olduğu için varlık kontrolünden geçip OneSignal'de 401 alıyor.
const PLACEHOLDER_VALUES = new Set([
  'your-onesignal-rest-api-key',
  'your-onesignal-app-id',
  'your_onesignal_rest_api_key',
  'your_onesignal_app_id',
]);

function isPlaceholder(value) {
  return !value || PLACEHOLDER_VALUES.has(value.trim().toLowerCase());
}

/**
 * Send a push notification to a specific device
 *
 * @param {string} playerId - OneSignal player ID (device token)
 * @param {string} message - Notification body text
 * @param {string} heading - Notification title
 * @param {object} data - Additional data payload
 */
async function sendPushNotification(playerId, message, heading = 'Shimal', data = {}) {
  if (isPlaceholder(process.env.ONESIGNAL_APP_ID) || isPlaceholder(process.env.ONESIGNAL_API_KEY)) {
    console.error(
      '[Push] OneSignal yapılandırılmamış — ONESIGNAL_APP_ID / ONESIGNAL_API_KEY ' +
      'eksik veya .env.example placeholder değeri olarak bırakılmış. Bildirim gönderilmedi.'
    );
    return null;
  }

  const payload = {
    app_id: process.env.ONESIGNAL_APP_ID,
    include_player_ids: [playerId],
    contents: { en: message },
    headings: { en: heading },
    data,
    ios_badgeType: 'Increase',
    ios_badgeCount: 1,
  };

  try {
    const response = await fetch(`${ONESIGNAL_API_URL}/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${process.env.ONESIGNAL_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    // Durum kodu tek başına yetmiyor. OneSignal teslim edilemeyen gönderimleri
    // de HTTP 200 ile döndürüyor; gövdede `errors` olur ve `id` boş gelir:
    //   200 {"id":"","errors":["All included players are not subscribed"]}
    // Cihaz aboneliği düşmüş her kullanıcı bu yola giriyor, yani sadece
    // response.ok'a bakmak bunları "Sent" olarak loglardı.
    //
    // Tek alıcıya gönderiyoruz, dolayısıyla boş `id` veya sıfır `recipients`
    // "hiçbir şey gitmedi" demek.
    const delivered = response.ok && result?.id && result?.recipients !== 0;
    if (!delivered) {
      console.error(
        `[Push] Gönderilemedi (HTTP ${response.status}) player=${playerId}: ` +
        `${JSON.stringify(result?.errors || result).substring(0, 200)}`
      );
      return null;
    }

    console.log(`[Push] Sent to ${playerId}: ${message.substring(0, 50)}...`);
    return result;
  } catch (error) {
    console.error(`[Push] Failed to send notification:`, error.message);
    return null;
  }
}

/**
 * Send daily insight notifications to all users
 */
async function sendDailyNotifications(supabase) {
  const { data: users, error } = await supabase
    .from('users')
    .select('id, push_token, device_id')
    .not('push_token', 'is', null);

  if (error) {
    console.error('[Push] Failed to fetch users:', error.message);
    return;
  }

  const today = new Date().toISOString().split('T')[0];

  for (const user of users) {
    // Get today's insight for this user
    const { data: insight } = await supabase
      .from('daily_insights')
      .select('notification_text')
      .eq('user_id', user.id)
      .eq('date', today)
      .single();

    if (insight && insight.notification_text) {
      await sendPushNotification(
        user.push_token,
        insight.notification_text,
        '✨ Günlük İçgörün',
        { type: 'daily_insight', date: today }
      );
    }
  }
}

module.exports = { sendPushNotification, sendDailyNotifications };
