/**
 * BLE scanner using native CoreBluetooth (via @stoprocent/noble).
 * Scans for Novabot / CHARGER_PILE devices and extracts BLE MAC
 * from manufacturer data (company ID 0x5566 + 6 bytes MAC).
 *
 * This works on macOS where Web Bluetooth cannot read manufacturer data.
 * Requires Bluetooth permission: System Settings → Privacy → Bluetooth → Terminal.
 */

type Noble = typeof import('@stoprocent/noble').default;
type Peripheral = import('@stoprocent/noble').Peripheral;

let noble: Noble | null = null;
let initError: string | null = null;
let initDone = false;

const NOVABOT_COMPANY_ID = 0x5566;
const TARGET_PREFIXES = ['novabot', 'charger_pile', 'charger'];

export interface BleDevice {
  name: string;
  mac: string;
  rssi: number;
}

let scanning = false;

/** Lazy-load noble (may fail if no Bluetooth hardware). */
async function getNoble(): Promise<Noble> {
  if (initDone) {
    if (!noble) throw new Error(initError || 'Bluetooth not available');
    return noble;
  }
  initDone = true;
  try {
    const mod = await import('@stoprocent/noble');
    noble = mod.default;
    console.log('[BLE] Noble loaded, adapter state:', noble.state);
    return noble;
  } catch (err) {
    initError = (err as Error).message;
    console.warn('[BLE] Noble not available:', initError);
    throw new Error(initError);
  }
}

/**
 * Scan for Novabot BLE devices for `durationMs` milliseconds.
 * Returns unique devices found with their BLE MAC from manufacturer data.
 */
export async function scanForDevices(durationMs = 5000): Promise<BleDevice[]> {
  const n = await getNoble();

  if (scanning) {
    throw new Error('Scan already in progress');
  }
  scanning = true;
  const found = new Map<string, BleDevice>(); // keyed by MAC

  try {
    // Wait for Bluetooth adapter to be ready
    if (n.state !== 'poweredOn') {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Bluetooth adapter timeout — check permissions')), 5000);
        const onState = (state: string) => {
          if (state === 'poweredOn') {
            clearTimeout(timeout);
            n.removeListener('stateChange', onState);
            resolve();
          }
        };
        n.on('stateChange', onState);
      });
    }

    // Set up discovery handler
    const onDiscover = (peripheral: Peripheral) => {
      const localName = peripheral.advertisement?.localName ?? '';
      const nameLower = localName.toLowerCase();

      // Filter: must match one of our target name prefixes
      if (!TARGET_PREFIXES.some(p => nameLower.startsWith(p))) return;

      const mfgData = peripheral.advertisement?.manufacturerData;
      if (!mfgData || mfgData.length < 8) return;

      // First 2 bytes = company ID (little-endian)
      const companyId = mfgData.readUInt16LE(0);
      if (companyId !== NOVABOT_COMPANY_ID) return;

      // Next 6 bytes = BLE MAC address
      const mac = Array.from(mfgData.subarray(2, 8))
        .map(b => b.toString(16).padStart(2, '0').toUpperCase())
        .join(':');

      if (!found.has(mac)) {
        console.log(`[BLE] Found: ${localName} MAC=${mac} RSSI=${peripheral.rssi}`);
      }
      found.set(mac, { name: localName, mac, rssi: peripheral.rssi });
    };

    n.on('discover', onDiscover);
    await n.startScanningAsync([], true); // allow duplicates for RSSI updates

    // Wait for scan duration
    await new Promise(resolve => setTimeout(resolve, durationMs));

    await n.stopScanningAsync();
    n.removeListener('discover', onDiscover);

    return Array.from(found.values());
  } finally {
    scanning = false;
  }
}

/** Check if BLE scanning is available on this system. */
export function isBleAvailable(): boolean {
  // Optimistic: return true until we know it's not available
  if (!initDone) return true;
  return noble !== null;
}
