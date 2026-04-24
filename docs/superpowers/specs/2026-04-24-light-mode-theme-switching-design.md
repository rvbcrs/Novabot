# Light mode + theme switching — Design

**Date:** 2026-04-24
**Status:** Proposed
**Scope target:** `app/` (React Native OpenNova app). Dashboard + server out of scope.

## Problem

The app ships dark-mode-only. `app/src/theme/colors.ts` exports a single static `colors` object that 30+ files import at module-load time via `StyleSheet.create({...})`. Users have no way to switch to a lighter look, and the palette has no variant for environments with bright ambient light. Add light mode + a three-way mode toggle (auto / light / dark) in settings, persist the choice, and default to auto (follows OS Appearance) on first launch.

## Architecture

- **`app/src/theme/colors.ts`** exports two palettes with identical keys: `lightColors` and `darkColors`. Current palette becomes `darkColors` unchanged. Light palette is the "warm / natural" off-white variant.
- **`app/src/theme/ThemeContext.tsx`** provides:
  - `mode: 'auto' | 'light' | 'dark'` — the user's preference
  - `colorScheme: 'light' | 'dark'` — the effective scheme (auto resolves via RN `useColorScheme()`)
  - `colors: Colors` — the palette for the effective scheme
  - `setMode(mode)` — persists to SecureStore key `themeMode` and re-renders
