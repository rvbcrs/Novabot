/**
 * Connection diagnosis — where in the chain is this device stuck?
 *
 * Novabot is bankrupt and there is no support, so anyone whose mower or charger
 * will not come online is on their own. The evidence to answer that already
 * exists, scattered over the broker, the device registry, the equipment table
 * and the LoRa cache. This walks it in the order a device actually comes up and
 * stops at the first broken link, because every check after it is meaningless.
 *
 * The distinction that makes this a diagnosis rather than a checklist is step
 * `seen`: never connected and connected-until-Tuesday look identical in the
 * dashboard but call for opposite actions.
 *
 * Deliberately no model. Whether a device sent a CONNECT is a fact, not
 * something to infer.
 */
import { deviceRepo, equipmentRepo, connectionEventRepo } from '../db/repositories/index.js';
import { getLoraPair } from './loraPair.js';
import { checkReachability, serverIpv4, type Reachability } from './reachability.js';
import { probeMower, type MowerProbe } from './mowerProbe.js';
import { scanLan, lookupMac, rivalBrokers, bleToWifiMac, type LanScanResult } from './lanScan.js';
import { statfs } from 'fs/promises';
import { mapRepo, userRepo } from '../db/repositories/index.js';
import { deriveHasError } from '../mqtt/mowerActivity.js';
import { MAP_NAMES_SELECTION_BUILD } from './mowingArea.js';

export type StepStatus = 'ok' | 'fail' | 'warn' | 'unknown' | 'skipped';

export type DiagnosisGroup = 'server' | 'reach' | 'mower' | 'connect' | 'identity' | 'pair' | 'firmware' | 'ready';

export interface DiagnosisStep {
  /** Stable id, so the UI can translate without parsing prose. */
  id: string;
  group: DiagnosisGroup;
  status: StepStatus;
  /** What was actually observed. Facts, no advice. */
  evidence: string;
  /** The one next thing to do. Only set when status is fail or warn. */
  action?: string;
}

/**
 * The three things that go out on the network, injectable.
 *
 * Without this the tests reached the real LAN, which made them depend on what
 * happened to be plugged in and how loaded the machine was. They passed alone
 * and failed inside the release gate, twice. Injected, the service is pure and
 * both branches of every network answer are reachable from a test.
 */
export interface DiagnosisProbes {
  reachability: (deviceIp: string | null) => Promise<Reachability>;
  mower: (ip: string | null) => Promise<MowerProbe>;
  scanLan: () => Promise<LanScanResult>;
  rivalBrokers: (ourIps: string[]) => Promise<string[]>;
  lookupMac: (ip: string) => Promise<string | null>;
}

export const realProbes: DiagnosisProbes = {
  reachability: checkReachability,
  mower: probeMower,
  scanLan,
  rivalBrokers,
  lookupMac,
};

export interface DiagnosisInput {
  /** Defaults to the real network probes. */
  probes?: Partial<DiagnosisProbes>;
  /**
   * Probe the local network: sweep for LFI MAC prefixes when no address is
   * known, and look for a second MQTT broker. Both cost real time and packets,
   * so a caller that polls should turn them off. On by default, because a
   * person pressing Diagnose wants the full answer.
   */
  probeNetwork?: boolean;
  /**
   * Live sensor values, passed in rather than imported.
   *
   * sensorData pulls in socketHandler -> broker -> demoSimulator, a cycle that
   * ESM resolves as a TDZ error at import time. Injecting it also makes every
   * state below reachable from a test without a running broker.
   */
  snapshot?: Record<string, string> | null;
}

export interface Diagnosis {
  sn: string;
  deviceType: 'mower' | 'charger' | 'unknown';
  /** First step that is not ok, or null when the chain is clean. */
  stuckAt: string | null;
  summary: string;
  steps: DiagnosisStep[];
  generatedAt: number;
}

const DEVICE_HOSTNAMES_LABEL = 'mqtt.lfibot.com';

const MOWER_PREFIX = 'LFIN';
const CHARGER_PREFIX = 'LFIC';

/** Beyond this a device counts as gone rather than briefly quiet. */
const OFFLINE_AFTER_MS = 10 * 60 * 1000;

function deviceTypeOf(sn: string): Diagnosis['deviceType'] {
  if (sn.startsWith(MOWER_PREFIX)) return 'mower';
  if (sn.startsWith(CHARGER_PREFIX)) return 'charger';
  return 'unknown';
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return `${s} s geleden`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min geleden`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} uur geleden`;
  return `${Math.round(h / 24)} dagen geleden`;
}

