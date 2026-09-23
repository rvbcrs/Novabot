/**
 * The catalogs must not drift behind the code.
 *
 * Adding a sentence anywhere in the server and forgetting the translation
 * is silent: the fallback prints the Dutch original, which is exactly the bug
 * this whole layer exists to remove. So the source is read and every sentence
 * it can produce is required to exist in every language.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { CATALOG as DIAGNOSIS_CATALOG } from '../../services/diagnosisText.catalog.js';
import { CATALOG as API_CATALOG } from '../../services/apiText.catalog.js';
import { translate, keyOf, normalizeLang, langOf, M, renderMsg } from '../../services/serverText.js';

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const CATALOG = { ...DIAGNOSIS_CATALOG, ...API_CATALOG };

/** Every server source file, tests and the translator itself (its docs show examples) excluded. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sourceFiles(p);
    return /\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && e.name !== 'serverText.ts' ? [p] : [];
  });
}

/**
 * Every T`…` in the source, as the catalog key it produces: the static halves
 * with {0}, {1}, … where the interpolations sit. Interpolations are skipped
 * whole, strings and braces inside them included, so a ternary with quotes in
 * it does not end the literal early.
 */
function keysInSource(src: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < src.length; ) {
    const tAt = src.indexOf('T`', i);
    const mAt = src.indexOf('M`', i);
    const at = tAt < 0 ? mAt : mAt < 0 ? tAt : Math.min(tAt, mAt);
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

/** T('…') and M('…') with a plain string: the string is the key. */
function plainKeysInSource(src: string): string[] {
  return [...src.matchAll(/(?<![\w$.])[TM]\(\s*'((?:[^'\\]|\\.)*)'\s*\)/g)].map(m => m[1].replace(/\\'/g, "'"));
}

const sources = sourceFiles(SRC).map(f => readFileSync(f, 'utf8'));
const sourceKeys = [...new Set(sources.flatMap(src => [...keysInSource(src), ...plainKeysInSource(src)]))];
const DUPLICATES = Object.keys(API_CATALOG).filter(k => k in DIAGNOSIS_CATALOG);

describe('server text catalog', () => {
  it('finds the sentences in the source', () => {
    // A broken scanner would make every assertion below pass on an empty set.
    expect(sourceKeys.length).toBeGreaterThan(150);
    expect(sourceKeys).toContain('mqtt_node verbonden met de broker');
    expect(sourceKeys).toContain('{0} wijst naar deze server ({1})');
  });

  it.each(['en', 'fr', 'de'] as const)('translates every sentence the service can produce into %s', lang => {
    const missing = sourceKeys.filter(k => !CATALOG[k]?.[lang]);
    expect(missing).toEqual([]);
  });

  it('keeps each sentence in one catalog only', () => {
    expect(DUPLICATES).toEqual([]);
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

  it('speaks French and German, not English with an accent', () => {
    expect(translate('de', ['geen storing'], [])).toBe('keine Störung');
    expect(translate('fr', ['geen storing'], [])).toBe('aucune panne');
  });

  it('renders a stored message in each reader\'s language', () => {
    const msg = M`storing ${7} actief`;
    expect(JSON.parse(JSON.stringify(msg))).toEqual({ key: 'storing {0} actief', values: [7] });
    expect(renderMsg('nl', msg)).toBe('storing 7 actief');
    expect(renderMsg('en', undefined)).toBeUndefined();
  });

  it('falls back to the Dutch original for an unknown sentence', () => {
    expect(translate('en', ['deze zin staat nergens'], [])).toBe('deze zin staat nergens');
  });

  it('reads a browser language tag', () => {
    expect(normalizeLang('en-GB')).toBe('en');
    expect(normalizeLang('EN')).toBe('en');
    expect(normalizeLang('nl-NL,nl;q=0.9,en;q=0.8')).toBe('nl');
    // Dutch only when asked for: an unknown or missing language is English.
    expect(normalizeLang('klingon')).toBe('en');
    expect(normalizeLang('sv-SE')).toBe('en');
    expect(normalizeLang(undefined)).toBe('en');
  });

  it('prefers ?lang, then X-Lang, then Accept-Language', () => {
    expect(langOf({ query: { lang: 'de' }, headers: { 'x-lang': 'fr', 'accept-language': 'nl' } })).toBe('de');
    expect(langOf({ query: {}, headers: { 'x-lang': 'fr', 'accept-language': 'nl' } })).toBe('fr');
    expect(langOf({ headers: { 'accept-language': 'nl-NL,nl;q=0.9' } })).toBe('nl');
    expect(langOf({ headers: {} })).toBe('en');
  });
});
