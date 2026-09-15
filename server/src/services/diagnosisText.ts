/**
 * Diagnosis text — one sentence, four languages.
 *
 * The diagnosis was written in Dutch, and every consumer printed it raw. A
 * German user therefore got German headings above Dutch explanations, which is
 * the half that actually carries the answer. Translating in the dashboard was
 * not an option either: the admin panel renders server-side HTML and has no
 * react-i18next.
 *
 * So the server writes in the requested language. The Dutch sentence stays at
 * the call site, readable in context, and doubles as the catalog key:
 *
 *     T`${host} wijst naar deze server (${ip})`
 *       key -> "{0} wijst naar deze server ({1})"
 *
 * Numbered placeholders, not positional, because word order moves between
 * languages and a translation must be free to reorder them.
 *
 * A sentence without an entry falls back to the Dutch original. That is a
 * safety net, not a feature: diagnosisText.coverage.test.ts fails the build
 * when a sentence in the service is missing in any language.
 */
import { CATALOG } from './diagnosisText.catalog.js';

export type Lang = 'nl' | 'en' | 'fr' | 'de';

export const LANGS: readonly Lang[] = ['nl', 'en', 'fr', 'de'];

/** Source language: the key IS the Dutch sentence, so it needs no entry. */
export const SOURCE_LANG: Lang = 'nl';

export type CatalogEntry = { en: string; fr: string; de: string };
export type Catalog = Record<string, CatalogEntry>;

export interface Translate {
  (strings: TemplateStringsArray, ...values: unknown[]): string;
  (plain: string): string;
}

/** Accepts "en", "EN", "en-GB", anything else falls back to Dutch. */
export function normalizeLang(raw: string | null | undefined): Lang {
  const head = (raw ?? '').trim().toLowerCase().split(/[-_,;]/)[0];
  return (LANGS as readonly string[]).includes(head) ? (head as Lang) : SOURCE_LANG;
}

/** "a {0} b {1} c" from the static halves of a template literal. */
export function keyOf(parts: readonly string[]): string {
  let key = parts[0] ?? '';
  for (let i = 1; i < parts.length; i++) key += `{${i - 1}}` + parts[i];
  return key;
}

function fill(template: string, values: readonly unknown[]): string {
  return template.replace(/\{(\d+)\}/g, (whole, digits: string) => {
    const v = values[Number(digits)];
    return v === undefined ? whole : String(v);
  });
}

export function translate(lang: Lang, parts: readonly string[], values: readonly unknown[]): string {
  const key = keyOf(parts);
  if (lang === SOURCE_LANG) return fill(key, values);
  const entry = CATALOG[key] as Partial<Record<Lang, string>> | undefined;
  return fill(entry?.[lang] ?? key, values);
}

export function translator(lang: Lang): Translate {
  return ((first: TemplateStringsArray | string, ...values: unknown[]) =>
    translate(lang, typeof first === 'string' ? [first] : Array.from(first), values)) as Translate;
}
