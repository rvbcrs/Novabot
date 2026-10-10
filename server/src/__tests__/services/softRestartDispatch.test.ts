import { describe, it, expect, vi } from 'vitest';

vi.mock('../../mqtt/mapSync.js', () => ({
  publishToDevice: vi.fn(),
  publishToExtended: vi.fn(),
  getNextCmdNum: vi.fn(() => 1),
}));
vi.mock('../../mqtt/sensorData.js', () => ({ deviceCache: new Map() }));

import { publishToDevice, publishToExtended } from '../../mqtt/mapSync.js';
import { sendSoftRestart } from '../../services/softRestart.js';

describe('sendSoftRestart', () => {
  // mqtt_node has no soft_restart handler; extended_commands.py listens on
  // novabot/extended/<SN>. On the native channel the restart never happened.
  it('goes to extended_commands, not the native mqtt_node channel', () => {
    sendSoftRestart('LFIN0000000001');
    expect(publishToExtended).toHaveBeenCalledWith('LFIN0000000001', { soft_restart: {} });
    expect(publishToDevice).not.toHaveBeenCalled();
  });
});
