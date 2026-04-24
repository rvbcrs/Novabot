# Light mode + theme switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a light palette + a three-way theme mode (auto / light / dark) to the React Native app, with settings UI, SecureStore persistence, and full coverage of all 30+ screens and components that currently import the static `colors` object.

**Architecture:** New `ThemeContext` provides `{mode, colorScheme, colors, setMode}`; new `useStyles(factory)` hook memoises StyleSheet objects against the current palette; all existing `StyleSheet.create({...})` sites migrate to `makeStyles((c) => ({...}))`; `AppSettingsScreen` gets an Appearance segment control; `'auto'` mode reads RN `useColorScheme()` so OS flips propagate automatically. Hero card (Home) and `MowingProgressMap` ship dedicated light-mode color sets (per visual choices B and C in the spec).

**Tech Stack:** React Native 0.74, Expo SDK 51, `expo-secure-store`, `@react-navigation/native`, `expo-status-bar`, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-04-24-light-mode-theme-switching-design.md`

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `app/src/theme/colors.ts` | Modify | Export `darkColors` + `lightColors` + `Colors` type. Keep old `colors` export as alias to `darkColors` (so nothing breaks mid-migration). |
| `app/src/theme/ThemeContext.tsx` | Create | Context, provider, `useTheme()` hook. Reads/writes `themeMode` in SecureStore, resolves `'auto'` via RN `useColorScheme()`. |
| `app/src/theme/useStyles.ts` | Create | `useStyles<T>(factory: (c: Colors) => T): T` hook. Memoises factory output against palette identity. |
| `app/src/theme/index.ts` | Create | Barrel re-exports: `colors`, `useTheme`, `useStyles`, `ThemeProvider`, types. |
| `app/App.tsx` | Modify | Wrap navigation in `<ThemeProvider>`, sync `NavigationContainer theme` + `StatusBar style` to `colorScheme`. |
| `app/src/screens/AppSettingsScreen.tsx` | Modify | Add Appearance section with 3-way segment control. |
| `app/src/i18n/{en,nl,de,fr}.ts` | Modify | Add `appearance*` i18n keys. |
| `app/src/screens/HomeScreen.tsx` | Modify | Hero card reads `colorScheme`, swaps gradient + text colors. Migrate to `useStyles`. |
| `app/src/components/MowingProgressMap.tsx` | Modify | SVG colors pick a light variant when `colorScheme === 'light'`. Migrate to `useStyles`. |
| All other 28 screens + components listed in Tasks 7–9 | Modify | Migrate from `import { colors }` + `StyleSheet.create` to `useStyles(makeStyles)`. |

Migration touches ~30 files. To keep subagent context small, split into three batches by file type / risk (components, simple screens, complex screens).

---

## Task 1: Theme infrastructure

**Files:**
- Modify: `app/src/theme/colors.ts`
- Create: `app/src/theme/ThemeContext.tsx`
- Create: `app/src/theme/useStyles.ts`
- Create: `app/src/theme/index.ts`

- [ ] **Step 1: Replace `app/src/theme/colors.ts` in full with:**

```ts
// Palette definitions. Both objects MUST have identical keys so Colors type
// is enforced by TypeScript at compile time.
export const darkColors = {
  bg: '#030712',
  card: '#16213e',
  cardBorder: 'rgba(255,255,255,0.1)',
  text: '#e0e0e0',
  textDim: '#9ca3af',
  textMuted: '#7d8694',
  emerald: '#00d4aa',
  emeraldDark: '#047857',
  purple: '#7c3aed',
  teal: '#0d9488',
  amber: '#f59e0b',
  red: '#ef4444',
  blue: '#3b82f6',
  white: '#ffffff',
  green: '#22c55e',
  inputBg: 'rgba(17,24,39,0.8)',
  inputBorder: 'rgba(255,255,255,0.1)',
};

export const lightColors = {
  bg: '#faf8f3',
  card: '#ffffff',
  cardBorder: '#e8e2d0',
  text: '#2a2620',
  textDim: '#8a7a4d',
  textMuted: '#a39680',
  emerald: '#00a688',
  emeraldDark: '#047857',
  purple: '#7c3aed',
  teal: '#0d9488',
  amber: '#b88810',
  red: '#dc2626',
  blue: '#2563eb',
  white: '#ffffff',
  green: '#16a34a',
  inputBg: '#ffffff',
  inputBorder: '#e8e2d0',
};

export type Colors = typeof darkColors;

