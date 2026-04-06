/**
 * Authentication token and server URL storage using expo-secure-store.
 */
import * as SecureStore from 'expo-secure-store';

const KEY_AUTH_TOKEN = 'auth_token';
const KEY_SERVER_URL = 'server_url';

export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_AUTH_TOKEN);
  } catch {
    return null;
  }
}

export async function setToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_AUTH_TOKEN, token);
}

export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEY_AUTH_TOKEN);
  } catch {
    // Ignore if key doesn't exist
  }
}

export async function getServerUrl(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY_SERVER_URL);
  } catch {
    return null;
  }
}

export async function setServerUrl(url: string): Promise<void> {
  await SecureStore.setItemAsync(KEY_SERVER_URL, url);
}
