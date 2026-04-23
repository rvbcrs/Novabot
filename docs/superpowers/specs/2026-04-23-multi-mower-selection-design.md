# Multi-mower Selection — Design Spec

**Date:** 2026-04-23
**Status:** Approved (brainstorming)
**Scope:** Client-side (app only). Server already supports multi-device per user.

## Goal

Allow users who own more than one mower to select which mower is the "active" one in the mobile app. The app currently picks the first mower from the device map on every screen (`[...devices.values()].find(d => d.deviceType === 'mower')`). With two mowers this is undefined-order and the user has no way to address the second mower.

## Non-goals

- Dashboard multi-device UI (separate project).
- Server changes — socket already emits all devices for the authenticated user.
- Showing two mowers side-by-side.
- Per-tab selection (selection is global to the app).
- Bulk actions across mowers.
- Differentiated notifications per mower.

## Design decisions

| Question | Decision |
|----------|----------|
| Where does the picker live? | Home-tab header only. Other tabs inherit the global active mower. |
| Persistence across restarts? | Last choice remembered in AsyncStorage, with fallback to first available mower if stored SN no longer exists. |
| Offline mowers in picker? | Shown and selectable, rendered with a red status-dot. |
| Picker UI style? | Dropdown chevron (inline list). |
| Nickname fallback when empty? | Full mower SN (e.g. `LFIN1231000211`). |
| Charger info in picker? | No — mower-only rows (nickname or SN + status-dot). |
| Nickname editing? | Already exists in `HomeScreen`. No new edit UI. |

## Architecture

### State model — `ActiveMowerContext`

New file: `app/src/context/ActiveMowerContext.tsx`

```ts
interface ActiveMowerContextValue {
  activeMowerSn: string | null;
  setActiveMowerSn: (sn: string) => void;
}
```

**Provider placement:** wraps `AuthenticatedApp` in `App.tsx`, inside the other context providers (`DevModeProvider`, `DemoProvider`, `I18nProvider`, `ExperimentalProvider`, `PatternProvider`).

**Storage key:** `novabot:activeMowerSn` in AsyncStorage.

**Startup flow:**
1. On provider mount, read `novabot:activeMowerSn` from AsyncStorage.
2. Wait for `useMowerState().devices` to populate (socket handshake).
3. Validate: if stored SN is present among current mowers → keep active.
4. Otherwise → set active to the first mower (`mowers[0]?.sn ?? null`) and overwrite storage.

**Logout flow:** call `AsyncStorage.removeItem('novabot:activeMowerSn')` inside `handleLogout` in `App.tsx`. Prevents the stored SN from leaking into a different user's session.

### Hook — `useActiveMower`

New file: `app/src/hooks/useActiveMower.ts`

```ts
import { useContext, useMemo } from 'react';
import { useMowerState } from '…';
import { ActiveMowerContext } from '../context/ActiveMowerContext';

export function useActiveMower() {
  const { devices } = useMowerState();
  const { activeMowerSn, setActiveMowerSn } = useContext(ActiveMowerContext);

  const mowers = useMemo(
    () => [...devices.values()].filter(d => d.deviceType === 'mower'),
    [devices],
  );

  const activeMower = useMemo(
    () => (activeMowerSn ? devices.get(activeMowerSn) : null) ?? mowers[0] ?? null,
    [devices, activeMowerSn, mowers],
  );

  return {
    activeMower,
    mowers,
    activeMowerSn: activeMower?.sn ?? null,
    setActiveMowerSn,
  };
}
```

### Display helper

New file: `app/src/utils/mowerDisplay.ts`

```ts
export function mowerDisplayName(mower: { sn: string; nickName?: string | null }): string {
  return mower.nickName || mower.sn;
}
```

Used by the picker and anywhere else a mower is displayed.

### UI — `MowerPickerChevron`

New file: `app/src/components/MowerPickerChevron.tsx`

Visual (Home header area):

```
┌─ Home header ──────────────────┐
│  🟢 Voortuin-maaier  ▾         │
└────────────────────────────────┘
```

Tap → inline dropdown directly under the header:

```
┌────────────────────────────────┐
│ 🟢 Voortuin-maaier         ✓   │   ← current, checkmark
│ 🔴 LFIN1231000211              │   ← offline, SN fallback
│ 🟢 Achtertuin-test             │
└────────────────────────────────┘
```

