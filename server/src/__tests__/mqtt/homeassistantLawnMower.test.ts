import { describe, it, expect, beforeEach, vi } from 'vitest';

// VEILIGHEIDSSUITE: handleLawnMowerCommand laat een echte maaier rijden.
// Alleen de uitvoerende randen zijn gemockt (publishToDevice, start/goHome);
// de afleiding (deriveMowerActivity) en de poortlogica draaien ECHT, zodat
// deze tests falen zodra iemand een gate versoepelt.
vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
}));
// sensorData → socketHandler → demoSimulator sluit een init-cyclus die in de
// test-importvolgorde een TDZ-fout geeft; sensorData gebruikt er alleen
// emitDebugPosJson uit.
vi.mock('../../dashboard/socketHandler.js', () => ({
  emitDebugPosJson: vi.fn(),
}));
vi.mock('../../services/scheduleRunner.js', () => ({
  computeScheduleArea: vi.fn(() => 1),
}));
vi.mock('../../services/mowingService.js', () => ({
  startMowing: vi.fn(() => ({ ok: true })),
  goHome: vi.fn(() => ({ ok: true })),
}));

import { toHaActivity, handleLawnMowerCommand } from '../../mqtt/homeassistant.js';
import { publishToDevice } from '../../mqtt/mapSync.js';
import { startMowing, goHome } from '../../services/mowingService.js';
import { deviceCache } from '../../mqtt/sensorData.js';

const SN = 'LFIN_HATEST_01';

function setSensors(fields: Record<string, string>): void {
  deviceCache.set(SN, new Map(Object.entries(fields)));
}

const MOWING = { msg: 'Work:COVERING Recharge: IDLE', task_mode: '1', battery_state: 'DISCHARGING', work_status: '3' };
const PAUSED = { msg: 'Work:PAUSED Recharge: IDLE', task_mode: '1', battery_state: 'DISCHARGING', work_status: '4' };
const DOCKED = { msg: 'Work:CANCELLED Recharge: FINISHED', task_mode: '0', battery_state: 'CHARGING', work_status: '0' };
const RETURNING = { msg: 'Work:GO_PILE Recharge: GOING', task_mode: '1', battery_state: 'DISCHARGING', work_status: '5', recharge_status: '1' };

describe('toHaActivity — 9 interne staten naar de 4 van HA', () => {
  it('mapt de kernstaten', () => {
    expect(toHaActivity('charging', {})).toBe('docked');
    expect(toHaActivity('paused', {})).toBe('paused');
    expect(toHaActivity('error', {})).toBe('error');
    for (const a of ['mowing', 'edge_cutting', 'returning', 'mapping'] as const) {
      expect(toHaActivity(a, {})).toBe('mowing');
    }
  });

  it('idle op de dock (accu vol) is docked, idle elders is none', () => {
    expect(toHaActivity('idle', { battery_state: 'FINISHED' })).toBe('docked');
    expect(toHaActivity('idle', { battery_state: 'DISCHARGING' })).toBe('none');
    expect(toHaActivity('idle', {})).toBe('none');
  });
});

describe('handleLawnMowerCommand — poorten (veiligheid)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deviceCache.delete(SN);
  });

  it('onbekende SN: niets gebeurt', async () => {
    await handleLawnMowerCommand(SN, 'start_mowing');
    expect(startMowing).not.toHaveBeenCalled();
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('start terwijl hij al maait: geweigerd', async () => {
    setSensors(MOWING);
    await handleLawnMowerCommand(SN, 'start_mowing');
    expect(startMowing).not.toHaveBeenCalled();
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('start terwijl hij terugkeert: geweigerd', async () => {
    setSensors(RETURNING);
    await handleLawnMowerCommand(SN, 'start_mowing');
    expect(startMowing).not.toHaveBeenCalled();
    expect(publishToDevice).not.toHaveBeenCalled();
  });

  it('start vanuit pauze: resume_navigation, geen verse start', async () => {
    setSensors(PAUSED);
    await handleLawnMowerCommand(SN, 'start_mowing');
    expect(startMowing).not.toHaveBeenCalled();
    expect(publishToDevice).toHaveBeenCalledWith(
      SN,
      expect.objectContaining({ resume_navigation: expect.objectContaining({ cmd_num: expect.any(Number) }) }),
    );
  });

  it('start vanaf de dock: verse start via startMowing', async () => {
    setSensors(DOCKED);
    await handleLawnMowerCommand(SN, 'start_mowing');
    expect(startMowing).toHaveBeenCalledWith(expect.objectContaining({ sn: SN, area: expect.any(Number) }));
  });

  it('pauze alleen tijdens actief rijden', async () => {
    setSensors(DOCKED);
    await handleLawnMowerCommand(SN, 'pause');
    expect(publishToDevice).not.toHaveBeenCalled();

    setSensors(MOWING);
    await handleLawnMowerCommand(SN, 'pause');
    expect(publishToDevice).toHaveBeenCalledWith(
      SN,
      expect.objectContaining({ pause_navigation: expect.anything() }),
    );
  });

  it('dock tijdens maaien stuurt hem naar huis; dock op de dock is een no-op', async () => {
    setSensors(MOWING);
    await handleLawnMowerCommand(SN, 'dock');
    expect(goHome).toHaveBeenCalledWith(SN);

    vi.clearAllMocks();
    setSensors(DOCKED);
    await handleLawnMowerCommand(SN, 'dock');
    expect(goHome).not.toHaveBeenCalled();
  });
});
