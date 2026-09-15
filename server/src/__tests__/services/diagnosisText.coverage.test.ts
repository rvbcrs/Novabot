/**
 * The catalog must not drift behind the code.
 *
 * Adding a sentence to connectionDiagnosis.ts and forgetting the translation
 * is silent: the fallback prints the Dutch original, which is exactly the bug
 * this whole layer exists to remove. So the source is read and every sentence
 * it can produce is required to have an English entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { CATALOG } from '../../services/diagnosisText.catalog.js';
import { translate, keyOf, normalizeLang } from '../../services/diagnosisText.js';

const SERVICE = fileURLToPath(new URL('../../services/connectionDiagnosis.ts', import.meta.url));

/**
 * Every T`…` in the source, as the catalog key it produces: the static halves
 * with {0}, {1}, … where the interpolations sit. Interpolations are skipped
 * whole, strings and braces inside them included, so a ternary with quotes in
 * it does not end the literal early.
 */
function keysInSource(src: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < src.length; ) {
    const at = src.indexOf('T`', i);
    if (at < 0) break;
    const before = at > 0 ? src[at - 1] : ' ';
    if (/[\w$.]/.test(before)) { i = at + 2; continue; }

    const parts: string[] = [];
    let buf = '';
    let k = at + 2;
    let depth = 0;
    while (k < src.length) {
      const c = src[k];
      if (c === '\\') { buf += src.slice(k, k + 2); k += 2; continue; }
      if (depth === 0) {
        if (c === '$' && src[k + 1] === '{') { parts.push(buf); buf = ''; depth = 1; k += 2; continue; }
        if (c === '`') { k += 1; break; }
        buf += c; k += 1; continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        k += 1;
        while (k < src.length) {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === quote) { k += 1; break; }
          k += 1;
        }
        continue;
      }
      if (c === '{') depth += 1;
      else if (c === '}') { depth -= 1; if (depth === 0) { k += 1; continue; } }
      k += 1;
    }
    parts.push(buf);
    keys.push(keyOf(parts));
    i = k;
  }
  return keys;
}

const sourceKeys = [...new Set(keysInSource(readFileSync(SERVICE, 'utf8')))];

describe('diagnosis catalog', () => {
  it('finds the sentences in the service', () => {
    // A broken scanner would make every assertion below pass on an empty set.
    expect(sourceKeys.length).toBeGreaterThan(150);
    expect(sourceKeys).toContain('mqtt_node verbonden met de broker');
    expect(sourceKeys).toContain('{0} wijst naar deze server ({1})');
  });

  it('translates every sentence the service can produce', () => {
    const missing = sourceKeys.filter(k => !CATALOG[k]?.en);
    expect(missing).toEqual([]);
  });

  it('has no entries for sentences that no longer exist', () => {
    const orphans = Object.keys(CATALOG).filter(k => !sourceKeys.includes(k));
    expect(orphans).toEqual([]);
  });

  it('keeps every placeholder in every translation', () => {
    const slots = (s: string) => [...s.matchAll(/\{(\d+)\}/g)].map(m => m[1]).sort();
    const broken: string[] = [];
    for (const [key, entry] of Object.entries(CATALOG)) {
      for (const [lang, text] of Object.entries(entry)) {
        if (String(slots(key)) !== String(slots(text))) broken.push(`${lang}: ${key}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('translate', () => {
  it('returns the Dutch original unchanged', () => {
    expect(translate('nl', ['geen storing'], [])).toBe('geen storing');
    expect(translate('nl', ['storing ', ' actief'], [7])).toBe('storing 7 actief');
  });

  it('reorders placeholders as the translation asks', () => {
    // The point of numbering them: a language may put the values elsewhere.
    expect(translate('en', ['', ' MB vrij van ', ' MB (', '%)'], [10, 20, 50]))
      .toBe('10 MB free of 20 MB (50%)');
  });

  it('falls back to English for a language without its own entry', () => {
    expect(translate('de', ['geen storing'], [])).toBe('no fault');
    expect(translate('fr', ['geen storing'], [])).toBe('no fault');
  });

  it('falls back to the Dutch original for an unknown sentence', () => {
    expect(translate('en', ['deze zin staat nergens'], [])).toBe('deze zin staat nergens');
  });

  it('reads a browser language tag', () => {
    expect(normalizeLang('en-GB')).toBe('en');
    expect(normalizeLang('EN')).toBe('en');
    expect(normalizeLang('klingon')).toBe('nl');
    expect(normalizeLang(undefined)).toBe('nl');
  });
});
