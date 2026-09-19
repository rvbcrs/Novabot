/**
 * Push notifications — Expo Push API integration.
 *
 * Flow:
 *   1. App boot (post-login) → request permission
 *   2. Acquire ExpoPushToken via expo-notifications
 *   3. POST it to OpenNova server `/api/push/register` for every bound
 *      mower (one row per (token, sn) pair so the dispatcher can fan
 *      out per mower)
 *   4. Server stores it in `push_tokens` table
 *   5. When the mower emits an event the dispatcher queries by sn,
 *      sends to `https://exp.host/--/api/v2/push/send`, and Apple/Google
 *      deliver it natively.
 *
 * Foreground / background:
 *   - foregroundHandler shows banners + sounds when the app is open
 *   - tap-handler navigates to Messages (or no-op if not configured)
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { ApiClient } from './api';
import { getServerUrl } from './auth';

/** Mirrors EventCategory in server/src/notifications/types.ts. */
export type PushCategory = 'activity' | 'errors' | 'safety' | 'battery' | 'maintenance';
export const PUSH_CATEGORIES: PushCategory[] = ['activity', 'errors', 'safety', 'battery', 'maintenance'];
const MUTED_KEY = 'push.muted';

export async function getMutedCategories(): Promise<PushCategory[]> {
  try {
    const raw = await SecureStore.getItemAsync(MUTED_KEY);
    return raw ? (JSON.parse(raw) as PushCategory[]) : [];
  } catch { return []; }
}

/** Persist and push the new set to the server for every bound mower. */
export async function setMutedCategories(muted: PushCategory[], mowerSns: string[]): Promise<void> {
  await SecureStore.setItemAsync(MUTED_KEY, JSON.stringify(muted));
  await registerPushTokenForMowers(mowerSns);
}

const TAG = '[Push]';

let configured = false;
let cachedToken: string | null = null;

function configureForegroundHandler(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      // Newer expo-notifications API splits the alert into list+banner —
      // both default true so Android/iOS show consistent UX.
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('mower-events', {
    name: 'Mower events',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 250, 250],
    lightColor: '#22c55e',
  });
}

/**
 * Acquire an Expo push token. Returns null on simulator / web / when
 * the user denies permission. Safe to call multiple times — Expo
 * caches the token internally.
 */
export async function acquireExpoPushToken(): Promise<string | null> {
  if (!Device.isDevice) {
    console.log(`${TAG} skipping: not a physical device (push only works on real iOS/Android)`);
    return null;
  }
  if (cachedToken) return cachedToken;

  try {
    configureForegroundHandler();
    await ensureAndroidChannel();

    // iOS surfaces the system permission prompt the first time.
    const settings = await Notifications.getPermissionsAsync();
    let status = settings.status;
    if (status !== 'granted') {
      const ask = await Notifications.requestPermissionsAsync();
      status = ask.status;
    }
    if (status !== 'granted') {
      console.log(`${TAG} permission denied (${status})`);
      return null;
    }

    const token = await Notifications.getExpoPushTokenAsync();
    cachedToken = token.data;
    return cachedToken;
  } catch (err) {
    console.warn(`${TAG} acquire failed:`, err);
    return null;
  }
}

/**
 * Register the device's push token for every bound mower with the
 * OpenNova server. Idempotent — re-registering is a no-op upsert
 * server-side.
 */
export async function registerPushTokenForMowers(mowerSns: string[]): Promise<void> {
  if (mowerSns.length === 0) return;
  const token = await acquireExpoPushToken();
  if (!token) return;

  const url = await getServerUrl();
  if (!url) {
    console.warn(`${TAG} no server URL configured, deferring registration`);
    return;
  }
  const api = new ApiClient(url);

  const platform: 'ios' | 'android' = Platform.OS === 'ios' ? 'ios' : 'android';
  const muted = await getMutedCategories();
  for (const sn of mowerSns) {
    try {
      await api.registerPushToken({ token, sn, platform, muted });
      console.log(`${TAG} registered ${sn} (${platform})`);
    } catch (err) {
      console.warn(`${TAG} register failed for ${sn}:`, err);
    }
  }
}

/**
 * Wire a tap-handler that fires whenever the user taps a notification
 * (cold-start or background). Returns the unsub function.
 */
export function onNotificationTap(
  handler: (event: Notifications.NotificationResponse) => void,
): () => void {
  configureForegroundHandler();
  const sub = Notifications.addNotificationResponseReceivedListener(handler);
  return () => sub.remove();
}
