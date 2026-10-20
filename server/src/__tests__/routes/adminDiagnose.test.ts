import { describe, it, expect } from 'vitest';
import { adminPageHtml } from '../../routes/adminPage.js';
import { ADMIN_I18N } from '../../routes/adminI18n.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

/**
 * The admin panel is one server-rendered page with inline JS, so the only way
 * to keep the diagnosis wired up is to assert on the emitted source.
 */
describe('the admin panel has no Dutch left outside its help popup', () => {
  // Het paneel heeft een taalschakelaar maar bevatte hardgecodeerde Nederlandse
  // knoppen en waarschuwingen, zodat een gebruiker op EN Nederlands kreeg
  // (2026-09-15). De help-popup is bewust Nederlands en blijft buiten schot.
  const source = readFileSync(
    fileURLToPath(new URL('../../routes/adminPage.ts', import.meta.url)), 'utf8');
  const DUTCH = /\b(de|het|een|niet|wordt|kan|kun|je|maaier|kaarten|verwijderen|alleen|zodat|toepassen|terugdraaien|ongemoeid)\b/i;

  it('has no Dutch in buttons, labels or confirms', () => {
    const offenders: string[] = [];
    for (const line of source.split('\n')) {
      if (line.includes('help-item') || line.includes('help-note')) continue;
      if (line.trimStart().startsWith('//') || line.trimStart().startsWith('*')) continue;
      const found = [...line.matchAll(
        />([^<>{}]{4,120})<\/(?:button|label|span|div|b|strong|option|h[1-4]|a)>|title="([^"]{4,120})"/g)];
      for (const m of found) {
        const text = (m[1] ?? m[2]).trim();
        if (!/[A-Za-z]{3}/.test(text)) continue;
        if ((text.match(DUTCH) ? text.split(/\s+/).filter(w => DUTCH.test(w)).length : 0) >= 2) {
          offenders.push(text.slice(0, 80));
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the beta firmware warning speaks the panel language', () => {
  // De waarschuwing stond hardgecodeerd in het Nederlands terwijl het paneel
  // een taalschakelaar heeft, dus een gebruiker op EN kreeg een Nederlandse
  // waarschuwing over het bricken van zijn maaier (2026-09-15).
  const page = adminPageHtml();
  const SENTENCES = [
    'This is BETA / experimental custom firmware.',
    'Installing it can render the mower unusable (brick it).',
    'You may lose ALL your maps.',
    'A fresh backup is made automatically before we flash.',
    'The device will reboot during the update.',
  ];

  it('is written in English, like the rest of the panel', () => {
    expect(SENTENCES.filter(s => !page.includes(s))).toEqual([]);
    expect(page).not.toContain('onbruikbaar maken (bricken).<br>');
  });

  it('has every sentence in the dictionary, in every language', () => {
    const missing: string[] = [];
    for (const s of SENTENCES) {
      for (const lang of ['nl', 'fr', 'de'] as const) {
        if (!ADMIN_I18N[s]?.[lang]) missing.push(`${lang}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('the DNS check says what it checked', () => {
  // The check resolves *.lfibot.com on the server itself, yet it said "The
  // Novabot app and mower will connect locally". A user had that green check
  // and "0 / 0 online" for 30 hours (Facebook, 2026-10-20).
  const page = adminPageHtml();
  const SENTENCES = [
    'This server finds *.lfibot.com at a local address.',
    'That only tests the server itself. Your mower and charger use the DNS server your router gives them.',
    'No mower or charger is connected to this server.',
    "On your phone, on the mower's Wi-Fi with mobile data off, open {addr}. If it does not open, this computer blocks connections from your network: on Windows, set the network profile to Private and allow Docker Desktop through the firewall. If it opens, check that the mower and charger are on the same router as this computer and that this router hands out {ip} as its DNS server. Then switch both off and on.",
  ];

  it('no longer promises that the mower will connect', () => {
    expect(page).not.toContain('The Novabot app and mower will connect locally');
  });

  it('says it only tested the server, and gives a next step while no device is connected', () => {
    expect(SENTENCES.filter(s => !page.includes(s))).toEqual([]);
    expect(page).toContain('d.devicesOnline === 0');
  });

  it('has every sentence in the dictionary, in every language', () => {
    const missing: string[] = [];
    for (const s of SENTENCES) {
      for (const lang of ['nl', 'fr', 'de'] as const) {
        if (!ADMIN_I18N[s]?.[lang]) missing.push(`${lang}: ${s}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

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
