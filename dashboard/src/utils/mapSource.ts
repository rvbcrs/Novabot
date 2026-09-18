/**
 * Label for where a zone came from (#120). A driven boundary is the real
 * edge of the lawn; a drawn one is an estimate on aerial imagery, and the
 * mower has never been there. Unknown stays unknown.
 */
export type MapSource = 'mower' | 'drawn' | 'import';

export function sourceKey(source: MapSource | null | undefined): string | null {
  if (source === 'mower') return 'map.sourceMower';
  if (source === 'drawn') return 'map.sourceDrawn';
  if (source === 'import') return 'map.sourceImport';
  return null;
}

/** One character for the zone list, where there is no room for words. */
export function sourceMark(source: MapSource | null | undefined): string {
  if (source === 'drawn') return '✎';
  if (source === 'import') return '⇩';
  return '';
}
