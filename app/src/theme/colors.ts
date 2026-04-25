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
  // Transparent so the App-level LinearGradient shows through every screen
  // container. Cards keep their own solid 'card' colour.
  bg: 'transparent',
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
