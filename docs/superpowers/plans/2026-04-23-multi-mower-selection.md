# Multi-mower Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-user mower picker to the Novabot mobile app so users with multiple bound mowers can choose which one is active, while preserving the current single-mower experience for users with only one.

**Architecture:** A new `ActiveMowerContext` holds the selected SN, persisted via `expo-secure-store` (same pattern the codebase already uses for auth and dev-mode flags). A new `useActiveMower()` hook derives the active `DeviceState` from the existing `useMowerState()` devices map — no server changes. A new `MowerPickerChevron` component renders a dropdown in the Home header when `N ≥ 2` mowers are bound. Eleven screens are migrated from `[...devices.values()].find(d => d.deviceType === 'mower')` to the new hook. The migration is incremental: un-migrated screens keep the current first-mower behaviour.

**Tech Stack:** React Native 0.83 + Expo 55, React 19, TypeScript 5.9, React Navigation 7, `expo-secure-store`. No unit-test framework in the app — verification is `npx tsc --noEmit` in `app/` plus a manual smoke run listed in Task 12.

**Reference spec:** [`docs/superpowers/specs/2026-04-23-multi-mower-selection-design.md`](../specs/2026-04-23-multi-mower-selection-design.md)

---

## File Structure

**New files (client only, all under `app/src/`):**

| Path | Responsibility |
|------|----------------|
| `context/ActiveMowerContext.tsx` | React context + provider. Owns `activeMowerSn` state, persists to SecureStore, exposes `setActiveMowerSn`. |
| `hooks/useActiveMower.ts` | Reads `useMowerState().devices` + context. Derives `activeMower` (DeviceState) and the list of mowers. |
| `utils/mowerDisplay.ts` | Pure helper: `mowerDisplayName(mower)` returns `mower.nickname \|\| mower.sn`. |
| `components/MowerPickerChevron.tsx` | Home-header dropdown. Renders `null` for N=0, static label for N=1, active dropdown for N≥2. |

**Modified files:**

| Path | Change |
|------|--------|
| `App.tsx` | Wrap `AuthenticatedApp` in `ActiveMowerProvider`. Add SecureStore cleanup in `handleLogout`. |
| `screens/HomeScreen.tsx` | Swap `find()` for `useActiveMower()`; insert `<MowerPickerChevron />` into header area. |
| `screens/MapScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/JoystickScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/CameraScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/ScheduleScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/HistoryScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/MessagesScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/AppSettingsScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/OtaScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/MowerSettingsScreen.tsx` | Swap `find()` for `useActiveMower()`. |
| `screens/MappingScreen.tsx` | Swap `find()` for `useActiveMower()` (the line-119 call site; the separate `workMaps.find(m => isInside(...))` on line 1382 is unrelated and stays). |

---

## Task 1: ActiveMowerContext

**Files:**
- Create: `app/src/context/ActiveMowerContext.tsx`

- [ ] **Step 1: Create the context file with provider + hook**

```tsx
/**
 * ActiveMowerContext — holds the currently selected mower SN for users
 * with more than one bound mower. Persisted across restarts via
 * expo-secure-store (same pattern as DevModeContext/ExperimentalContext).
 *
 * This context does NOT derive the DeviceState object — that is done in
 * `useActiveMower()` so it can combine with useMowerState().devices.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import * as SecureStore from 'expo-secure-store';

const STORE_KEY = 'novabot:activeMowerSn';

interface ActiveMowerContextValue {
  activeMowerSn: string | null;
  setActiveMowerSn: (sn: string | null) => void;
  hydrated: boolean;
}

const defaultValue: ActiveMowerContextValue = {
  activeMowerSn: null,
  setActiveMowerSn: () => {},
  hydrated: false,
};

export const ActiveMowerContext = createContext<ActiveMowerContextValue>(defaultValue);

export function ActiveMowerProvider({ children }: { children: React.ReactNode }) {
  const [activeMowerSn, setActiveMowerSnState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const mounted = useRef(true);

  // Load persisted SN on mount.
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const stored = await SecureStore.getItemAsync(STORE_KEY);
        if (mounted.current && stored) setActiveMowerSnState(stored);
      } catch {
        // Ignore — falls back to null.
      } finally {
        if (mounted.current) setHydrated(true);
      }
    })();
    return () => { mounted.current = false; };
  }, []);

  const setActiveMowerSn = useCallback((sn: string | null) => {
    setActiveMowerSnState(sn);
    if (sn) {
      SecureStore.setItemAsync(STORE_KEY, sn).catch(() => {});
    } else {
      SecureStore.deleteItemAsync(STORE_KEY).catch(() => {});
    }
  }, []);

  return (
    <ActiveMowerContext.Provider value={{ activeMowerSn, setActiveMowerSn, hydrated }}>
      {children}
    </ActiveMowerContext.Provider>
  );
}

export function useActiveMowerContext(): ActiveMowerContextValue {
  return useContext(ActiveMowerContext);
}

/**
 * Imperative clear — called from the logout handler because it has to fire
 * outside the React tree (the provider will have been unmounted by then).
 */
export async function clearPersistedActiveMowerSn(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORE_KEY);
  } catch {
    // Ignore — key may not exist.
  }
}
```