function parseLastSeen(row: { last_seen?: string } | undefined): number | null {
  if (!row?.last_seen) return null;
  // SQLite datetime('now') is UTC without a zone marker; Date would read it as
  // local time and report a device as hours stale right after it connected.
  const iso = row.last_seen.includes('T') ? row.last_seen : row.last_seen.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export async function diagnoseConnection(
  sn: string,
  now = Date.now(),
  input: DiagnosisInput = {},
): Promise<Diagnosis> {
  const snap = input.snapshot ?? null;
  const probe: DiagnosisProbes = { ...realProbes, ...(input.probes ?? {}) };
  const steps: DiagnosisStep[] = [];
  const deviceType = deviceTypeOf(sn);
  const push = (s: DiagnosisStep) => { steps.push(s); return s; };

  // ── Server ─────────────────────────────────────────────────────────────
  //
  // Een volle schijf breekt alles wat schrijft: kaartuploads, de database, de
  // logs. Het foutbeeld is diffuus en wijst nergens naar de echte oorzaak.
  try {
    const fs = await statfs('.');
    const freeMb = Math.round((fs.bavail * fs.bsize) / 1048576);
    const totalMb = Math.round((fs.blocks * fs.bsize) / 1048576);
    const pct = totalMb > 0 ? Math.round((freeMb / totalMb) * 100) : 100;
    push({
      id: 'disk',
      group: 'server',
      status: freeMb < 200 ? 'fail' : freeMb < 1024 ? 'warn' : 'ok',
      evidence: `${freeMb} MB vrij van ${totalMb} MB (${pct}%)`,
      action: freeMb < 1024
        ? 'kaartuploads en de database hebben ruimte nodig; maak schijfruimte vrij'
        : undefined,
    });
  } catch {
    push({ id: 'disk', group: 'server', status: 'unknown', evidence: 'schijfruimte niet op te vragen' });
  }

  // Twee brokers op één netwerk is een echte en verwarrende storing: maaiers
  // vinden via mDNS de verkeerde, springen heen en weer en lijken met tussen-
  // pozen offline. Precies wat hier op 14-09-2026 gebeurde toen een release een
  // tweede container op 1883 liet staan.
  const rivals = input.probeNetwork === false ? [] : await probe.rivalBrokers(serverIpv4());
  push({
    id: 'rival_broker',
    group: 'server',
    status: input.probeNetwork === false ? 'skipped' : rivals.length > 0 ? 'fail' : 'ok',
    evidence: input.probeNetwork === false
      ? 'niet gepeild'
      : rivals.length > 0
      ? `nog ${rivals.length} andere MQTT-broker(s) op dit netwerk: ${rivals.join(', ')}`
      : 'geen tweede MQTT-broker op dit netwerk',
    action: rivals.length > 0
      ? 'maaiers ontdekken via mDNS de verkeerde en springen heen en weer; zet er één uit'
      : undefined,
  });

  // No "is the server up" step: this answer only exists because the server
  // answered. A check that cannot fail is noise, and importing the broker here
  // to ask it drags in the socketHandler -> broker -> demoSimulator cycle.

  // 1. Can the device reach us at all? Without this the chain is blind to its
  //    own most basic failure: nothing arrives, so we see nothing, so we report
  //    nothing. Measurements only, no conclusions about what "probably" broke.
  const regEarly = deviceRepo.findBySn(sn);
  const reach = await probe.reachability(regEarly?.ip_address ?? null);
  const dnsAnswers = reach.dns.filter(d => d.addresses.length > 0);
  const dnsPointsHere = dnsAnswers.some(d => d.pointsHere);
  const dnsElsewhere = dnsAnswers.filter(d => !d.pointsHere);

  // Alleen hard oordelen als DEZE server de omleiding serveert. Draait de DNS
  // ergens anders, in de router of op een aparte DNS-server, dan zegt wat de
  // container zelf oplost niets over wat de maaier oplost, en is een afwijking
  // geen fout maar gewoon een meting.
  const weServeDns = (process.env.ENABLE_DNS ?? '').toLowerCase() === 'true';
  if (dnsAnswers.length === 0) {
    push({
      id: 'dns',
      group: 'reach',
      status: 'unknown',
      evidence: `${DEVICE_HOSTNAMES_LABEL} lost hier niet op`,
    });
  } else if (dnsPointsHere) {
    push({
      id: 'dns',
      group: 'reach',
      status: 'ok',
      evidence: `${dnsAnswers.find(d => d.pointsHere)!.host} wijst naar deze server `
              + `(${reach.serverIps.join(', ') || 'onbekend adres'})`,
    });
  } else if (weServeDns) {
    push({
      id: 'dns',
      group: 'reach',
      status: 'fail',
      evidence: `deze server serveert de omleiding, maar ${dnsElsewhere[0].host} wijst naar `
              + `${dnsElsewhere[0].addresses.join(', ')} en niet naar `
              + `${reach.serverIps.join(', ') || 'onbekend'}`,
      action: 'zet de omleiding op het huidige serveradres; dit adres is waarschijnlijk '
            + 'veranderd sinds de installatie',
    });
  } else {
    push({
      id: 'dns',
      group: 'reach',
      status: 'unknown',
      evidence: `${dnsElsewhere[0].host} lost hier op naar ${dnsElsewhere[0].addresses.join(', ')}. `
              + 'Deze server serveert de omleiding niet, dus dit zegt alleen iets als je '
              + 'apparaten dezelfde DNS gebruiken als deze container',
    });
  }

  if (!reach.deviceIp) {
    // Nooit verbonden betekent geen adres, en dan is elke andere stap blind
    // voor dit apparaat. De hardware verraadt zichzelf wel op laag 2: de eerste
    // drie bytes van het MAC zeggen wie de fabrikant is, en die set komt uit de
    // fabriekstabel die bij elke installatie meegaat.
    const lan = input.probeNetwork === false ? null : await probe.scanLan();
    if (!lan) {
      push({
        id: 'network',
        group: 'reach',
        status: 'unknown',
        evidence: 'geen adres van dit apparaat bekend, dus niet te peilen',
      });
    } else if (!lan.canSeeLan) {
      push({
        id: 'network',
        group: 'reach',
        status: 'unknown',
        evidence: `geen adres bekend en ${lan.reason}`,
        action: lan.reason?.includes('bridge')
          ? 'draai de container met host-netwerk om het lokale netwerk te kunnen inzien'
          : undefined,
      });
    } else if (lan.found.length === 0) {
      push({
        id: 'network',
        group: 'reach',
        status: 'fail',
        evidence: `geen enkel LFI-apparaat gevonden op ${lan.subnet}.0/24 `
                + `(${lan.neighbourCount} apparaten bekeken)`,
        action: 'het apparaat hangt niet aan dit netwerk: controleer de stroom en '
              + 'of de wifi-gegevens goed zijn doorgegeven',
      });
    } else {
      const mine = lan.found.find(f => f.sn === sn);
      const sameKind = lan.found.filter(f => f.kind === deviceType);
      if (mine) {
        push({
          id: 'network',
          group: 'reach',
          status: 'fail',
          evidence: `gevonden op ${mine.ip} (MAC ${mine.mac}), maar hij praat geen MQTT met ons`,
          action: 'hij hangt aan het netwerk, dus het probleem zit in de serverinstelling '
                + 'van het apparaat: naar welk adres wijst het',
        });
      } else if (sameKind.length > 0) {
        push({
          id: 'network',
          group: 'reach',
          status: 'warn',
          evidence: `${sameKind.length} ${deviceType === 'charger' ? 'laadstation(s)' : 'maaier(s)'} `
                  + `op het netwerk (${sameKind.map(f => f.ip).join(', ')}), maar niet deze`,
          action: 'controleer of het serienummer klopt, of dit apparaat staat uit',
        });
      } else {
        push({
          id: 'network',
          group: 'reach',
          status: 'fail',
          evidence: `wel ${lan.found.length} LFI-apparaat(en) gezien, geen ervan is een `
                  + `${deviceType === 'charger' ? 'laadstation' : 'maaier'}`,
          action: 'dit apparaat hangt niet aan het netwerk',
        });
      }
    }
  } else if (reach.deviceAnswered) {
    push({
      id: 'network',
      group: 'reach',
      status: 'ok',
      evidence: `${reach.deviceIp} antwoordt, het apparaat staat aan en zit op het netwerk`,
    });
  } else if (reach.sameSubnet === false) {
    push({
      id: 'network',
      group: 'reach',
      status: 'fail',
      evidence: `laatst bekende adres ${reach.deviceIp} zit in een ander subnet dan deze server `
              + `(${reach.serverIps.join(', ')})`,
      action: 'zet beide in hetzelfde netwerk, of laat het verkeer ertussen door',
    });
  } else {
    push({
      id: 'network',
      group: 'reach',
      status: 'unknown',
      evidence: `${reach.deviceIp} antwoordt niet op poort 22 of 8000; op stock firmware `
              + 'staan die dicht, dus dit bewijst niets',
    });
  }

  // Wifi: deze apparaten hebben geen ethernet, dus een adres op het netwerk
  // betekent dat de wifi staat. Het MAC wordt opgezocht en niet uitgerekend: de
  // afstand tussen wifi en BLE verschilt per hardware (ESP32 +2, LFIN +1).
  if (!reach.deviceIp) {
    push({ id: 'wifi', group: 'reach', status: 'skipped', evidence: 'geen adres bekend' });
  } else {
    // Eerst de echte uit de buurtabel. Lukt dat niet, dan uit de BLE-MAC die we
    // hoe dan ook kennen: de fabriekstabel heeft die van elk apparaat. Wel
    // erbij zetten dat hij afgeleid is, want dat is een ander soort zekerheid.
    const looked = await probe.lookupMac(reach.deviceIp);
    const bleKnown = deviceRepo.getFactoryMac(sn) ?? regEarly?.mac_address ?? null;
    const derived = !looked && bleKnown
      ? bleToWifiMac(bleKnown, deviceType === 'charger' ? 'charger' : 'mower')
      : null;
    const rssiRaw = snap?.wifi_rssi ?? snap?.signal_strength ?? null;
    const rssi = rssiRaw !== null ? parseInt(rssiRaw, 10) : NaN;
    const parts = [`verbonden via wifi op ${reach.deviceIp}`];
    if (looked) parts.push(`MAC ${looked}`);
    else if (derived) parts.push(`MAC ${derived} (afgeleid uit de BLE-MAC ${bleKnown})`);
    if (Number.isFinite(rssi)) parts.push(`signaal ${rssi} dBm`);
    // Onder de -75 dBm valt de verbinding met enige regelmaat weg, en dat is
    // precies het beeld van "hij is soms online".
    const weak = Number.isFinite(rssi) && rssi < -75;
    push({
      id: 'wifi',
      group: 'reach',
      status: weak ? 'warn' : 'ok',
      evidence: parts.join(', ')
              + (looked || derived ? '' : ' (MAC nergens bekend)'),
      action: weak ? 'zwak signaal, de verbinding valt daar met regelmaat van weg; '
                   + 'zet een toegangspunt dichterbij' : undefined,
    });
  }

  // 2. Has this device EVER been here? The single most informative fact.
  const reg = regEarly;
  const lastSeen = parseLastSeen(reg);
  const everSeen = !!reg && lastSeen !== null;
  const online = everSeen && (now - (lastSeen as number)) < OFFLINE_AFTER_MS;

  if (!everSeen) {
    push({
      id: 'seen',
      group: 'connect',
      status: 'fail',
      evidence: `${sn} heeft zich nog nooit bij deze server gemeld`,
      action: 'het apparaat is nog niet ingericht of wijst naar een andere server: '
            + 'controleer wifi, de BLE-provisioning en of mqtt.lfibot.com naar dit adres verwijst',
    });
  } else if (online) {
    push({
      id: 'seen',
      group: 'connect',
      status: 'ok',
      evidence: `laatst gezien ${ago(lastSeen as number, now)} als ${reg!.mqtt_client_id}`,
    });
  } else {
    push({
      id: 'seen',
      group: 'connect',
      status: 'fail',
      evidence: `was verbonden, maar laatst gezien ${ago(lastSeen as number, now)}`,
      action: 'hij wérkte eerder, dus zoek wat er rond dat moment veranderde: '
            + 'stroom, wifi, DNS of een serverherstart',
    });
  }

  // 3. Is it trying and being refused? Only meaningful when it is not online.
  const lastReject = connectionEventRepo.lastOf(sn, 'rejected');
  const lastError = connectionEventRepo.lastOf(sn, 'error');
  const worst = [lastReject, lastError]
    .filter(Boolean)
    .sort((a, b) => (b!.ts - a!.ts))[0] ?? null;

  if (online) {
    push({ id: 'attempts',
      group: 'connect', status: 'skipped', evidence: 'niet nodig, hij is binnen' });
  } else if (worst && now - worst.ts < 24 * 60 * 60 * 1000) {
    push({
      id: 'attempts',
      group: 'connect',
      status: 'fail',
      evidence: `laatste poging ${ago(worst.ts, now)} geweigerd: ${worst.reason ?? 'onbekende reden'}`,
      action: worst.reason === 'banned'
        ? 'dit serienummer staat geblokkeerd na een "verwijder en verban": '
          + 'koppel het apparaat opnieuw via de app'
        : 'het apparaat bereikt de server wel maar komt niet door: '
          + 'controleer de inloggegevens en het serienummer',
    });
  } else {
    push({
      id: 'attempts',
      group: 'connect',
      status: everSeen ? 'warn' : 'fail',
      evidence: 'geen enkele verbindingspoging geregistreerd in de laatste 24 uur',
      action: 'er komt niets binnen, dus het probleem zit vóór de broker: '
            + 'netwerk, DNS of het apparaat staat uit',
    });
  }

  // 4. Bound to a user? An unbound device connects fine and then does nothing.
  const eq = equipmentRepo.findBySn(sn);
  if (!eq) {
    push({
      id: 'binding',
      group: 'identity',
      status: 'fail',
      evidence: 'geen koppeling in equipment',
      action: 'koppel het apparaat via de app, dat schrijft de equipment-rij',
    });
  } else if (!eq.user_id) {
    push({
      id: 'binding',
      group: 'identity',
      status: 'warn',
      evidence: 'gekoppeld maar zonder gebruiker (user_id leeg)',
      action: 'de app doet dan BLE-provisioning; rond die stap af in de app',
    });
  } else {
    // De guid zegt niemand iets. De naam of het e-mailadres wel.
    const user = userRepo.findById(eq.user_id);
    const who = user?.username || user?.email || eq.user_id;
    push({ id: 'binding', group: 'identity', status: 'ok', evidence: `gekoppeld aan ${who}` });
  }

  // 5. The BLE MAC must be the mower's own, not the charger's. When it is the
  //    charger's, the app does not recognise the BLE advertisement and the user
  //    sees a device that will not pair, with nothing wrong on this side.
  if (deviceType === 'mower') {
    const factory = deviceRepo.getFactoryMac(sn);
    const bound = eq?.mac_address ?? null;
    if (!bound) {
      push({
        id: 'ble_mac',
      group: 'identity',
        status: 'warn',
        evidence: 'geen BLE MAC bekend bij de koppeling',
        action: 'zonder MAC herkent de app de maaier niet in een BLE-scan',
      });
    } else if (bound.toUpperCase().startsWith('48:27:E2')) {
      push({
        id: 'ble_mac',
      group: 'identity',
        status: 'fail',
        evidence: `de opgeslagen MAC ${bound} is die van een laadstation, niet van de maaier`,
        action: 'laat de MAC opnieuw afleiden uit device_factory',
      });
    } else if (factory && bound.toUpperCase() !== factory.toUpperCase()) {
      push({
        id: 'ble_mac',
      group: 'identity',
        status: 'warn',
        evidence: `MAC ${bound} wijkt af van de fabriekswaarde ${factory}`,
      });
    } else {
      push({ id: 'ble_mac',
      group: 'identity', status: 'ok', evidence: `BLE MAC ${bound}` });
    }
  } else {
    push({ id: 'ble_mac',
      group: 'identity', status: 'skipped', evidence: 'alleen van toepassing op een maaier' });
  }

  // 6. The charger side. A mower alone is half a system: without the charger
  //    there is no RTK correction, so it will mow badly or not at all.
  const counterpartSn = deviceType === 'mower' ? eq?.charger_sn : eq?.mower_sn;
  if (!counterpartSn) {
    push({
      id: 'counterpart',
      group: 'pair',
      status: 'warn',
      evidence: deviceType === 'mower' ? 'geen laadstation gekoppeld' : 'geen maaier gekoppeld',
      action: 'zonder laadstation is er geen RTK-correctie en dus geen nauwkeurige positie',
    });
  } else {
    const cReg = deviceRepo.findBySn(counterpartSn);
    const cSeen = parseLastSeen(cReg);
    if (cSeen === null) {
      push({
        id: 'counterpart',
      group: 'pair',
        status: 'fail',
        evidence: `${counterpartSn} heeft zich nog nooit gemeld`,
        action: 'richt ook het laadstation in; het heeft een eigen wifi- en MQTT-verbinding',
      });
    } else if (now - cSeen > OFFLINE_AFTER_MS) {
      push({
        id: 'counterpart',
      group: 'pair',
        status: 'fail',
        evidence: `${counterpartSn} laatst gezien ${ago(cSeen, now)}`,
        action: 'controleer de stroom en het wifi-bereik van het laadstation',
      });
    } else {
      push({ id: 'counterpart',
      group: 'pair', status: 'ok', evidence: `${counterpartSn} gezien ${ago(cSeen, now)}` });
    }
  }

  // De laderfirmware moet AES kennen: v0.4.0 wel, v0.3.6 niet, en de server
  // versleutelt naar elk LFI-serienummer. Een oude lader krijgt dus berichten
  // die hij niet kan lezen, zonder dat er ergens een fout verschijnt.
  const chargerVer = eq?.charger_version ?? null;
  if (!counterpartSn) {
    push({ id: 'charger_crypto', group: 'pair', status: 'skipped', evidence: 'geen lader gekoppeld' });
  } else if (!chargerVer) {
    push({ id: 'charger_crypto', group: 'pair', status: 'unknown', evidence: 'laderversie onbekend' });
  } else {
    const m = chargerVer.match(/(\d+)\.(\d+)\.(\d+)/);
    const tooOld = m ? (Number(m[1]) === 0 && Number(m[2]) < 4) : false;
    push({
      id: 'charger_crypto',
      group: 'pair',
      status: tooOld ? 'fail' : 'ok',
      evidence: `laderfirmware ${chargerVer}${tooOld ? ', kent nog geen AES' : ''}`,
      action: tooOld
        ? 'de server versleutelt alles naar LFI-apparaten en deze lader kan dat niet lezen; '
        + 'werk hem bij naar v0.4.0'
        : undefined,
    });
  }

  // 7. LoRa pair. Reuses the existing comparison rather than re-deriving it.
  const pair = getLoraPair(sn);
  if (!pair) {
    push({ id: 'lora',
      group: 'pair', status: 'skipped', evidence: 'geen LoRa-paar om te controleren' });
  } else if (pair.ok) {
    const c = pair.charger;
    push({
      id: 'lora',
      group: 'pair',
      status: 'ok',
      evidence: `adres ${c?.addr ?? '?'} kanaal ${c?.channel ?? '?'} aan beide kanten gelijk`,
    });
  } else {
    const issues = pair.issues;
    const mismatch = issues.includes('addr-mismatch') || issues.includes('channel-mismatch');
    push({
      id: 'lora',
      group: 'pair',
      status: 'fail',
      evidence: mismatch
        ? `maaier ${pair.mower?.addr ?? '?'}/${pair.mower?.channel ?? '?'} `
          + `tegen lader ${pair.charger?.addr ?? '?'}/${pair.charger?.channel ?? '?'}`
        : issues.join(', '),
      action: mismatch
        ? 'adres en kanaal moeten IDENTIEK zijn aan beide kanten; koppel opnieuw via de app'
        : 'de LoRa-instellingen zijn nog niet van beide apparaten gelezen',
    });
  }

  // ── Verbinding: botsende client-id's ───────────────────────────────────
  //
  // Twee clients met hetzelfde client_id vechten om de verbinding: de broker
  // gooit de ene eruit zodra de andere binnenkomt, eindeloos. Dat ziet eruit als
  // "hij is soms online", en run_novabot.sh heeft er niet voor niets een
  // dubbel-start-guard voor (GH #60). Zichtbaar in de pogingen: hetzelfde
  // client_id vanaf twee adressen.
  const attempts = connectionEventRepo.recent(sn, 100);
  const addrsPerClient = new Map<string, Set<string>>();
  for (const a of attempts) {
    if (!a.remote_addr) continue;
    const set = addrsPerClient.get(a.mqtt_client_id) ?? new Set<string>();
    set.add(a.remote_addr);
    addrsPerClient.set(a.mqtt_client_id, set);
  }
  const clashing = [...addrsPerClient.entries()].find(([, set]) => set.size > 1);
  if (clashing) {
    push({
      id: 'client_conflict',
      group: 'connect',
      status: 'fail',
      evidence: `client_id ${clashing[0]} komt van ${[...clashing[1]].join(' en ')}`,
      action: "twee apparaten of processen gebruiken hetzelfde client_id en gooien "
            + 'elkaar er om beurten uit; zet er één uit',
    });
  } else {
    push({
      id: 'client_conflict',
      group: 'connect',
      status: 'ok',
      evidence: 'geen dubbel gebruikt client_id gezien',
    });
  }

  // ── Verbinding: komen de berichten leesbaar binnen ─────────────────────
  //
  // De AES-sleutel wordt afgeleid uit het serienummer. Klopt die niet, dan
  // verbindt het apparaat prima en komt er verder niets bruikbaars door: geen
  // foutmelding, alleen stilte. Verbonden zonder enige sensorwaarde is precies
  // dat beeld.
  if (!online) {
    push({ id: 'encryption', group: 'connect', status: 'skipped', evidence: 'hij is niet verbonden' });
  } else if (!snap || Object.keys(snap).length === 0) {
    push({
      id: 'encryption',
      group: 'connect',
      status: 'fail',
      evidence: 'verbonden, maar er is geen enkele meetwaarde binnengekomen',
      action: 'de berichten zijn niet te ontcijferen of hebben een ander formaat; '
            + 'controleer of het serienummer klopt, daar wordt de sleutel uit afgeleid',
    });
  } else {
    push({
      id: 'encryption',
      group: 'connect',
      status: 'ok',
      evidence: `${Object.keys(snap).length} meetwaarden ontvangen`,
    });
  }

  // ── Firmware ───────────────────────────────────────────────────────────
  const version = snap?.sw_version ?? eq?.mower_version ?? null;
  if (!version) {
    push({
      id: 'firmware',
      group: 'firmware',
      status: 'unknown',
      evidence: 'firmwareversie nog niet gemeld',
    });
  } else {
    const custom = /custom|opennova/i.test(version);
    const buildNum = Number(version.match(/custom-(\d+)/)?.[1] ?? NaN);
    push({
      id: 'firmware',
      group: 'firmware',
      status: 'ok',
      evidence: custom ? `${version} (OpenNova)` : `${version} (stock)`,
    });
    // De firmware stuurt map_ids boven 60000 naar zijn vision_test-taak, die
    // faalt met fout 125. Builds vanaf MAP_NAMES_SELECTION_BUILD kiezen zones op
    // naam en hebben er geen last van (GH #114).
    const workMaps = mapRepo.findByMowerSnAndType(sn, 'work').length;
    if (workMaps > 5 && !(custom && buildNum >= MAP_NAMES_SELECTION_BUILD)) {
      push({
        id: 'zone_limit',
        group: 'firmware',
        status: 'warn',
        evidence: `${workMaps} werkzones op firmware die er maximaal 5 aankan`,
        action: 'zones boven de vijfde eindigen in fout 125; werk de firmware bij '
              + `naar custom-${MAP_NAMES_SELECTION_BUILD} of hoger`,
      });
    }
  }

  // ── Klaar om te maaien ─────────────────────────────────────────────────
  if (deviceType === 'mower') {
    const workMaps = mapRepo.findByMowerSnAndType(sn, 'work').length;
    push({
      id: 'maps',
      group: 'ready',
      status: workMaps > 0 ? 'ok' : 'fail',
      evidence: workMaps > 0 ? `${workMaps} werkgebied(en)` : 'geen enkel werkgebied bekend',
      action: workMaps > 0 ? undefined : 'karteer eerst een gebied, zonder kaart start er niets',
    });

    if (!snap) {
      push({ id: 'rtk', group: 'ready', status: 'skipped', evidence: 'geen meetwaarden' });
      push({ id: 'fault', group: 'ready', status: 'skipped', evidence: 'geen meetwaarden' });
      push({ id: 'frame', group: 'ready', status: 'skipped', evidence: 'geen meetwaarden' });
    } else {
      // Zonder RTK-fix is de positie metersgroot onnauwkeurig en rijdt hij de
      // tuin uit. De correctie komt van het laadstation over LoRa, dus dit hangt
      // aan de stappen hierboven.
      const q = snap.rtk_fix_quality ?? snap.rtk_ok ?? '';
      const fixed = /fix/i.test(q) || q === '4';
      push({
        id: 'rtk',
        group: 'ready',
        status: fixed ? 'ok' : 'warn',
        evidence: q ? `RTK-status ${q}${snap.rtk_sat ? `, ${snap.rtk_sat} satellieten` : ''}`
                    : 'geen RTK-status gemeld',
        action: fixed ? undefined
          : 'zonder RTK-fix is de positie te onnauwkeurig om te maaien; '
          + 'controleer het laadstation en of het zicht op de hemel heeft',
      });

      const code = parseInt(snap.error_status ?? '0', 10) || 0;
      const blocking = deriveHasError(snap);
      push({
        id: 'fault',
        group: 'ready',
        status: blocking ? 'fail' : 'ok',
        evidence: code === 0 ? 'geen storing'
                : blocking ? `storing ${code} actief` : `melding ${code}, niet blokkerend`,
        action: blocking ? 'los de storing op of wis hem, anders start er geen taak' : undefined,
      });

      // Mapping-modus blokkeert het starten van een taak én het verwijderen van
      // kaarten. Hij komt er niet vanzelf uit.
      const mapping = snap.task_mode === '2' || snap.start_edit_or_assistant_map_flag === '1';
      push({
        id: 'mapping_mode',
        group: 'ready',
        status: mapping ? 'fail' : 'ok',
        evidence: mapping ? 'de maaier staat in karteermodus' : 'niet in karteermodus',
        action: mapping
          ? 'in deze stand start geen maaitaak en kun je geen kaart verwijderen; '
          + 'sluit het karteren af'
          : undefined,
      });

      // Een gestopte maaibeurt blijft geparkeerd staan, en dan weigert de
      // firmware een nieuwe start met "last task is executing".
      const ws = parseInt(snap.work_status ?? '0', 10) || 0;
      const parked = snap.task_mode === '1' && ws > 9;
      push({
        id: 'parked_task',
        group: 'ready',
        status: parked ? 'warn' : 'ok',
        evidence: parked ? `een onderbroken maaibeurt staat geparkeerd (status ${ws})`
                         : 'geen geparkeerde taak',
        action: parked
          ? 'de firmware weigert een nieuwe start zolang deze er staat; hervat hem of beëindig de sessie'
          : undefined,
      });

      const unvalidated = (snap.frame_unvalidated ?? '0') === '1';
      push({
        id: 'frame',
        group: 'ready',
        status: unvalidated ? 'fail' : 'ok',
        evidence: unvalidated ? 'het kaartframe is nog niet gecontroleerd na een herstel'
                              : 'kaartframe gecontroleerd',
        action: unvalidated ? 'anker de maaier opnieuw op het laadstation voor je gaat maaien'
                            : undefined,
      });
    }
  }

  // ── Op de maaier zelf ──────────────────────────────────────────────────
  //
  // Alles hierboven kijkt van buitenaf. Dat was niet genoeg: een maaier kan
  // online zijn, telemetrie sturen en toch volledig van de kaart verdwenen.
  // Van buiten ziet dat er gezond uit, van binnen stond mqtt_node zeventien uur
  // vast in een verbindingslus terwijl een verbinding vanaf diezelfde maaier op
  // datzelfde moment in 0,05 s lukte.
  const customFirmware = /custom|opennova/i.test(version ?? '');
  if (deviceType !== 'mower') {
    // niets: de groep gaat over de maaier
  } else if (!customFirmware) {
    push({
      id: 'mower_login',
      group: 'mower',
      status: 'skipped',
      evidence: 'stock firmware heeft geen SSH, dus hier valt niets te lezen',
    });
  } else if (input.probeNetwork === false || !reach.deviceIp) {
    push({
      id: 'mower_login',
      group: 'mower',
      status: 'skipped',
      evidence: reach.deviceIp ? 'niet gepeild' : 'geen adres bekend',
    });
  } else {
    const m = await probe.mower(reach.deviceIp);
    if (!m.reachable) {
      push({
        id: 'mower_login',
        group: 'mower',
        status: 'warn',
        evidence: `kan niet inloggen op ${reach.deviceIp}: ${m.error ?? 'onbekende reden'}`,
        action: 'zonder toegang tot de maaier zelf blijft de diagnose bij wat van '
              + 'buitenaf te zien is',
      });
    } else {
      push({ id: 'mower_login', group: 'mower', status: 'ok', evidence: `ingelogd op ${reach.deviceIp}` });

      // mqtt_node is de firmware-stack. Onze eigen scripts kunnen prima draaien
      // terwijl deze zwijgt, en dan lijkt alles in orde terwijl er niets werkt.
      if (!m.mqttNodeRunning) {
        push({
          id: 'mqtt_node',
          group: 'mower',
          status: 'fail',
          evidence: 'mqtt_node draait niet',
          action: 'zonder dit proces stuurt de maaier geen enkele status; '
                + 'herstart hem met set_server_urls.sh --restart-mqtt',
        });
      } else if (!m.mqttNodeConnected) {
        const uren = m.mqttNodeUptimeS != null ? Math.round(m.mqttNodeUptimeS / 3600) : null;
        push({
          id: 'mqtt_node',
          group: 'mower',
          status: 'fail',
          evidence: `mqtt_node draait${uren != null ? ` al ${uren} uur` : ''} maar heeft geen `
                  + `verbinding met de broker${m.mqttNetErrors > 0 ? `, ${m.mqttNetErrors} netwerkfouten in zijn log` : ''}`,
          action: 'hij is bij het opstarten blijven hangen en komt daar niet zelf uit; '
                + 'herstart hem met set_server_urls.sh --restart-mqtt',
        });
      } else {
        push({ id: 'mqtt_node', group: 'mower', status: 'ok', evidence: 'mqtt_node verbonden met de broker' });
      }

      // Het serveradres waar mqtt_node op afgaat. Een cloudnaam werkt alleen
      // zolang de DNS-omleiding staat; een IP is onafhankelijk.
      const cloudName = /lfibot\.com/i.test(m.mqttAddr ?? '');
      push({
        id: 'mower_config',
        group: 'mower',
        status: !m.hasSn ? 'fail' : cloudName ? 'warn' : 'ok',
        evidence: !m.hasSn
          ? 'json_config.json mist het serienummer'
          : `mqtt-adres in json_config.json: ${m.mqttAddr ?? 'leeg'}`,
        action: !m.hasSn
          ? 'zonder serienummer kan mqtt_node zich niet aanmelden'
          : cloudName
          ? 'dit is het cloudadres; het werkt alleen zolang je DNS het omleidt naar '
          + 'je eigen server. Een IP is betrouwbaarder'
          : undefined,
      });

      if (m.skippedConfigUpdate) {
        push({
          id: 'server_ip_file',
          group: 'mower',
          status: 'warn',
          evidence: `set_server_urls sloeg de config-update over${m.mdnsResolves ? '' : ', opennova.local lost op de maaier niet op'}`
                  + `${m.serverIp ? '' : ' en /userdata/lfi/server_ip.txt bestaat niet'}`,
          action: 'zet het serveradres in /userdata/lfi/server_ip.txt, dan vult het '
                + 'script json_config.json bij de volgende boot alsnog',
        });
      } else {
        push({
          id: 'server_ip_file',
          group: 'mower',
          status: 'ok',
          evidence: m.serverIp ? `laatst bekende server ${m.serverIp}` : 'config-update liep door',
        });
      }

      push({
        id: 'helpers',
        group: 'mower',
        status: m.extendedCommandsRunning ? 'ok' : 'warn',
        evidence: m.extendedCommandsRunning
          ? 'extended_commands draait'
          : 'extended_commands draait niet',
        action: m.extendedCommandsRunning ? undefined
          : 'zonder dit script werken de OpenNova-commando\'s en de RTK-telemetrie niet',
      });
    }
  }

  const firstBad = steps.find(s => s.status === 'fail') ?? steps.find(s => s.status === 'warn');
  return {
    sn,
    deviceType,
    stuckAt: firstBad?.id ?? null,
    summary: firstBad ? firstBad.evidence : 'alles in orde tot en met het LoRa-paar',
    steps,
    generatedAt: now,
  };
}
