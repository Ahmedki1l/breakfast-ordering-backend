import webPush from 'web-push';
import User from '../models/User.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@breakfast.app';

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

/**
 * Send push notification to a specific user (all their devices).
 * Silently fails if push is not configured or subscription is invalid.
 */
export async function sendPushToUser(userId, payload) {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;

  try {
    const user = await User.findById(userId);
    if (!user?.pushSubscriptions?.length) return;

    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(
      user.pushSubscriptions.map(sub =>
        webPush.sendNotification(sub, body).catch(async (err) => {
          // Remove invalid subscriptions (410 Gone, 404)
          if (err.statusCode === 410 || err.statusCode === 404) {
            user.pushSubscriptions = user.pushSubscriptions.filter(
              s => s.endpoint !== sub.endpoint
            );
            await user.save();
          }
        })
      )
    );
  } catch (err) {
    console.error('Push notification error:', err.message);
  }
}

/**
 * Send push notification to a user by their name within a session.
 * Looks up the user from the session's orders.
 */
export async function sendPushToParticipant(session, participantName, payload) {
  const order = session.orders?.find(o => o.participantName === participantName);
  if (order?.user) {
    await sendPushToUser(order.user, payload);
  }
}

/**
 * Send push to all participants in a session.
 */
export async function sendPushToAllParticipants(session, payload, excludeName = null) {
  const promises = session.orders
    ?.filter(o => o.user && (!excludeName || o.participantName !== excludeName))
    .map(o => sendPushToUser(o.user, payload)) || [];
  await Promise.allSettled(promises);
}

export { VAPID_PUBLIC_KEY };