- [ ] **Step 2: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/context/ActiveMowerContext.tsx
git commit -m "feat(app): add ActiveMowerContext with SecureStore persistence"
```

---

## Task 2: useActiveMower hook

**Files:**
- Create: `app/src/hooks/useActiveMower.ts`

- [ ] **Step 1: Create the hook file**

```ts
/**
 * useActiveMower — single entry point for every screen that needs to act on
 * "the mower the user is currently looking at". Replaces the widespread
 * pattern `[...devices.values()].find(d => d.deviceType === 'mower')`, which
 * silently picked whichever mower happened to come first.
 *
 * Contract:
 *   - `activeMower` is the DeviceState for the selected SN, or the first
 *     mower in the device list if nothing is selected, or null when no
 *     mower is bound at all.
 *   - `mowers` is the full, stable-ordered list of mowers (sorted by SN
 *     so the picker UI does not reshuffle on unrelated socket updates).
 *   - `setActiveMowerSn(sn)` writes through to SecureStore.
 */
import { useMemo } from 'react';
import { useMowerState } from './useMowerState';
import { useActiveMowerContext } from '../context/ActiveMowerContext';
import type { DeviceState } from '../types';

interface UseActiveMowerResult {
  activeMower: DeviceState | null;
  mowers: DeviceState[];
  activeMowerSn: string | null;
  setActiveMowerSn: (sn: string | null) => void;
  hydrated: boolean;
}

export function useActiveMower(): UseActiveMowerResult {
  const { devices } = useMowerState();
  const { activeMowerSn, setActiveMowerSn, hydrated } = useActiveMowerContext();

  const mowers = useMemo(
    () =>
      [...devices.values()]
        .filter((d) => d.deviceType === 'mower')
        .sort((a, b) => a.sn.localeCompare(b.sn)),
    [devices],
  );

  const activeMower = useMemo<DeviceState | null>(() => {
    if (activeMowerSn) {
      const stored = devices.get(activeMowerSn);
      if (stored && stored.deviceType === 'mower') return stored;
    }
    return mowers[0] ?? null;
  }, [devices, activeMowerSn, mowers]);

  return {
    activeMower,
    mowers,
    activeMowerSn: activeMower?.sn ?? null,
    setActiveMowerSn,
    hydrated,
  };
}
```

- [ ] **Step 2: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/hooks/useActiveMower.ts
git commit -m "feat(app): add useActiveMower hook deriving active mower"
```

---

## Task 3: Display helper

**Files:**
- Create: `app/src/utils/mowerDisplay.ts`

- [ ] **Step 1: Create the helper**

```ts
/**
 * Single source of truth for how a mower is rendered in text. Falls back to
 * the full SN (e.g. "LFIN1231000211") when no nickname is set — matches the
 * spec decision to keep the SN recognisable without truncation.
 */
import type { DeviceState } from '../types';

export function mowerDisplayName(mower: Pick<DeviceState, 'sn' | 'nickname'>): string {
  return (mower.nickname && mower.nickname.trim()) || mower.sn;
}
```