Behaviour:
- **N = 0:** the component renders `null`. `HomeScreen` already has its own "no mower" empty state.
- **N = 1:** chevron is disabled (no ▾). Name + status-dot rendered as static text.
- **N ≥ 2:** chevron is active. Tap toggles dropdown.
- **Status dot:** 10 px circle. Green (`colors.emerald`) for online, red for offline.
- **Dropdown closes on:** outside tap, item tap, Android back button.
- **Tap row:** calls `setActiveMowerSn(sn)`, closes dropdown, all 14 screens re-render through their existing dependency on `mower?.sn`.

Styling rules:
- Font weight semibold for the active-mower name in the header.
- Row height ≥ 44 px for touch target.
- Dropdown absolute-positioned inside Home — not a fullscreen modal.
- No new dependencies required.

API:

```tsx
<MowerPickerChevron />
```

The component pulls everything from `useActiveMower()`.

### Screen migration

Replace the 11 occurrences of `[...devices.values()].find(d => d.deviceType === 'mower')` with the new hook.

```ts
// Before
const { devices } = useMowerState();
const mower = [...devices.values()].find(d => d.deviceType === 'mower');

// After
const { activeMower: mower } = useActiveMower();
```

Affected files:

- `app/src/screens/HomeScreen.tsx` (plus adds the chevron)
- `app/src/screens/MapScreen.tsx`
- `app/src/screens/JoystickScreen.tsx`
- `app/src/screens/CameraScreen.tsx`
- `app/src/screens/ScheduleScreen.tsx`
- `app/src/screens/HistoryScreen.tsx`
- `app/src/screens/MessagesScreen.tsx`
- `app/src/screens/AppSettingsScreen.tsx`
- `app/src/screens/OtaScreen.tsx`
- `app/src/screens/MowerSettingsScreen.tsx`
- `app/src/screens/MappingScreen.tsx`

Re-rendering on switch is automatic: every consumer already depends on `mower?.sn` or the `mower` object identity, so changing the returned reference triggers their existing effects. One local-state caveat: screens that cache fetched data in component state (e.g. `MapScreen` stores map polygons, `HistoryScreen` caches records) must include `mower?.sn` in the dependency list of the effect that fetches that data. Any screen that already does so needs no change.

## Edge cases

| Situation | Behaviour |
|-----------|-----------|
| N = 0 at startup | `activeMowerSn = null`, picker hidden, Home shows the existing empty state. |
| Stored SN no longer in devices | Fallback to `mowers[0]`, storage is overwritten with the new SN. |
| Active mower goes offline | SN stays active (offline is selectable). Status-dot turns red. Commands are blocked by existing online-guards in each screen. |
| New mower bound during session | Appears in dropdown. Active selection is unchanged. |
| Active mower unbound (admin ban, unbind) | Falls back to `mowers[0]` on next render. Storage is rewritten. |
| Login as different user | Storage cleared on logout. If it was not cleared (crash), validation picks the first mower of the new user. |

## Rollout

The change is incremental and non-breaking:

1. Add `ActiveMowerContext`, `useActiveMower`, `mowerDisplayName` helper.
2. Wrap `AuthenticatedApp` in the provider.
3. Migrate `HomeScreen` first and add `MowerPickerChevron`.
4. Migrate the remaining 13 screens one by one.

Until a screen is migrated it still reads the first mower from `devices`, which matches the current behaviour for N = 1 and is tolerable for N = 2 until that screen lands. No feature flag required.

For reference, the complete list of current call sites (matches the `grep` used during the design review):

```
app/src/screens/CameraScreen.tsx
app/src/screens/AppSettingsScreen.tsx
app/src/screens/MessagesScreen.tsx
app/src/screens/JoystickScreen.tsx
app/src/screens/HistoryScreen.tsx
app/src/screens/MappingScreen.tsx
app/src/screens/OtaScreen.tsx
app/src/screens/ScheduleScreen.tsx
app/src/screens/MowerSettingsScreen.tsx
app/src/screens/MapScreen.tsx
app/src/screens/HomeScreen.tsx
```

## Testing (manual)

1. **N = 1:** chevron is disabled, behaviour identical to current app.
2. **N = 2 switch:** pick the other mower → Home activity / Map polygon / Joystick SN / Schedule list / History records all reflect the newly selected SN.
3. **Offline selection:** select an offline mower → Home shows last-known state with a red dot, MQTT commands are blocked by existing online-guards.
4. **Persistence:** switch → kill the app → restart → same mower is active.
5. **Fallback:** switch to mower B → unbind B via dashboard → restart → first available mower becomes active, storage is rewritten.
6. **Logout → different user:** storage is cleared on logout; the new user's first mower becomes active.
7. **Provisioning during session:** bind a new mower → appears in dropdown without app restart, active selection is preserved.

## Server impact

None. The MQTT/socket pipeline already sends all devices for the authenticated user. The entire feature is client-side.