// Back-compat export — so files that haven't been migrated yet keep working
// against the dark palette. Remove after full migration is done.
export const colors: Colors = darkColors;
```

- [ ] **Step 2: Create `app/src/theme/ThemeContext.tsx`:**

```tsx
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { darkColors, lightColors, type Colors } from './colors';

export type ThemeMode = 'auto' | 'light' | 'dark';
export type ColorScheme = 'light' | 'dark';

interface ThemeContextValue {
  mode: ThemeMode;
  colorScheme: ColorScheme;
  colors: Colors;
  setMode: (mode: ThemeMode) => Promise<void>;
}

const STORAGE_KEY = 'themeMode';
const DEFAULT_MODE: ThemeMode = 'auto';

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(DEFAULT_MODE);
  const systemScheme = useColorScheme(); // 'light' | 'dark' | null

  // Load persisted mode once on mount.
  useEffect(() => {
    SecureStore.getItemAsync(STORAGE_KEY)
      .then((value) => {
        if (value === 'auto' || value === 'light' || value === 'dark') {
          setModeState(value);
        }
      })
      .catch((err) => {
        // Non-fatal: fall back to default. First-launch UX unaffected.
        console.warn('[theme] SecureStore read failed:', err);
      });
  }, []);

  const setMode = useCallback(async (next: ThemeMode) => {
    setModeState(next);
    try {
      await SecureStore.setItemAsync(STORAGE_KEY, next);
    } catch (err) {
      // Non-fatal: keep the in-memory change so the user still sees the
      // new palette this session.
      console.warn('[theme] SecureStore write failed:', err);
    }
  }, []);

  const colorScheme: ColorScheme = useMemo(() => {
    if (mode === 'auto') return systemScheme === 'light' ? 'light' : 'dark';
    return mode;
  }, [mode, systemScheme]);

  const palette = colorScheme === 'light' ? lightColors : darkColors;

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, colorScheme, colors: palette, setMode }),
    [mode, colorScheme, palette, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
```

- [ ] **Step 3: Create `app/src/theme/useStyles.ts`:**

```ts
import { useMemo } from 'react';
import { useTheme } from './ThemeContext';
import type { Colors } from './colors';

/**
 * Hook that returns a StyleSheet object memoised against the current
 * palette. The factory is only re-run when the palette identity changes
 * (i.e. when the user flips theme mode).
 *
 * Usage:
 *   const makeStyles = (c: Colors) => StyleSheet.create({
 *     container: { backgroundColor: c.bg },
 *   });
 *   function MyScreen() {
 *     const styles = useStyles(makeStyles);
 *     return <View style={styles.container} />;
 *   }
 */
export function useStyles<T>(factory: (c: Colors) => T): T {
  const { colors } = useTheme();
  return useMemo(() => factory(colors), [colors, factory]);
}
```

- [ ] **Step 4: Create `app/src/theme/index.ts` barrel:**

```ts
export { darkColors, lightColors, colors } from './colors';
export type { Colors } from './colors';
export { ThemeProvider, useTheme } from './ThemeContext';
export type { ThemeMode, ColorScheme } from './ThemeContext';
export { useStyles } from './useStyles';
```

- [ ] **Step 5: Typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | head -30`
Expected: no new errors. Pre-existing errors unrelated to these files may exist — ignore them but note them in the task report.

- [ ] **Step 6: Commit**

```bash
git add app/src/theme/colors.ts app/src/theme/ThemeContext.tsx app/src/theme/useStyles.ts app/src/theme/index.ts
git commit -m "feat(theme): add ThemeContext + useStyles + light palette

Extends theme with lightColors palette (warm/natural off-white from
spec), a ThemeProvider that persists 'auto'|'light'|'dark' mode to
expo-secure-store, and a useStyles(makeStyles) hook that memoises
StyleSheet output against the current palette.

Back-compat: the existing 'colors' export is aliased to darkColors so
unmigrated files keep rendering the current dark theme during migration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: App root integration

**Files:**
- Modify: `app/App.tsx` (wrap navigation, wire NavigationContainer theme, flip status bar)

- [ ] **Step 1: Read current App.tsx**

Read `app/App.tsx` in full. Find the `<NavigationContainer>` render site, the `DarkTheme` definition that currently reads `colors`, the `<StatusBar>` element, and where `DemoProvider`/`DevModeProvider` are nested. `ThemeProvider` must wrap all of those so they can consume theme.

- [ ] **Step 2: Replace the theme + NavigationContainer wiring**

Find the `const DarkTheme = { ...DefaultTheme, ... };` block (near line 71). Replace with a function that builds a theme for either scheme:

```tsx
import { DefaultTheme, DarkTheme as RNDarkTheme } from '@react-navigation/native';
import { ThemeProvider, useTheme } from './src/theme';

function buildNavTheme(colorScheme: 'light' | 'dark', c: import('./src/theme').Colors) {
  const base = colorScheme === 'dark' ? RNDarkTheme : DefaultTheme;
  return {
    ...base,
    dark: colorScheme === 'dark',
    colors: {
      ...base.colors,
      primary: c.emerald,
      background: c.bg,
      card: c.bg,
      text: c.text,
      border: c.cardBorder,
      notification: c.emerald,
    },
  };
}
```

Note the import change: `DarkTheme as RNDarkTheme` because our in-file `DarkTheme` variable is replaced by the builder.

Remove the old static `const DarkTheme = {...}`.

- [ ] **Step 3: Thread the theme through the navigation tree**

Wrap the existing app tree in `<ThemeProvider>` at the outermost render. The current root returns something like `<DemoProvider><DevModeProvider><NavigationContainer>...</NavigationContainer></DevModeProvider></DemoProvider>` — insert `<ThemeProvider>` as the outermost provider (it should wrap everything so DevModeProvider's colour-using bits and NavigationContainer both see the context).

Create a small inner component that actually reads theme and renders the navigator:

```tsx
function ThemedApp() {
  const { colorScheme, colors: c } = useTheme();
  const navTheme = useMemo(() => buildNavTheme(colorScheme, c), [colorScheme, c]);
  const screenOptions = useMemo(() => ({
    headerShown: false,
    contentStyle: { backgroundColor: c.bg },
    animation: 'slide_from_right' as const,
  }), [c.bg]);

  return (
    <NavigationContainer theme={navTheme}>
      {/* existing stack/tab/screens — pass screenOptions down as before */}
    </NavigationContainer>
  );
}
```

The outer `App` component becomes:

```tsx
export default function App() {
  return (
    <ThemeProvider>
      <DemoProvider>
        <DevModeProvider>
          <PatternProvider>
            <ExperimentalProvider>
              <ActiveMowerProvider>
                <I18nProvider>
                  <GestureHandlerRootView style={{ flex: 1 }}>
                    <ThemedApp />
                    <StatusBarThemed />
                  </GestureHandlerRootView>
                </I18nProvider>
              </ActiveMowerProvider>
            </ExperimentalProvider>
          </PatternProvider>
        </DevModeProvider>
      </DemoProvider>
    </ThemeProvider>
  );
}
```

(Provider nesting should mirror what was there before — just add `ThemeProvider` as the outermost.)

- [ ] **Step 4: Flip StatusBar + NavigationBar**

Add a `StatusBarThemed` helper that reads scheme:

```tsx
function StatusBarThemed() {
  const { colorScheme } = useTheme();
  return <StatusBar style={colorScheme === 'light' ? 'dark' : 'light'} />;
}
```

If there's an Android `NavigationBar.setBackgroundColorAsync(...)` or `.setButtonStyleAsync(...)` call, update it to read from `useTheme()` similarly — adjust inside `ThemedApp`'s initial effect.

- [ ] **Step 5: Typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | head -30`
Expected: no new errors near App.tsx.

- [ ] **Step 6: Commit**

```bash
git add app/App.tsx
git commit -m "feat(theme): wire ThemeProvider into App root

Navigation theme and status bar style now react to the active color
scheme. All existing providers nest inside ThemeProvider so screens
can call useTheme() anywhere.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Appearance settings UI

**Files:**
- Modify: `app/src/screens/AppSettingsScreen.tsx`
- Modify: `app/src/i18n/en.ts`
- Modify: `app/src/i18n/nl.ts`
- Modify: `app/src/i18n/de.ts`
- Modify: `app/src/i18n/fr.ts`

- [ ] **Step 1: Add i18n keys — en.ts**

Open `app/src/i18n/en.ts`. Find the `edgeCutting: 'Edge cutting',` line from the previous task. Below the activity-state cluster (around `mapping: 'Mapping'`), insert:

```ts
  // Appearance
  appearance: 'Appearance',
  appearanceAuto: 'Auto',
  appearanceLight: 'Light',
  appearanceDark: 'Dark',
  appearanceAutoCaption: 'Auto follows your system setting.',
  appearanceLightCaption: 'Light mode is always on.',
  appearanceDarkCaption: 'Dark mode is always on.',
```

- [ ] **Step 2: Add i18n keys — nl.ts**

Open `app/src/i18n/nl.ts`. Add the same shape:

```ts
  appearance: 'Uiterlijk',
  appearanceAuto: 'Auto',
  appearanceLight: 'Licht',
  appearanceDark: 'Donker',
  appearanceAutoCaption: 'Auto volgt je systeeminstelling.',
  appearanceLightCaption: 'Lichte modus staat altijd aan.',
  appearanceDarkCaption: 'Donkere modus staat altijd aan.',
```

- [ ] **Step 3: Add i18n keys — de.ts**

```ts
  appearance: 'Erscheinungsbild', appearanceAuto: 'Auto', appearanceLight: 'Hell', appearanceDark: 'Dunkel',
  appearanceAutoCaption: 'Auto folgt deiner Systemeinstellung.',
  appearanceLightCaption: 'Heller Modus ist immer aktiv.',
  appearanceDarkCaption: 'Dunkler Modus ist immer aktiv.',
```

- [ ] **Step 4: Add i18n keys — fr.ts**

```ts
  appearance: 'Apparence', appearanceAuto: 'Auto', appearanceLight: 'Clair', appearanceDark: 'Sombre',
  appearanceAutoCaption: 'Auto suit le réglage de votre système.',
  appearanceLightCaption: 'Le mode clair est toujours activé.',
  appearanceDarkCaption: 'Le mode sombre est toujours activé.',
```

- [ ] **Step 5: Add Appearance section to AppSettingsScreen.tsx**

Open `app/src/screens/AppSettingsScreen.tsx`. Near the top (above Language, per spec), insert a new section. The component should use `useTheme()` + `useStyles()` — migrate its existing styles to the new pattern too (this is also part of the general migration but we do it here because the file is being touched for the new section anyway).

At the top of the file, replace:
```tsx
import { colors } from '../theme/colors';
```
with:
```tsx
import { useTheme, useStyles, type Colors, type ThemeMode } from '../theme';
```

Inside the component body, at the top:
```tsx
const { t } = useI18n();
const { mode, setMode, colors } = useTheme();
const styles = useStyles(makeStyles);
```

Add a helper render above the existing settings sections:

```tsx
const modes: ThemeMode[] = ['auto', 'light', 'dark'];
const modeLabel: Record<ThemeMode, string> = {
  auto: t('appearanceAuto'),
  light: t('appearanceLight'),
  dark: t('appearanceDark'),
};
const captionKey = {
  auto: 'appearanceAutoCaption',
  light: 'appearanceLightCaption',
  dark: 'appearanceDarkCaption',
}[mode];

return (
  <ScrollView style={styles.container} contentContainerStyle={styles.content}>
    {/* Appearance section */}
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('appearance')}</Text>
      <View style={styles.segment}>
        {modes.map((m) => (
          <TouchableOpacity
            key={m}
            style={[styles.segmentItem, m === mode && styles.segmentItemActive]}
            onPress={() => { setMode(m); }}
            activeOpacity={0.7}
          >
            <Text style={[styles.segmentLabel, m === mode && styles.segmentLabelActive]}>
              {modeLabel[m]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.segmentCaption}>{t(captionKey as any)}</Text>
    </View>
    {/* ... existing sections: Language, etc. ... */}
  </ScrollView>
);
```

Add styles inside the `makeStyles` factory:

```tsx
const makeStyles = (c: Colors) => StyleSheet.create({
  // ... existing styles migrated to use c.x ...
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: c.textDim,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  segment: {
    flexDirection: 'row',
    backgroundColor: c.card,
    borderRadius: 10,
    padding: 4,
    borderWidth: 1,
    borderColor: c.cardBorder,
  },
  segmentItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 7,
  },
  segmentItemActive: {
    backgroundColor: c.emerald,
  },
  segmentLabel: {
    fontSize: 14,
    color: c.textDim,
    fontWeight: '600',
  },
  segmentLabelActive: {
    color: c.white,
  },
  segmentCaption: {
    fontSize: 12,
    color: c.textMuted,
    marginTop: 8,
    marginLeft: 4,
  },
});
```

Convert all other `colors.x` references in the file to `c.x` inside the factory (style objects) or to destructured `colors.x` from the hook (for inline JSX props like icon `color={colors.emerald}`).

- [ ] **Step 6: Typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | head -20`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add app/src/screens/AppSettingsScreen.tsx app/src/i18n/en.ts app/src/i18n/nl.ts app/src/i18n/de.ts app/src/i18n/fr.ts
git commit -m "feat(app): Appearance section in AppSettings (auto/light/dark)

Three-way segment control backed by useTheme().setMode. Localised in
en/nl/de/fr. AppSettingsScreen itself now uses useStyles so the
appearance toggle updates live when the user flips mode.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Hero card light variant

**Files:**
- Modify: `app/src/screens/HomeScreen.tsx` (hero card block — gradient + text colors)

- [ ] **Step 1: Find the hero card render**

Open `app/src/screens/HomeScreen.tsx`. Find the mower illustration / battery gradient card (it renders the green gradient + battery % chip, typically near the top of the screen — search for `LinearGradient` + battery `%`).

- [ ] **Step 2: Add a scheme-aware palette local to the component**

Near the top of `HomeScreen.tsx` add:

```tsx
import { useTheme } from '../theme';

const HERO_PALETTE = {
  dark: {
    gradientFrom: '#1a3d2e',
    gradientTo: '#0f2d20',
    text: '#ffffff',
    chipBg: 'rgba(255,255,255,0.18)',
    chipText: '#ffffff',
  },
  light: {
    gradientFrom: '#d4f0d4',
    gradientTo: '#a8d5aa',
    text: '#1b3a1d',
    chipBg: 'rgba(27,58,29,0.12)',
    chipText: '#1b3a1d',
  },
};
```

- [ ] **Step 3: Read scheme in the component and pass to hero**

Inside `HomeScreen` body, at the top:

```tsx
const { colorScheme } = useTheme();
const hero = HERO_PALETTE[colorScheme];
```

Pass `hero` to the hero card render (either as props to a sub-component or directly in JSX):

```tsx
<LinearGradient
  colors={[hero.gradientFrom, hero.gradientTo]}
  style={styles.heroCard}
>
  {/* mower illustration + battery chip */}
  <View style={[styles.batteryChip, { backgroundColor: hero.chipBg }]}>
    <Text style={[styles.batteryChipText, { color: hero.chipText }]}>
      {mower.battery}%
    </Text>
  </View>
</LinearGradient>
```

The existing `styles.heroCard` / `styles.batteryChip` from `makeStyles` stays — only the colors are overridden via inline props.

- [ ] **Step 4: Typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | grep HomeScreen | head -10`
Expected: no errors referencing the hero card area.

- [ ] **Step 5: Commit**

```bash
git add app/src/screens/HomeScreen.tsx
git commit -m "feat(home): light-mode pastel-green hero card

Gradient, battery-chip background and text colour now swap to the
pastel variant when colorScheme === 'light' (per spec visual choice B).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: MowingProgressMap light variant

**Files:**
- Modify: `app/src/components/MowingProgressMap.tsx`

- [ ] **Step 1: Find the SVG colour references**

Open `app/src/components/MowingProgressMap.tsx`. Identify every hard-coded colour used for: canvas background, polygon stroke + fill, trail stroke, mower marker, charger marker, planned-path strokes.

- [ ] **Step 2: Add a scheme-aware map palette**

Near the top of the file:

```tsx
import { useTheme } from '../theme';

const MAP_PALETTE = {
  dark: {
    canvasBg: '#0f172a',
    canvasBorder: 'rgba(255,255,255,0.08)',
    polygonStroke: '#22c55e',
    polygonFill: 'rgba(34,197,94,0.18)',
    trailStroke: '#22c55e',
    mowerFill: '#16a34a',
    mowerStroke: '#ffffff',
    chargerFill: '#f59e0b',
    chargerStroke: '#ffffff',
    plannedStroke: 'rgba(255,255,255,0.35)',
    finishedFill: 'rgba(34,197,94,0.18)',
  },
  light: {
    canvasBg: '#eaf5d9',
    canvasBorder: '#c9d8a8',
    polygonStroke: '#16a34a',
    polygonFill: 'rgba(34,197,94,0.25)',
    trailStroke: '#15803d',
    mowerFill: '#ffffff',
    mowerStroke: '#15803d',
    chargerFill: '#f59e0b',
    chargerStroke: '#ffffff',
    plannedStroke: 'rgba(21,128,61,0.45)',
    finishedFill: 'rgba(22,163,74,0.28)',
  },
};
```

The exact per-key defaults on the dark side should be read out of the current file's literals before replacing — use what's there now, not guesses.

- [ ] **Step 3: Read scheme + switch palette**

Inside the component body, early in the render:

```tsx
const { colorScheme } = useTheme();
const palette = MAP_PALETTE[colorScheme];
```

Replace every hard-coded colour in the SVG with `palette.<key>`. For `StyleSheet` entries that use colours (canvas container `backgroundColor`, `borderColor`), migrate those to the `makeStyles` factory pattern so they also update when mode flips:

```tsx
const makeStyles = (c: Colors) => StyleSheet.create({
  canvas: {
    backgroundColor: 'transparent', // palette.canvasBg applied via prop
    // ...
  },
});
```

Note: for colours that don't belong in `c` (palette is map-specific), keep them as inline styles with `palette.canvasBg`.

- [ ] **Step 4: Typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | grep MowingProgressMap | head -10`
Expected: no errors referencing the file.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/MowingProgressMap.tsx
git commit -m "feat(map): light-mode palette for MowingProgressMap

Light green canvas (#eaf5d9) with darker polygon/trail colours per
spec visual choice C. Dark palette kept exactly as-is.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Migrate components batch (14 files)

**Files (one big batch — mechanical migration):**
- Modify: `app/src/components/AppActionSheet.tsx`
- Modify: `app/src/components/BatteryRing.tsx`
- Modify: `app/src/components/CuttingHeightPickerModal.tsx`
- Modify: `app/src/components/DemoBanner.tsx`
- Modify: `app/src/components/JoystickControl.tsx`
- Modify: `app/src/components/LiveMapView.tsx`
- Modify: `app/src/components/MowerPickerChevron.tsx`
- Modify: `app/src/components/MowerScene.tsx`
- Modify: `app/src/components/MowingDirectionPreview.tsx`
- Modify: `app/src/components/PatternPicker.tsx`
- Modify: `app/src/components/RainOverlay.tsx`
- Modify: `app/src/components/SimpleSlider.tsx`
- Modify: `app/src/components/StartMowSheet.tsx`
- (MowingProgressMap was done in Task 5 — skip here.)

For each file, apply the same pattern. Example (`AppActionSheet.tsx`):

- [ ] **Step 1: Replace the colors import**

Old:
```tsx
import { colors } from '../theme/colors';
```
New:
```tsx
import { useStyles, type Colors } from '../theme';
```

(If the component also uses `colors.x` inline in JSX props, also add `useTheme`.)

- [ ] **Step 2: Wrap the StyleSheet in a factory**

Old:
```tsx
const styles = StyleSheet.create({
  container: { backgroundColor: colors.bg },
  // ...
});
```
New:
```tsx
const makeStyles = (c: Colors) => StyleSheet.create({
  container: { backgroundColor: c.bg },
  // ...
});
```

Replace every `colors.x` inside the style object with `c.x`.

- [ ] **Step 3: Read styles in the component body**

At the top of the component:
```tsx
function AppActionSheet(props: Props) {
  const styles = useStyles(makeStyles);
  // ...
}
```

If the file also has `colors.x` used inline (e.g. `<Ionicons color={colors.emerald} />`), add `const { colors } = useTheme();` at the top and replace those too.

- [ ] **Step 4: Repeat for each file in the list above.**

Batch approach: the changes are mechanical. Touch one file at a time, `npx tsc --noEmit` after each 3–4 files to catch drift, fix, continue.

- [ ] **Step 5: Final typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | head -30`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/components
git commit -m "refactor(app): migrate 13 components to useStyles pattern

Mechanical migration of AppActionSheet, BatteryRing, CuttingHeightPickerModal,
DemoBanner, JoystickControl, LiveMapView, MowerPickerChevron, MowerScene,
MowingDirectionPreview, PatternPicker, RainOverlay, SimpleSlider,
StartMowSheet from static colors import to useStyles(makeStyles). All
components now re-render with the active palette when theme mode changes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Migrate simple screens batch (10 files)

**Files:**
- Modify: `app/src/screens/LoginScreen.tsx`
- Modify: `app/src/screens/RegisterScreen.tsx`
- Modify: `app/src/screens/SettingsScreen.tsx`
- Modify: `app/src/screens/WifiScreen.tsx`
- Modify: `app/src/screens/MessagesScreen.tsx`
- Modify: `app/src/screens/ProvisionScreen.tsx`
- Modify: `app/src/screens/BleScanScreen.tsx`
- Modify: `app/src/screens/HistoryScreen.tsx`
- Modify: `app/src/screens/DeviceChoiceScreen.tsx`
- Modify: `app/src/screens/MowerSettingsScreen.tsx`

For each screen, apply the exact same 4-step pattern as Task 6:

- [ ] **Step 1: Change import**

Old: `import { colors } from '../theme/colors';`
New: `import { useStyles, useTheme, type Colors } from '../theme';`

(Include `useTheme` only if the file uses `colors.x` inline outside StyleSheet.)

- [ ] **Step 2: Wrap StyleSheet in `makeStyles = (c: Colors) => ...`**

Replace every `colors.x` inside the style object with `c.x`.

- [ ] **Step 3: Add `const styles = useStyles(makeStyles);` inside component**

- [ ] **Step 4: Replace inline `colors.x` with destructured `const { colors } = useTheme();`**

Repeat per file. Typecheck after each 3 files with `cd app && npx tsc --noEmit 2>&1 | head -20`.

- [ ] **Step 5: Final typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | head -30`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add app/src/screens/LoginScreen.tsx app/src/screens/RegisterScreen.tsx \
  app/src/screens/SettingsScreen.tsx app/src/screens/WifiScreen.tsx \
  app/src/screens/MessagesScreen.tsx app/src/screens/ProvisionScreen.tsx \
  app/src/screens/BleScanScreen.tsx app/src/screens/HistoryScreen.tsx \
  app/src/screens/DeviceChoiceScreen.tsx app/src/screens/MowerSettingsScreen.tsx
git commit -m "refactor(app): migrate 10 simple screens to useStyles

Login, Register, Settings, Wifi, Messages, Provision, BleScan, History,
DeviceChoice, MowerSettings now consume the theme context. Palette
flips propagate without reload.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Migrate complex screens batch (6 files)

**Files:**
- Modify: `app/src/screens/HomeScreen.tsx` (already touched in Task 4 for hero — complete the remaining styles migration)
- Modify: `app/src/screens/MapScreen.tsx`
- Modify: `app/src/screens/CameraScreen.tsx`
- Modify: `app/src/screens/JoystickScreen.tsx`
- Modify: `app/src/screens/ScheduleScreen.tsx`
- Modify: `app/src/screens/OtaScreen.tsx`
- Modify: `app/src/screens/MappingScreen.tsx`

Same 4-step pattern as Tasks 6–7. These screens are longer (HomeScreen is 2000+ lines) so touch them one at a time, typecheck after each.

- [ ] **Step 1: HomeScreen.tsx — migrate remaining StyleSheet.create**

In Task 4 the hero palette was added but the whole-file StyleSheet migration was left. Now:
- Change `import { colors } from '../theme/colors';` → `import { useStyles, useTheme, type Colors } from '../theme';` (keep `useTheme` — already added in Task 4).
- Wrap the existing `const styles = StyleSheet.create({...});` in `const makeStyles = (c: Colors) => StyleSheet.create({...});` and replace every `colors.x` with `c.x`.
- Inside the component: `const styles = useStyles(makeStyles);`.
- Inline `colors.x` in JSX props / icon `color=` / SVG `fill=` → `colors.x` destructured from `useTheme()`.

- [ ] **Step 2: MapScreen.tsx**

Same pattern. Note this file also renders MowingProgressMap — ensure that component stays rendered with its new scheme-aware palette from Task 5 (should be automatic once MapScreen passes no hard-coded colour props).

- [ ] **Step 3: CameraScreen.tsx**

Same pattern.

- [ ] **Step 4: JoystickScreen.tsx**

Same pattern. This screen also renders `JoystickControl` (done in Task 6) — just migrate the screen's own styles.

- [ ] **Step 5: ScheduleScreen.tsx**

Same pattern.

- [ ] **Step 6: OtaScreen.tsx**

Same pattern.

- [ ] **Step 7: MappingScreen.tsx**

Same pattern. This screen has significant custom rendering (BLE + mapping workflow) — watch for inline colour usage in Svg `stroke`/`fill` props.

- [ ] **Step 8: Typecheck after every file**

Run: `cd app && npx tsc --noEmit 2>&1 | head -20`
Expected: no new errors per file.

- [ ] **Step 9: Commit**

```bash
git add app/src/screens/HomeScreen.tsx app/src/screens/MapScreen.tsx \
  app/src/screens/CameraScreen.tsx app/src/screens/JoystickScreen.tsx \
  app/src/screens/ScheduleScreen.tsx app/src/screens/OtaScreen.tsx \
  app/src/screens/MappingScreen.tsx
git commit -m "refactor(app): migrate complex screens to useStyles

Home, Map, Camera, Joystick, Schedule, Ota, Mapping now use useStyles
+ useTheme. Only the static 'colors' back-compat alias in theme/colors.ts
remains for any stragglers.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Remove back-compat alias + verify

**Files:**
- Modify: `app/src/theme/colors.ts` (remove the `colors` alias export)

- [ ] **Step 1: Grep for stragglers**

Run: `grep -rnE "import.*colors.*from.*theme/colors|from '\.\./theme/colors'" app/src 2>/dev/null | head -20`
Expected: empty (no files still importing `colors` directly).

If stragglers exist, migrate them (same 4-step pattern as Tasks 6–8).

- [ ] **Step 2: Remove the back-compat alias**

Open `app/src/theme/colors.ts`. Delete the trailing block:

```ts
export const colors: Colors = darkColors;
```

and update the barrel `app/src/theme/index.ts` — remove `colors` from the re-export.

- [ ] **Step 3: Typecheck**

Run: `cd app && npx tsc --noEmit 2>&1 | head -30`
Expected: no errors. If any file still references `colors` from the theme module, fix it (either migrate or import from `useTheme`).

- [ ] **Step 4: Commit**

```bash
git add app/src/theme/colors.ts app/src/theme/index.ts
git commit -m "refactor(theme): drop back-compat 'colors' alias — all files migrated

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Live smoke test + fixes

This task is **manual** — the user drives the app via Expo/Metro. No subagent dispatch.

**Pre-conditions:**
- App running on a physical device or simulator via `npx expo start`.
- Server online (edge-cut sessions etc. don't affect the theme test directly).

- [ ] **Step 1: Fresh install check**

Wipe SecureStore (uninstall + reinstall the app, or clear data). Launch. Expect mode = `'auto'`; effective scheme matches the phone's current Appearance setting.

- [ ] **Step 2: Mode switching**

Go to Settings → Appearance. Tap each of Auto / Light / Dark. After each tap:
- All visible screen elements re-render with the new palette.
- Status bar style flips (light text on dark bg, dark text on light bg).
- Bottom tab bar chrome flips (React Navigation theme).

- [ ] **Step 3: System auto flip**

Set mode to Auto. On the phone, toggle iOS/Android system dark mode (Settings → Display). The app palette follows the system within 1–2 seconds, no restart required.

- [ ] **Step 4: Persistence**

Set mode to Light. Kill the app (swipe away). Cold-start. The app should come up in Light directly.

- [ ] **Step 5: Per-screen smoke**

Walk through each screen in both Light and Dark:
- Home (hero gradient swaps per spec variant, map polygon swaps, status card colors match)
- Map (MowingProgressMap)
- Camera
- Joystick
- Schedule
- OTA
- Settings (self, AppSettings, MowerSettings)
- Messages, History, Wifi, BleScan, DeviceChoice, Provision, Register, Login, Mapping

Note any screen that shows "stuck" dark-mode colours (missed migration site).

- [ ] **Step 6: Contrast spot-check**

In Light mode:
- Body text on bg: `#2a2620` on `#faf8f3` → ~14:1 ratio ✓ (WCAG AAA).
- Secondary text `#8a7a4d` on `#faf8f3` → ~4.1:1 → OK for large text; marginal for ≤14pt body. If any screen uses `textDim` for body copy and it looks washed out, consider darkening to `#6b5d3a`.
- Accent reds/greens/ambers on white cards: verify badge text stays readable.

- [ ] **Step 7: Report any fixes needed**

If Step 5 or Step 6 reveals a missed migration or an unreadable combo, open a fix commit on the same branch for just that file. Keep commits focused.

- [ ] **Step 8: Final commit (optional — only if fixes were needed)**

```bash
git add app/src/<fixed-files>
git commit -m "fix(theme): <describe fix> — caught during light-mode smoke test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Palette definitions → Task 1 ✓
  - ThemeContext + useStyles → Task 1 ✓
  - App root wiring + NavigationContainer theme + StatusBar → Task 2 ✓
  - Appearance settings UI + i18n → Task 3 ✓
  - Hero card light variant → Task 4 ✓
  - MowingProgressMap light variant → Task 5 ✓
  - Migration of 30 files → Tasks 6, 7, 8 ✓
  - Remove back-compat alias → Task 9 ✓
  - Live test + WCAG check → Task 10 ✓
  - Out-of-scope (dashboard, server) → not addressed in any task ✓
- **Placeholder scan:** no "TBD", no "fill in later". Migration steps use a repeated 4-step pattern because all the files are mechanically identical — this repetition is intentional.
- **Type consistency:** `Colors`, `ThemeMode`, `ColorScheme` defined in Task 1, used identically thereafter. `makeStyles = (c: Colors) => StyleSheet.create({...})` signature is the same in every task.
- **Scope warning:** Tasks 6–8 touch 30 files. Subagent-driven execution is viable (each task is one batch) but the implementer must pace — commit-per-task not commit-per-file — or the reviewer will drown in diff. If the subagent runner has output-size limits, split Task 6 into two halves.
