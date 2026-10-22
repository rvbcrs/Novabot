import type { ScannedDevice } from '../services/ble';

type ProvisionedDevice = Pick<ScannedDevice, 'id' | 'name' | 'type'>;

const SN_NAME = /^LFI[CN]\d/;

/**
 * The provisioned devices a server sighting of `sn` belongs to (GH #160).
 *
 * After provisioning, /api/setup/health reports the device it saw last. The
 * screen used to mark every provisioned device online as soon as any one
 * appeared, so a dock that reached the new server showed the mower online too.
 * A device that advertises its SN as BLE name matches that SN only; one with
 * the generic name (CHARGER_PILE, Novabot) matches on the SN prefix, LFIC for
 * a charger and LFIN for a mower.
 */
export function provisionedDevicesForSn(devices: ProvisionedDevice[], sn: string): string[] {
  const snUpper = (sn ?? '').trim().toUpperCase();
  const type = snUpper.startsWith('LFIC') ? 'charger' : snUpper.startsWith('LFIN') ? 'mower' : null;
  if (!type) return [];
  return devices
    .filter((d) => {
      const name = (d.name ?? '').trim().toUpperCase();
      return SN_NAME.test(name) ? name === snUpper : d.type === type;
    })
    .map((d) => d.id);
}

/** Every provisioned device has been seen online. */
export function allProvisionedOnline(
  devices: Pick<ScannedDevice, 'id'>[],
  online: Record<string, boolean>,
): boolean {
  return devices.length > 0 && devices.every((d) => online[d.id]);
}
