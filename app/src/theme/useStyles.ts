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
