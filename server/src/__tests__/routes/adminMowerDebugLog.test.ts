import { describe, it, expect } from 'vitest';
import { adminPageHtml } from '../../routes/adminPage.js';
import { ADMIN_I18N } from '../../routes/adminI18n.js';

/**
 * Mower debug could not show extended_commands.log (it is not a ROS log), and
 * a fetched log could only be copied, so users had nothing to attach to an
 * issue (2026-10-22). The admin panel is one server-rendered page with inline
 * JS, so this asserts on the emitted source.
 */
describe('Mower debug: the extended_commands log, and a file to send', () => {
  const page = adminPageHtml();

  it('offers extended_commands.log as a source', () => {
    expect(page).toContain('<option value="extended_commands">');
  });

  it('saves the fetched lines as a .log file', () => {
    expect(page).toContain('onclick="mdDownloadOutput()"');
    const fn = page.slice(page.indexOf('function mdDownloadOutput'), page.indexOf('function mdDownloadOutput') + 900);
    expect(fn).toContain('new Blob(');
    expect(fn).toContain('mdOutputLines');
    expect(fn).toMatch(/\.log'/);
  });

  it('has the button in every language', () => {
    for (const lang of ['nl', 'fr', 'de'] as const) expect(ADMIN_I18N['Download']?.[lang]).toBeTruthy();
  });
});
