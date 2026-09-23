/**
 * Server text: one sentence, four languages.
 *
 * Everything the server says to a person (API errors, status messages, the
 * connection diagnosis) goes through here. It used to be written in Dutch and
 * printed raw, so an English or German user got Dutch. Translating in the
 * clients was not an option: the admin panel renders server-side HTML and the
 * app and dashboard each have their own i18n.
 *
 * So the server writes in the reader's language. The Dutch sentence stays at
 * the call site, readable in context, and doubles as the catalog key:
 *
 *     T`${host} wijst naar deze server (${ip})`
 *       key -> "{0} wijst naar deze server ({1})"
 *
 * Numbered placeholders, not positional, because word order moves between
 * languages and a translation must be free to reorder them.
 *
 * In a request handler: `const T = reqT(req)`. The language comes from ?lang,
 * then the X-Lang header the dashboard and app send, then Accept-Language.
 *
 * Text that is stored and read later (a re-anchor phase, an auto-map error)
 * has no reader yet: build it with M`…` and render it with renderMsg() in the
 * handler that returns it, so each reader gets their own language.
 *
 * A sentence without an entry falls back to the Dutch original. That is a
 * safety net, not a feature: serverText.coverage.test.ts fails the build when a
 * sentence in the source is missing in any language.
 */
import { CATALOG as DIAGNOSIS_CATALOG } from './diagnosisText.catalog.js';
import { CATALOG as API_CATALOG } from './apiText.catalog.js';

export type Lang = 'nl' | 'en' | 'fr' | 'de';

export const LANGS: readonly Lang[] = ['nl', 'en', 'fr', 'de'];

/** Source language: the key IS the Dutch sentence, so it needs no entry. */
export const SOURCE_LANG: Lang = 'nl';

/** Without a usable language tag: English. Dutch only when asked for. */
export const DEFAULT_LANG: Lang = 'en';

export type CatalogEntry = { en: string; fr: string; de: string };
export type Catalog = Record<string, CatalogEntry>;

const CATALOG: Catalog = { ...DIAGNOSIS_CATALOG, ...API_CATALOG };

export interface Translate {
  (strings: TemplateStringsArray, ...values: unknown[]): string;
  (plain: string): string;
}

/** Accepts "en", "EN", "en-GB", "nl-NL,nl;q=0.9"; anything else is English. */
export function normalizeLang(raw: string | null | undefined): Lang {
  const head = (raw ?? '').trim().toLowerCase().split(/[-_,;]/)[0];
  return (LANGS as readonly string[]).includes(head) ? (head as Lang) : DEFAULT_LANG;
}

interface LangSource {
  query?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

/** The reader's language: ?lang, then X-Lang, then Accept-Language. */
export function langOf(req: LangSource): Lang {
  const pick = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const raw = pick(req.query?.lang) || pick(req.headers['x-lang']) || pick(req.headers['accept-language']);
  return normalizeLang(typeof raw === 'string' ? raw : '');
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

function lookup(lang: Lang, key: string, values: readonly unknown[]): string {
  if (lang === SOURCE_LANG) return fill(key, values);
  const entry = CATALOG[key] as Partial<Record<Lang, string>> | undefined;
  return fill(entry?.[lang] ?? key, values);
}

export function translate(lang: Lang, parts: readonly string[], values: readonly unknown[]): string {
  return lookup(lang, keyOf(parts), values);
}

export function translator(lang: Lang): Translate {
  return ((first: TemplateStringsArray | string, ...values: unknown[]) =>
    translate(lang, typeof first === 'string' ? [first] : Array.from(first), values)) as Translate;
}

/** Translator in the language of the request's reader. */
export function reqT(req: LangSource): Translate {
  return translator(langOf(req));
}

/** A sentence kept untranslated until someone reads it. JSON-safe. */
export interface Msg { key: string; values: unknown[] }

export function M(strings: TemplateStringsArray | string, ...values: unknown[]): Msg {
  return { key: typeof strings === 'string' ? strings : keyOf(Array.from(strings)), values };
}

export function renderMsg(lang: Lang, msg: Msg): string;
export function renderMsg(lang: Lang, msg: Msg | null | undefined): string | undefined;
export function renderMsg(lang: Lang, msg: Msg | null | undefined): string | undefined {
  return msg ? lookup(lang, msg.key, msg.values) : undefined;
}