- [ ] **Step 2: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/src/utils/mowerDisplay.ts
git commit -m "feat(app): add mowerDisplayName helper"
```

---

## Task 4: Wire provider into App.tsx + logout clear

**Files:**
- Modify: `app/App.tsx`

- [ ] **Step 1: Add imports at the top of `App.tsx`**

In the existing import block at the top of `app/App.tsx`, add:

```ts
import {
  ActiveMowerProvider,
  clearPersistedActiveMowerSn,
} from './src/context/ActiveMowerContext';
```

- [ ] **Step 2: Wrap `AuthenticatedApp` with the provider**

In `App.tsx`, find the JSX that renders `AuthenticatedApp`:

```tsx
{isAuthenticated ? (
  <AuthenticatedApp onLogout={handleLogout} onGoToProvision={handleGoToProvision} />
) : (
  <AuthStack.Navigator screenOptions={screenOptions}>
```

Replace the `<AuthenticatedApp .../>` line with:

```tsx
<ActiveMowerProvider>
  <AuthenticatedApp onLogout={handleLogout} onGoToProvision={handleGoToProvision} />
</ActiveMowerProvider>
```

- [ ] **Step 3: Clear stored SN on logout**

Find `handleLogout` in `App.tsx`:

```ts
const handleLogout = useCallback(() => {
  disconnectSocket();
  setIsAuthenticated(false);
}, []);
```

Replace with:

```ts
const handleLogout = useCallback(() => {
  disconnectSocket();
  clearPersistedActiveMowerSn().catch(() => {});
  setIsAuthenticated(false);
}, []);
```

- [ ] **Step 4: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/App.tsx
git commit -m "feat(app): mount ActiveMowerProvider and clear SN on logout"
```

---

## Task 5: MowerPickerChevron component

**Files:**
- Create: `app/src/components/MowerPickerChevron.tsx`

- [ ] **Step 1: Create the component**

```tsx
/**
 * Home-header picker. Shows the active mower's display name plus a status
 * dot; when there are two or more bound mowers, a tap opens an inline
 * dropdown with a row per mower. No full-screen modal — the dropdown is
 * absolute-positioned so the Home screen stays in view.
 *
 * N = 0: renders nothing (Home has its own empty state).
 * N = 1: renders the name + dot as static text (no chevron).
 * N ≥ 2: renders the chevron; tapping toggles the dropdown.
 */
import React, { useMemo, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../theme/colors';
import { useActiveMower } from '../hooks/useActiveMower';
import { mowerDisplayName } from '../utils/mowerDisplay';

export function MowerPickerChevron() {
  const { mowers, activeMower, activeMowerSn, setActiveMowerSn } = useActiveMower();
  const [open, setOpen] = useState(false);

  const count = mowers.length;
  const canSwitch = count >= 2;

  if (count === 0 || !activeMower) return null;

  return (
    <View style={styles.wrap}>
      <Pressable
        style={styles.trigger}
        onPress={() => canSwitch && setOpen((v) => !v)}
        disabled={!canSwitch}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={
          canSwitch
            ? `Active mower ${mowerDisplayName(activeMower)}. Tap to switch.`
            : `Active mower ${mowerDisplayName(activeMower)}.`
        }
      >
        <StatusDot online={activeMower.online} />
        <Text style={styles.name} numberOfLines={1} ellipsizeMode="tail">
          {mowerDisplayName(activeMower)}
        </Text>
        {canSwitch && (
          <Ionicons
            name={open ? 'chevron-up' : 'chevron-down'}
            size={16}
            color={colors.text}
            style={styles.chevron}
          />
        )}
      </Pressable>

      {open && (
        <>
          {/* Backdrop: tap-outside-to-close. Transparent, fills the screen. */}
          <Pressable
            style={styles.backdrop}
            onPress={() => setOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close mower picker"
          />
          <View style={styles.dropdown}>
            {mowers.map((m) => {
              const selected = m.sn === activeMowerSn;
              return (
                <Pressable
                  key={m.sn}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && styles.rowPressed,
                  ]}
                  onPress={() => {
                    setActiveMowerSn(m.sn);
                    setOpen(false);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Switch to ${mowerDisplayName(m)}`}
                >
                  <StatusDot online={m.online} />
                  <Text style={styles.rowName} numberOfLines={1} ellipsizeMode="tail">
                    {mowerDisplayName(m)}
                  </Text>
                  {selected && (
                    <Ionicons
                      name="checkmark"
                      size={18}
                      color={colors.emerald}
                      style={styles.check}
                    />
                  )}
                </Pressable>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <View
      style={[
        styles.dot,
        { backgroundColor: online ? colors.emerald : '#E5484D' },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'relative',
    zIndex: 100,
  },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
    paddingHorizontal: 4,
    minHeight: 32,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 8,
  },
  name: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '600',
    maxWidth: 220,
  },
  chevron: {
    marginLeft: 6,
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: -1000,
    right: -1000,
    bottom: -10000,
    backgroundColor: 'transparent',
  },
  dropdown: {
    position: 'absolute',
    top: 40,
    left: 0,
    backgroundColor: colors.bg,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 4,
    minWidth: 240,
    zIndex: 101,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 8,
    elevation: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 44,
  },
  rowPressed: {
    backgroundColor: colors.cardBorder,
  },
  rowName: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontWeight: '500',
  },
  check: {
    marginLeft: 8,
  },
});
```

- [ ] **Step 2: Verify `colors.bg`, `colors.emerald`, `colors.text`, `colors.cardBorder` exist**

Run: `grep -E "bg|emerald|text|cardBorder" app/src/theme/colors.ts`
Expected: all four names appear. If any is missing, pick the closest existing colour and substitute — do not add new colours for this feature.

- [ ] **Step 3: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/src/components/MowerPickerChevron.tsx
git commit -m "feat(app): add MowerPickerChevron dropdown component"
```

