import { describe, it, expect } from 'vitest';
import {
  deriveMowerActivity,
  isInterruptedCoverage,
  parseRechargeStatus,
} from '../../mqtt/mowerActivity.js';

// Fixtures komen uit de live data die de melders van #30/#31 aanleverden
// (waltervl's lua-koppeling + Automate1's sensor-screenshots, juli 2026).

describe('parseRechargeStatus — ruwe én vertaalde vorm (#31 NaN-bug)', () => {
  it('parseert ruwe nummers', () => {
    expect(parseRechargeStatus('0')).toBe(0);
    expect(parseRechargeStatus('50')).toBe(50);
    expect(parseRechargeStatus('193')).toBe(193);
  });
  it('parseert de server-labels', () => {
    expect(parseRechargeStatus('Charging (50)')).toBe(50);
    expect(parseRechargeStatus('Charging (9)')).toBe(9);
    expect(parseRechargeStatus('Not charging')).toBe(0);
    // Code 1 wordt vertaald naar kaal "Charging", zonder cijfer.
    expect(parseRechargeStatus('Charging')).toBe(1);
  });
  it('onbekend/leeg is 0', () => {
    expect(parseRechargeStatus(undefined)).toBe(0);
    expect(parseRechargeStatus('')).toBe(0);
  });
});

describe('deriveMowerActivity — #31: terugrit na afmaken', () => {
  const base = { task_mode: '1', battery_state: 'DISCHARGING', work_status: 'Finished' };

  it('terugrit met recharge 50/53 (msg matcht geen regex) is returning', () => {
    for (const rs of ['Charging (50)', 'Charging (53)', '50', '53']) {
      const a = deriveMowerActivity(
        { ...base, recharge_status: rs, msg: 'Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE' },
        { online: true },
      );
      expect(a, `recharge_status=${rs}`).toBe('returning');
    }
  });

  it('waltervl\'s gedockte eindstand blijft charging, niet returning', () => {
    // Exacte sample uit #30: normale lading na afgemaakte beurt.
    const a = deriveMowerActivity(
      {
        recharge_status: 'Charging (9)',
        work_status: 'Finished',
        msg: 'Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE Recharge: FINISHED',
        battery_state: 'CHARGING',
        task_mode: '0',
      },
      { online: true },
    );
    expect(a).toBe('charging');
  });

  it('rem op blijven-hangen-waarden: nummer + "Recharge: FINISHED" is geen terugrit', () => {
    const a = deriveMowerActivity(
      { ...base, recharge_status: 'Charging (50)', msg: 'Work:CANCELLED Recharge: FINISHED' },
      { online: true },
    );
    expect(a).not.toBe('returning');
  });

  it('regressie: actief maaien wint van een recharge-nummer', () => {
    const a = deriveMowerActivity(
      { ...base, work_status: '3', recharge_status: 'Charging', msg: 'Mode:COVERAGE Work:COVERING' },
      { online: true },
    );
    expect(a).toBe('mowing');
  });

  it('regressie: msg-gebaseerde returning blijft werken', () => {
    const a = deriveMowerActivity(
      { ...base, recharge_status: 'Not charging', msg: 'Work:GO_PILE Recharge: GOING' },
      { online: true },
    );
    expect(a).toBe('returning');
  });
});

describe('isInterruptedCoverage — #30: Low power laadpauze op stock 5.7.1', () => {
  const docked = { battery_state: 'CHARGING', task_mode: '1' };

  it('work_status "Low power" (of ruw 12) op de dock is een hervatbare pauze', () => {
    expect(isInterruptedCoverage({ ...docked, work_status: 'Low power', msg: '' })).toBe(true);
    expect(isInterruptedCoverage({ ...docked, work_status: '12', msg: '' })).toBe(true);
  });

  it('niet zonder lopende coverage-taak (task_mode 0)', () => {
    expect(isInterruptedCoverage({ ...docked, task_mode: '0', work_status: 'Low power', msg: '' })).toBe(false);
  });

  it('niet zonder dock', () => {
    expect(isInterruptedCoverage({ battery_state: 'DISCHARGING', task_mode: '1', work_status: 'Low power', msg: '' })).toBe(false);
  });

  it('regressie: de bestaande msg-detectie blijft werken', () => {
    expect(isInterruptedCoverage({ ...docked, work_status: 'Finished', msg: 'Work:USER_RECHARGE_STOP' })).toBe(true);
    expect(isInterruptedCoverage({ ...docked, work_status: 'Finished', msg: 'Work:PAUSED' })).toBe(true);
    expect(isInterruptedCoverage({ ...docked, work_status: 'Finished', msg: 'Work:CANCELLED' })).toBe(false);
  });
});
