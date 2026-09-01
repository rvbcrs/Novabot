/**
 * App self-update service.
 *
 * Exports pure comparison helpers, a server-polling function, AsyncStorage-style
 * skip-version helpers (backed by expo-secure-store for consistency with the rest
 * of the app), and the download + SHA256-verify + install pipeline.
 *
 * NOTE: No tests — there is no Jest/Vitest config in app/. Tests skipped per plan
 * deviation #4.
 */

import * as Application from 'expo-application';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import * as SecureStore from 'expo-secure-store';

const SKIP_KEY = 'appUpdate.skippedVersion';
const URL_KEY = 'appUpdate.manifestUrl';

/**
 * Default release manifest host. APK + manifest live here regardless of which
 * OpenNova server the user is connected to. Users can override the full URL
 * in Settings → Update URL when running their own release host.
 *
 * NOTE: hostname is `downloads` (plural). Both `downloads.` and `download.`
 * resolve via DNS CNAME so either works, but plural is the canonical form
 * used by historical manifests and what's documented on the NAS.
 */
const DEFAULT_RELEASE_MANIFEST_URL = 'https://downloads.ramonvanbruggen.nl/app/manifest.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppLatest {
  version: string;
  platform: 'android';
  apkUrl: string;
  sha256: string;
  sizeBytes: number;
  releaseNotes: string;
  minSupportedServerVersion: string;
  releasedAt: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (importable without side-effects)
// ---------------------------------------------------------------------------

/**
 * Compares two semantic version strings.
 * Returns > 0 if a > b, 0 if equal, < 0 if a < b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10));
  const pb = b.split('.').map((n) => parseInt(n, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/**
 * Returns true when the remote version is newer than what's installed
 * AND the user hasn't explicitly skipped it.
 */
export function hasUpdateAvailable(
  installed: string,
  remote: string,
  skipped: string | null,
): boolean {
  if (compareSemver(remote, installed) <= 0) return false;
  if (skipped !== null && compareSemver(remote, skipped) === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Manifest URL override (Settings)
// ---------------------------------------------------------------------------

/**
 * Returns the user-configured manifest URL, or the built-in default.
 */
export async function getReleaseManifestUrl(): Promise<string> {
  try {
    const stored = await SecureStore.getItemAsync(URL_KEY);
    return stored && stored.trim().length > 0 ? stored.trim() : DEFAULT_RELEASE_MANIFEST_URL;
  } catch {
    return DEFAULT_RELEASE_MANIFEST_URL;
  }
}

/**
 * Persists a custom manifest URL. Pass null/empty to revert to the default.
 */
export async function setReleaseManifestUrl(url: string | null): Promise<void> {
  if (!url || url.trim().length === 0) {
    await SecureStore.deleteItemAsync(URL_KEY);
    return;
  }
  await SecureStore.setItemAsync(URL_KEY, url.trim());
}

export function getDefaultReleaseManifestUrl(): string {
  return DEFAULT_RELEASE_MANIFEST_URL;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/**
 * Fetches the latest release manifest from the configured (or default) host.
 * Returns null on 404 / network errors — never throws. Cache-busted via
 * a millisecond query string so a freshly uploaded manifest is picked up
 * even when an upstream cache is in front of the host.
 */
export async function fetchLatest(): Promise<AppLatest | null> {
  try {
    const url = await getReleaseManifestUrl();
    const r = await fetch(`${url}?t=${Date.now()}`);
    if (!r.ok) return null;
    return (await r.json()) as AppLatest;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Skip-version persistence (expo-secure-store, consistent with auth.ts)
// ---------------------------------------------------------------------------

export async function getSkippedVersion(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SKIP_KEY);
  } catch {
    return null;
  }
}

export async function setSkippedVersion(v: string): Promise<void> {
  await SecureStore.setItemAsync(SKIP_KEY, v);
}

// ---------------------------------------------------------------------------
// Top-level check
// ---------------------------------------------------------------------------

/**
 * Returns the latest release if it's newer than the installed version and not
 * skipped by the user. Platform-agnostic: iOS callers still receive the data
 * so the UI can route to GitHub Releases (UpdatePromptModal handles the
 * platform branch). Returns null when there is no update.
 */
export async function checkForUpdate(): Promise<AppLatest | null> {
  const latest = await fetchLatest();
  if (!latest) return null;
  const installed = Application.nativeApplicationVersion ?? '0.0.0';
  const skipped = await getSkippedVersion();
  if (!hasUpdateAvailable(installed, latest.version, skipped)) return null;
  return latest;
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Downloads the APK to the cache directory and resolves with the local URI.
 *
 * GEEN eigen hash-verificatie meer. Die stond hier als chunked SHA256 in
 * JavaScript en blokkeerde de JS-thread ruim een minuut bij een 112 MB APK,
 * terwijl de UI "Downloading 100%" bleef tonen — gebruikers zagen een hang
 * en kilden de app. En hij bewees niets: Android's installer verifieert de
 * APK-handtekening over het hele bestand (kapotte download = installatie
 * geweigerd), en een update installeert alleen als hij met hetzelfde
 * certificaat is ondertekend als de app zelf. De sha256 in het manifest komt
 * bovendien van dezelfde host over hetzelfde TLS-kanaal als de APK, dus
 * tegen manipulatie voegde hij niets toe. Het veld blijft in het manifest
 * staan voor wie handmatig wil verifiëren.
 */
export async function downloadApk(
  url: string,
  onProgress?: (frac: number) => void,
): Promise<{ uri: string }> {
  const target = `${FileSystem.cacheDirectory}opennova-update.apk`;

  const dl = FileSystem.createDownloadResumable(
    url,
    target,
    {},
    (p) => {
      if (p.totalBytesExpectedToWrite > 0) {
        onProgress?.(p.totalBytesWritten / p.totalBytesExpectedToWrite);
      }
    },
  );

  const result = await dl.downloadAsync();
  if (!result?.uri) throw new Error('APK download failed — no URI returned');

  const info = await FileSystem.getInfoAsync(result.uri);
  if (!info.exists || info.size == null || info.size === 0) {
    throw new Error('APK download failed — file missing or empty');
  }

  return { uri: result.uri };
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Triggers the Android system package installer for the given local APK URI.
 * The URI must point to a file inside the cache or document directory so that
 * FileProvider can produce a content:// URI.
 */
export async function installApk(uri: string): Promise<void> {
  const contentUri = await FileSystem.getContentUriAsync(uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
    type: 'application/vnd.android.package-archive',
  });
}