---

## Task 6: Migrate HomeScreen + embed chevron

**Files:**
- Modify: `app/src/screens/HomeScreen.tsx`

- [ ] **Step 1: Add the hook import + chevron import at the top**

In the existing import block, add:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
import { MowerPickerChevron } from '../components/MowerPickerChevron';
```

- [ ] **Step 2: Replace the mower lookup**

Find this line (around line 111):

```ts
const mower = [...devices.values()].find((d) => d.deviceType === 'mower');
```

Replace with:

```ts
const { activeMower: mower } = useActiveMower();
```

- [ ] **Step 3: Render the chevron in the header area**

Find the existing block around line 1168 that renders the connection info:

```tsx
<Text style={styles.connectionText}>{mower.sn}</Text>
```

Replace the line that renders `mower.sn` as the header title with the chevron. Keep the existing `sw_version`/`mower_version` chip next to it. Wrap them in a row so they sit side-by-side:

```tsx
<View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
  <MowerPickerChevron />
  {mower.online && (devices.get(mower.sn)?.sensors?.sw_version || devices.get(mower.sn)?.sensors?.mower_version) && (
    <View style={styles.versionBadge}>
      <Text style={styles.versionText}>
        {devices.get(mower.sn)?.sensors?.sw_version ?? devices.get(mower.sn)?.sensors?.mower_version}
      </Text>
    </View>
  )}
</View>
```

(The old `<Text style={styles.connectionText}>{mower.sn}</Text>` line is removed — the chevron now renders the name.)

- [ ] **Step 4: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Smoke-boot**

Run: `cd app && npx expo start --no-dev --minify` (or the user's usual dev command) and open the app.
Expected: Home shows the active mower's name (nickname or full SN) with a green/red dot; chevron is disabled if only one mower is bound.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/HomeScreen.tsx
git commit -m "feat(app): HomeScreen uses useActiveMower + embeds picker chevron"
```

---

## Task 7: Migrate Map + Mapping screens

**Files:**
- Modify: `app/src/screens/MapScreen.tsx`
- Modify: `app/src/screens/MappingScreen.tsx`

- [ ] **Step 1: MapScreen — add import**

In `app/src/screens/MapScreen.tsx`, add to the imports:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

- [ ] **Step 2: MapScreen — replace mower lookup**

Find (around line 323):

```ts
const mower = useMemo(() => [...devices.values()].find((d) => d.deviceType === 'mower') ?? null, [devices]);
```

Replace with:

```ts
const { activeMower: mower } = useActiveMower();
```

- [ ] **Step 3: MappingScreen — add import**

In `app/src/screens/MappingScreen.tsx`, add:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

- [ ] **Step 4: MappingScreen — replace mower lookup**

Find (around line 119):

```ts
const mower = [...devices.values()].find(d => d.deviceType === 'mower');
```

Replace with:

```ts
const { activeMower: mower } = useActiveMower();
```

**Note:** The `workMaps.find(m => isInside(mowerLocal, m.points))` call on line 1382 is an unrelated polygon lookup — leave it alone.

