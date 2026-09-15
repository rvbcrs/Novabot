import { describe, it, expect } from 'vitest';
import { adminPageHtml } from '../../routes/adminPage.js';

/**
 * The admin panel is one TypeScript template literal that emits HTML with a
 * large inline script. A single mistake in that script, and the whole page
 * renders nothing: the user sees a black screen with no error anywhere.
 *
 * That happened on 2026-09-15. A '\n' inside a JS string became a real line
 * break at generation time, because the template literal interprets it before
 * the browser ever sees it. It shipped in a release and three betas before
 * anyone opened the panel.
 *
 * So every inline script is parsed here, the same way the browser would.
 */
describe('admin panel inline scripts', () => {
  const html = adminPageHtml();
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1]);

  it('has inline scripts to check', () => {
    expect(scripts.length).toBeGreaterThan(0);
  });

  it('every inline script parses', () => {
    const problems: string[] = [];
    scripts.forEach((src, i) => {
      try {
        // Parse only, never run: Function() compiles the body without calling it.
        new Function(src);
      } catch (e) {
        problems.push(`script #${i}: ${(e as Error).message}`);
      }
    });
    expect(problems, problems.join('\n')).toEqual([]);
  });

  it('carries no raw line break inside a single-quoted JS string', () => {
    // The specific shape of the 2026-09-15 breakage, pinned on its own so the
    // message names it directly instead of "unexpected token".
    const bad = scripts.flatMap((src, i) =>
      src.split('\n')
        .map((line, n) => ({ line, n }))
        .filter(({ line }) => /'[^'\\]*$/.test(line.replace(/\/\/.*$/, '')) && /\+\s*'[^']*$/.test(line))
        .map(({ n }) => `script #${i} line ${n + 1}`),
    );
    expect(bad, bad.join('\n')).toEqual([]);
  });
});
