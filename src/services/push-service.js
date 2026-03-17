/**
 * Push notification service using OneSignal REST API
 * For production, you'll need a OneSignal account and configure it for iOS
 */

const ONESIGNAL_API_URL = 'https://onesignal.com/api/v1';

/**
 * Send a push notification to a specific device
 *
 * @param {string} playerId - OneSignal player ID (device token)
 * @param {string} message - Notification body text
 * @param {string} heading - Notification title
 * @param {object} data - Additional data payload
 */
async function sendPushNotification(playerId, message, heading = 'AstroGuide', data = {}) {
  if (!process.env.ONESIGNAL_APP_ID || !process.env.ONESIGNAL_API_KEY) {
    console.log('[Push] OneSignal not configured, skipping notification');
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
