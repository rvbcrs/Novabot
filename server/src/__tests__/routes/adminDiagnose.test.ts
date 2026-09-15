import { describe, it, expect } from 'vitest';
import { adminPageHtml } from '../../routes/adminPage.js';
import { ADMIN_I18N } from '../../routes/adminI18n.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * The admin panel is one server-rendered page with inline JS, so the only way
 * to keep the diagnosis wired up is to assert on the emitted source.
 */
describe('the admin panel names its steps', () => {
  // Het paneel drukte de ruwe stap-id af ("charger_crypto", "ble_mac"), wat als
  // logregels las terwijl het dashboard er nette namen voor had (2026-09-15).
  const page = adminPageHtml();
  const ids = [...readFileSync(
    fileURLToPath(new URL('../../services/connectionDiagnosis.ts', import.meta.url)), 'utf8')
    .matchAll(/id: '([a-z_]+)'/g)].map(m => m[1]);

  it('has a name for every step the diagnosis can produce', () => {
    const table = page.slice(page.indexOf('var STEPS = {'), page.indexOf('var GROUPS'));
    const missing = [...new Set(ids)].filter(id => !new RegExp(`\\b${id}:`).test(table));
    expect(missing).toEqual([]);
  });

  it('translates those names in the admin dictionary', () => {
    const table = page.slice(page.indexOf('var STEPS = {'), page.indexOf('var GROUPS'));
    const names = [...table.matchAll(/[a-z_]+: "([^"]+)"/g)].map(m => m[1]);
    expect(names.length).toBeGreaterThan(20);
    const untranslated = names.filter(n => !ADMIN_I18N[n]?.nl);
    expect(untranslated).toEqual([]);
  });
});

describe('admin panel diagnosis', () => {
  const html = typeof adminPageHtml === 'function' ? adminPageHtml() : String(adminPageHtml);

  it('puts a Diagnose button on every device row', () => {
    expect(html).toContain('diagnoseDevice(');
    expect(html).toContain('>Diagnose</button>');
  });

  it('calls the same endpoint the dashboard uses', () => {
    // One source of truth about what can be wrong and why.
    expect(html).toContain('/api/dashboard/diagnose/');
  });

  it('escapes device data before putting it in the DOM', () => {
    // Evidence strings carry serials, MACs and firmware error text straight
    // into innerHTML.
    expect(html).toContain('function escapeHtml(');
    expect(html).toContain('escapeHtml(s.evidence)');
    expect(html).toContain('escapeHtml(r.summary)');
  });

  it('renders every group the service can produce', () => {
    for (const g of ['server', 'reach', 'connect', 'identity', 'pair', 'firmware', 'ready']) {
      expect(html).toContain(`'${g}'`);
    }
  });
});