- **`app/src/theme/useStyles.ts`** — hook: `useStyles<T>(factory: (c: Colors) => T): T`. Memoises the style object against the current palette so components only rebuild styles when the palette actually changes.
- **`app/App.tsx` / navigation root** — wraps the navigator in `<ThemeProvider>`. Provider runs SecureStore read on mount and sets initial mode (falls back to `'auto'` if nothing stored). Navigation theme (`@react-navigation/native`'s `DarkTheme`/`DefaultTheme`) syncs to the effective scheme so system chrome (status bar, headers) matches.
- **`expo-status-bar`** — prop `style={colorScheme === 'light' ? 'dark' : 'light'}` so the status-bar text flips correctly.

## Light palette (warm / natural, per visual choice A)

Matches `Colors` type from current dark palette, key-for-key.

```ts
export const lightColors = {
  bg:          '#faf8f3',
  card:        '#ffffff',
  cardBorder:  '#e8e2d0',
  text:        '#2a2620',
  textDim:     '#8a7a4d',
  textMuted:   '#a39680',
  emerald:     '#00a688',
  emeraldDark: '#047857',
  purple:      '#7c3aed',
  teal:        '#0d9488',
  amber:       '#b88810',
  red:         '#dc2626',
  blue:        '#2563eb',
  white:       '#ffffff',
  green:       '#16a34a',
  inputBg:     '#ffffff',
  inputBorder: '#e8e2d0',
};
```

Dark palette stays as-is (current `colors` renamed to `darkColors`).

All keys must exist in both palettes. Type `Colors = typeof darkColors` keeps this enforced.

## Per-component light-mode variants

A flat palette swap is not enough for three visual surfaces — they get explicit overrides.

### Hero card on Home (`HomeScreen.tsx`, mower illustration card)

Per visual choice B — pastel green gradient in light mode.

- Light mode gradient: `#d4f0d4 → #a8d5aa`
- Light mode foreground (battery chip text, subtitle): `#1b3a1d`
- Battery chip background: `rgba(27, 58, 29, 0.12)`
- Dark mode: unchanged (current dark green gradient, white text)

Implementation: hero component reads `colorScheme` from the theme and picks gradient + text colors from a local map.

### MowingProgressMap (`components/MowingProgressMap.tsx` or where the polygon SVG lives)

Per visual choice C — light green canvas with darker polygon/trail in light mode.

- Light mode canvas: `#eaf5d9`, canvas border `#c9d8a8`
- Polygon stroke: `#16a34a`, fill `rgba(34, 197, 94, 0.25)`
- Trail stroke: `#15803d`, stroke-width 2.5, round linecap
- Mower dot: white fill, `#15803d` stroke
- Charger marker: `#f59e0b` fill, white stroke
- Dark mode: unchanged

Implementation: component takes a `colorScheme` prop (or reads from context) and swaps an internal `mapStyles` object.

### Activity glow + status dots

`GLOW_COLOR` record per `MowerActivity` in `HomeScreen.tsx` remains the same in both modes (the rgba values already work on both dark and light bg because they're low-alpha accents). Only the text/chip colors around them flip via `colors.text` / `colors.card`.

## Mode switching

- **Storage:** `expo-secure-store` key `themeMode` — value is one of `'auto' | 'light' | 'dark'`.
- **Default on first launch:** `'auto'`.
- **`'auto'` resolution:** use RN `useColorScheme()` from `react-native`. That hook updates when the OS flips dark/light (system time-of-day or user toggle), so `ThemeContext` re-provides on change without explicit listener setup.
- **Transition:** instant. No cross-fade animation — RN's native-level color transitions are costly and the user-perceived benefit over instant swap is negligible.
- **Navigation chrome:** pass `theme` prop on `NavigationContainer` — `DarkTheme` when effective scheme is dark, `DefaultTheme` (light) otherwise. Ensures tab bar + headers flip.

## Settings UI

Add an **Appearance** section to `AppSettingsScreen.tsx`, rendered near the top (above Language) because it affects the visual choices below it.

```
┌─ Appearance ────────────────────────────┐
│                                         │
│   ┌──────┬───────┬──────┐               │
│   │ Auto │ Light │ Dark │  ← segment    │
│   └──────┴───────┴──────┘               │
│                                         │
│   Auto follows your system setting.     │
└─────────────────────────────────────────┘
```

- Segment control: 3-option horizontal pill. Active option filled with `colors.emerald`. Inactive options transparent with `colors.textDim` label.
- Caption under the segment changes with mode:
  - `auto` → "Auto follows your system setting."
  - `light` → "Light mode is always on."
  - `dark` → "Dark mode is always on."
- New i18n keys: `appearance`, `appearanceAuto`, `appearanceLight`, `appearanceDark`, `appearanceAutoCaption`, `appearanceLightCaption`, `appearanceDarkCaption`.
- Translations for en / nl / de / fr.

## Migration strategy

~30 files import `colors` and build `StyleSheet.create({...})` statically. Direct migration approach:

1. **Update imports site-by-site** from `import { colors } from '../theme/colors'` to `import { useStyles } from '../theme/useStyles'` + destructure `colors` from the factory argument.
2. **Wrap the style object** in a `makeStyles` function taking `c: Colors`:
   ```ts
   const makeStyles = (c: Colors) => StyleSheet.create({
     container: { backgroundColor: c.bg },
     ...
   });
   ```
3. **Inside the component**, `const styles = useStyles(makeStyles);` — this hook memoises against the current palette.
4. **Inline `colors.x` usages** (outside StyleSheet, e.g. icon props, SVG fills) switch to `const { colors } = useTheme()`.

Mechanical but large. Approach:

- **Codemod:** `app/scripts/migrate-styles.mjs` using `jscodeshift` or a simple regex pass. Covers: StyleSheet wrapper, colors imports, `colors.` references inside style objects. File-by-file, idempotent (skip already-migrated files).
- **Manual review:** per file after codemod — conditional styles, inline styles with `colors.x` outside StyleSheet, `Svg` fills passed as props.

The codemod is a helper, not a guaranteed full conversion. Every touched file gets a typecheck pass and a visual smoke test.

## Data flow

```
First launch
  SecureStore.getItemAsync('themeMode')
    → null → default 'auto'
  ThemeProvider sets mode = 'auto'

'auto' mode
  useColorScheme() → 'light' | 'dark' (from OS)
  colors = effective === 'light' ? lightColors : darkColors

User taps Dark in AppSettings
  setMode('dark')
    → SecureStore.setItemAsync('themeMode', 'dark')
    → state update → colors = darkColors
    → every consumer of useStyles re-memoises its stylesheet
    → every consumer of useTheme re-reads colors
    → screens re-render with new palette
```

## Error handling

- SecureStore read failure: fall back to `'auto'` silently, log a warning. First-launch UX is unaffected.
- SecureStore write failure: surface a non-blocking toast ("Could not save appearance setting") but keep the in-memory mode change so the user still gets the new look this session.
- Missing palette key on a component: TypeScript type `Colors = typeof darkColors` forces both palettes to have the same shape. CI typecheck catches drift.

## Testing

Live-only, no unit tests (the app has no test harness for UI). Verification per area:

1. First launch (fresh SecureStore) → mode should be `'auto'`, effective scheme matches OS setting.
2. Flip iOS/Android system dark-mode → app updates without restart.
3. Manually set Light / Dark / Auto → persists across cold restart.
4. Smoke-test each screen in each mode:
   - HomeScreen (hero gradient + map + status card + schedule strip)
   - MapScreen (MowingProgressMap in isolation)
   - CameraScreen
   - JoystickScreen
   - ScheduleScreen
   - AppSettingsScreen (new Appearance section)
   - OtaScreen, MessagesScreen, WifiScreen, DeviceChoiceScreen, etc.
5. WCAG AA contrast spot-check: `lightColors.text` on `lightColors.bg` ≥ 4.5:1; `lightColors.textDim` on `lightColors.bg` ≥ 3:1 (large-text threshold).

## Out of scope

- Dashboard web UI (separate React+Vite app, already has its own theme system).
- Server-side HTML (admin page) — stays on its current palette.
- Custom per-widget theming beyond the three explicit overrides (hero, map, status glow).
- Smooth color-interpolation transitions between modes.
- Per-setting color customisation (user picks accent colors, etc.).

## Open questions

- None outstanding. Palette, hero variant, map variant, default mode, architecture pattern, settings placement all chosen during brainstorm.
