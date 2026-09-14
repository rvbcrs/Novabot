import { describe, it, expect } from 'vitest';
import { adminPageHtml } from '../../routes/adminPage.js';

/**
 * The admin panel is one server-rendered page with inline JS, so the only way
 * to keep the diagnosis wired up is to assert on the emitted source.
 */
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