- [ ] **Step 5: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/MapScreen.tsx app/src/screens/MappingScreen.tsx
git commit -m "feat(app): Map + Mapping screens use useActiveMower"
```

---

## Task 8: Migrate Joystick + Camera screens

**Files:**
- Modify: `app/src/screens/JoystickScreen.tsx`
- Modify: `app/src/screens/CameraScreen.tsx`

- [ ] **Step 1: JoystickScreen — add import**

Add to the imports:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

- [ ] **Step 2: JoystickScreen — replace mower lookup**

Find (around line 64):

```ts
const mower = [...devices.values()].find(d => d.deviceType === 'mower' && d.online);
```

Replace with:

```ts
const { activeMower } = useActiveMower();
const mower = activeMower && activeMower.online ? activeMower : null;
```

(Preserves the existing "only act on online mower" behaviour — Joystick commands must go to an online device.)

- [ ] **Step 3: CameraScreen — add import**

Add to the imports:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

- [ ] **Step 4: CameraScreen — replace mower lookup**

Find (around line 56):

```ts
const mower = [...devices.values()].find(d => d.deviceType === 'mower' && d.online);
```

Replace with:

```ts
const { activeMower } = useActiveMower();
const mower = activeMower && activeMower.online ? activeMower : null;
```

- [ ] **Step 5: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/JoystickScreen.tsx app/src/screens/CameraScreen.tsx
git commit -m "feat(app): Joystick + Camera screens use useActiveMower"
```

---

## Task 9: Migrate Schedule + History screens

**Files:**
- Modify: `app/src/screens/ScheduleScreen.tsx`
- Modify: `app/src/screens/HistoryScreen.tsx`

- [ ] **Step 1: ScheduleScreen — add import and replace lookup**

Add:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

Find (around line 52):

```ts
return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
```

Replace the surrounding `useMemo` with a single line:

```ts
const { activeMowerSn } = useActiveMower();
const mowerSn = activeMowerSn ?? '';
```

(Remove the now-unused `useMemo` if it held only this derivation.)

- [ ] **Step 2: HistoryScreen — add import and replace lookup**

Add:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

Find (around line 32):

```ts
return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
```

Replace the containing derivation with:

```ts
const { activeMowerSn } = useActiveMower();
const mowerSn = activeMowerSn ?? '';
```

- [ ] **Step 3: Verify data refresh on switch**

Open both files and confirm any `useEffect` that fetches schedules/history has `mowerSn` (or `activeMowerSn`) in its dependency array. If an effect previously fetched once and cached, update its deps so switching re-fetches.

- [ ] **Step 4: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/ScheduleScreen.tsx app/src/screens/HistoryScreen.tsx
git commit -m "feat(app): Schedule + History screens use useActiveMower"
```

---

## Task 10: Migrate Messages + AppSettings + MowerSettings + OTA

**Files:**
- Modify: `app/src/screens/MessagesScreen.tsx`
- Modify: `app/src/screens/AppSettingsScreen.tsx`
- Modify: `app/src/screens/MowerSettingsScreen.tsx`
- Modify: `app/src/screens/OtaScreen.tsx`

- [ ] **Step 1: MessagesScreen**

Add import:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

Find (around line 76):

```ts
return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
```

Replace the containing derivation with:

```ts
const { activeMower: mower } = useActiveMower();
```

- [ ] **Step 2: AppSettingsScreen**

Add import:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

Find (around line 56):

```ts
return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
```

Replace with:

```ts
const { activeMower: mower } = useActiveMower();
```

- [ ] **Step 3: MowerSettingsScreen**

Add import:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

There are two call sites (around lines 64 and 68):

```ts
return [...devices.values()].find((d) => d.deviceType === 'mower')?.sn ?? '';
// ...
return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
```

Collapse them into one:

```ts
const { activeMower: mower, activeMowerSn } = useActiveMower();
const mowerSn = activeMowerSn ?? '';
```

Remove any `useMemo` wrappers whose only job was these derivations. Existing references to `mower`/`mowerSn` downstream continue to work.

- [ ] **Step 4: OtaScreen**

Add import:

```ts
import { useActiveMower } from '../hooks/useActiveMower';
```

Find (around line 50):

```ts
return [...devices.values()].find((d) => d.deviceType === 'mower') ?? null;
```

Replace with:

```ts
const { activeMower: mower } = useActiveMower();
```

- [ ] **Step 5: Type-check**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/MessagesScreen.tsx app/src/screens/AppSettingsScreen.tsx app/src/screens/MowerSettingsScreen.tsx app/src/screens/OtaScreen.tsx
git commit -m "feat(app): Messages/AppSettings/MowerSettings/OTA use useActiveMower"
```

