/**
 * Resolve the BLE MAC address for a given SN. Private copy for cloud-api —
 * dashboard keeps its own copy so the two can diverge safely.
 *
 * NOTE: Copied verbatim from `src/mqtt/broker.ts` on 2026-04-23. Behaviour
 * identical — same priority order, same return semantics. The broker's
 * exported `lookupMac` remains in place; Task 9 will switch cloud-api route
 * imports over to this copy.
 *
 * Priority — gewijzigd 22 apr 2026 (bug #mower-mac-swap):
 * 1. `device_factory` — AUTHORITATIEF per-SN (READ-ONLY tabel, één SN = één MAC).
 *    Altijd veilig: kan structureel geen andere SN-MAC combinaties lekken.
 * 2. device_registry preferred (mqtt_username = SN) — live, real device entry.
 * 3. device_registry excluding 'app:SN' — andere non-app entry, fallback.
 * 4. equipment.mac_address — ALLEEN als `mower_sn === sn`. Dit veld is gedeeld
 *    tussen mower+charger in dezelfde row, dus voor charger-SN nooit teruggeven.
 *    Conventie (zie memory ble-mac-address-critical.md): equipment.mac_address
 *    is altijd de MOWER BLE MAC.
 */
import { deviceRepo, equipmentRepo } from '../../db/repositories/index.js';

export function lookupMac(sn: string): string | null {
  // 1. Factory-tabel — kan niet verkeerd zijn, één SN = één MAC (read-only bron).
  const factoryMac = deviceRepo.getFactoryMac(sn);
  if (factoryMac) return factoryMac;

  // 2. device_registry preferred: echte device entries (mqtt_username = SN)
  //    boven app-client entries (mqtt_username = 'app:SN') die een ander MAC hebben.
  const preferredMac = deviceRepo.findPreferredMacBySnAndUsername(sn, sn);
  if (preferredMac) return preferredMac;

  // 3. device_registry fallback: elke entry BEHALVE app-clients.
  //    App-clients hadden eerder een verkeerd MAC van ARP auto-detectie.
  const fallbackMac = deviceRepo.findMacBySnExcludingApp(sn);
  if (fallbackMac) return fallbackMac;

  // 4. equipment.mac_address — alleen als het SN de MOWER van die row is.
  //    Voor charger SN-lookups nooit teruggeven: equipment row bevat één gedeeld
  //    mac_address veld voor (mower_sn, charger_sn) pair en de conventie is dat
  //    dit altijd de mower MAC is. Zie memory ble-mac-address-critical.md.
  const eqRow = equipmentRepo.findBySn(sn);
  if (eqRow?.mac_address && eqRow.mower_sn === sn) return eqRow.mac_address;

  return null;
}