---

## Task 11: Confirm migration sweep is complete

**Files:**
- None (read-only verification)

- [ ] **Step 1: Grep for any remaining call sites**

Run:

```bash
grep -rn "deviceType === 'mower'" app/src/screens/ app/src/hooks/ app/src/components/
```

Expected output: at most one hit — the filter inside `useActiveMower.ts` (`.filter((d) => d.deviceType === 'mower')`). Any hit inside `app/src/screens/*` means that screen was missed and must be migrated with the same pattern as Tasks 7–10.

- [ ] **Step 2: Grep for the older pattern variations**

Run:

```bash
grep -rn "\.find(\(d\) => d\.deviceType ===" app/src/
```

Expected: no hits outside `useActiveMower.ts`.

- [ ] **Step 3: Type-check one more time**

Run: `cd app && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit any fix-ups if Step 1 or 2 found stragglers**

```bash
git add app/src/screens/<file>.tsx
git commit -m "feat(app): migrate <file> to useActiveMower"
```

(Otherwise skip this step.)

---

## Task 12: Manual smoke test

**Files:**
- None (QA run against a real device / simulator)

- [ ] **Step 1: Start the app fresh against a user with N=1 mower**

Expected: Home renders. The picker area shows the mower's nickname or full SN with a green dot when online. No chevron icon; tapping the area does nothing.

- [ ] **Step 2: Start the app fresh against a user with N=2 mowers**

Expected: Home renders the first mower (alphabetical SN order) with a chevron. Tap the chevron → dropdown lists both mowers with dots and a check-mark on the active one.

- [ ] **Step 3: Switch mower**

Tap the other mower in the dropdown. Expected: dropdown closes; Home redraws using the selected mower's activity, battery, and version. Walk through Map, Control, Camera, Schedule, History, Messages, Settings → OTA → Mower Settings tabs. Each must show data for the newly selected SN.

- [ ] **Step 4: Persistence**

Force-quit the app. Re-open. Expected: same mower is still active.

- [ ] **Step 5: Offline selection**

Either unplug the power of one mower or wait for it to go offline (red dot). Tap the dropdown → pick the offline mower. Expected: Home renders last-known state with a red dot in the picker; attempting a mowing / Control command is rejected by the existing online-guard in each screen (not by the picker itself).

- [ ] **Step 6: Stored-SN fallback**

With mower B selected, unbind mower B from the dashboard / server. Force-quit, restart the app. Expected: the first remaining mower becomes active and the storage is rewritten so restarting again shows the same one.

- [ ] **Step 7: Logout + login as different user**

Log out of the current account, log in as a different account that has its own mowers. Expected: the previous user's SN is gone; the first mower of the new user is active.

- [ ] **Step 8: New mower bound during session**

In an active session, provision a new mower (or have the server emit a `device:online` event for one). Expected: the new mower appears in the dropdown; the active selection is unchanged.

- [ ] **Step 9: Commit the manual test log (optional)**

If you kept notes, drop them under `docs/superpowers/plans/2026-04-23-multi-mower-selection-notes.md` and commit.

---

## Self-Review

- Spec coverage: state model (Task 1), hook (Task 2), display helper (Task 3), provider wiring + logout clear (Task 4), picker UI (Task 5), screen migration (Tasks 6–10), sweep-check (Task 11), manual tests (Task 12). Every decision in the spec's decisions table is covered.
- Placeholder scan: no TBD / TODO / "handle edge cases". Every code step carries the code it mutates.
- Type consistency: `activeMowerSn: string | null`, `setActiveMowerSn: (sn: string | null) => void`, `activeMower: DeviceState | null` — identical across Tasks 1, 2, 5, and 6. Field name `nickname` (lowercase) matches `DeviceState` in `app/src/types/index.ts`. `mowerDisplayName` signature is used verbatim by the picker.
- Scope: single feature, no unrelated refactors bundled in.
