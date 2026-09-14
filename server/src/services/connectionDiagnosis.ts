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
import { checkReachability } from './reachability.js';

export type StepStatus = 'ok' | 'fail' | 'warn' | 'unknown' | 'skipped';

export interface DiagnosisStep {
  /** Stable id, so the UI can translate without parsing prose. */
  id: string;
  status: StepStatus;
  /** What was actually observed. Facts, no advice. */
  evidence: string;
  /** The one next thing to do. Only set when status is fail or warn. */
  action?: string;
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

export async function diagnoseConnection(sn: string, now = Date.now()): Promise<Diagnosis> {
  const steps: DiagnosisStep[] = [];
  const deviceType = deviceTypeOf(sn);
  const push = (s: DiagnosisStep) => { steps.push(s); return s; };

  // No "is the server up" step: this answer only exists because the server
  // answered. A check that cannot fail is noise, and importing the broker here
  // to ask it drags in the socketHandler -> broker -> demoSimulator cycle.

  // 1. Can the device reach us at all? Without this the chain is blind to its
  //    own most basic failure: nothing arrives, so we see nothing, so we report
  //    nothing. Measurements only, no conclusions about what "probably" broke.
  const regEarly = deviceRepo.findBySn(sn);
  const reach = await checkReachability(regEarly?.ip_address ?? null);
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
      status: 'unknown',
      evidence: `${DEVICE_HOSTNAMES_LABEL} lost hier niet op`,
    });
  } else if (dnsPointsHere) {
    push({
      id: 'dns',
      status: 'ok',
      evidence: `${dnsAnswers.find(d => d.pointsHere)!.host} wijst naar deze server `
              + `(${reach.serverIps.join(', ') || 'onbekend adres'})`,
    });
  } else if (weServeDns) {
    push({
      id: 'dns',
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
      status: 'unknown',
      evidence: `${dnsElsewhere[0].host} lost hier op naar ${dnsElsewhere[0].addresses.join(', ')}. `
              + 'Deze server serveert de omleiding niet, dus dit zegt alleen iets als je '
              + 'apparaten dezelfde DNS gebruiken als deze container',
    });
  }

  if (!reach.deviceIp) {
    push({
      id: 'network',
      status: 'unknown',
      evidence: 'geen adres van dit apparaat bekend, dus niet te peilen',
    });
  } else if (reach.deviceAnswered) {
    push({
      id: 'network',
      status: 'ok',
      evidence: `${reach.deviceIp} antwoordt, het apparaat staat aan en zit op het netwerk`,
    });
  } else if (reach.sameSubnet === false) {
    push({
      id: 'network',
      status: 'fail',
      evidence: `laatst bekende adres ${reach.deviceIp} zit in een ander subnet dan deze server `
              + `(${reach.serverIps.join(', ')})`,
      action: 'zet beide in hetzelfde netwerk, of laat het verkeer ertussen door',
    });
  } else {
    push({
      id: 'network',
      status: 'unknown',
      evidence: `${reach.deviceIp} antwoordt niet op poort 22 of 8000; op stock firmware `
              + 'staan die dicht, dus dit bewijst niets',
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
      status: 'fail',
      evidence: `${sn} heeft zich nog nooit bij deze server gemeld`,
      action: 'het apparaat is nog niet ingericht of wijst naar een andere server: '
            + 'controleer wifi, de BLE-provisioning en of mqtt.lfibot.com naar dit adres verwijst',
    });
  } else if (online) {
    push({
      id: 'seen',
      status: 'ok',
      evidence: `laatst gezien ${ago(lastSeen as number, now)} als ${reg!.mqtt_client_id}`,
    });
  } else {
    push({
      id: 'seen',
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
    push({ id: 'attempts', status: 'skipped', evidence: 'niet nodig, hij is binnen' });
  } else if (worst && now - worst.ts < 24 * 60 * 60 * 1000) {
    push({
      id: 'attempts',
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
      status: 'fail',
      evidence: 'geen koppeling in equipment',
      action: 'koppel het apparaat via de app, dat schrijft de equipment-rij',
    });
  } else if (!eq.user_id) {
    push({
      id: 'binding',
      status: 'warn',
      evidence: 'gekoppeld maar zonder gebruiker (user_id leeg)',
      action: 'de app doet dan BLE-provisioning; rond die stap af in de app',
    });
  } else {
    push({ id: 'binding', status: 'ok', evidence: `gekoppeld aan gebruiker ${eq.user_id}` });
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
        status: 'warn',
        evidence: 'geen BLE MAC bekend bij de koppeling',
        action: 'zonder MAC herkent de app de maaier niet in een BLE-scan',
      });
    } else if (bound.toUpperCase().startsWith('48:27:E2')) {
      push({
        id: 'ble_mac',
        status: 'fail',
        evidence: `de opgeslagen MAC ${bound} is die van een laadstation, niet van de maaier`,
        action: 'laat de MAC opnieuw afleiden uit device_factory',
      });
    } else if (factory && bound.toUpperCase() !== factory.toUpperCase()) {
      push({
        id: 'ble_mac',
        status: 'warn',
        evidence: `MAC ${bound} wijkt af van de fabriekswaarde ${factory}`,
      });
    } else {
      push({ id: 'ble_mac', status: 'ok', evidence: `BLE MAC ${bound}` });
    }
  } else {
    push({ id: 'ble_mac', status: 'skipped', evidence: 'alleen van toepassing op een maaier' });
  }

  // 6. The charger side. A mower alone is half a system: without the charger
  //    there is no RTK correction, so it will mow badly or not at all.
  const counterpartSn = deviceType === 'mower' ? eq?.charger_sn : eq?.mower_sn;
  if (!counterpartSn) {
    push({
      id: 'counterpart',
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
        status: 'fail',
        evidence: `${counterpartSn} heeft zich nog nooit gemeld`,
        action: 'richt ook het laadstation in; het heeft een eigen wifi- en MQTT-verbinding',
      });
    } else if (now - cSeen > OFFLINE_AFTER_MS) {
      push({
        id: 'counterpart',
        status: 'fail',
        evidence: `${counterpartSn} laatst gezien ${ago(cSeen, now)}`,
        action: 'controleer de stroom en het wifi-bereik van het laadstation',
      });
    } else {
      push({ id: 'counterpart', status: 'ok', evidence: `${counterpartSn} gezien ${ago(cSeen, now)}` });
    }
  }

  // 7. LoRa pair. Reuses the existing comparison rather than re-deriving it.
  const pair = getLoraPair(sn);
  if (!pair) {
    push({ id: 'lora', status: 'skipped', evidence: 'geen LoRa-paar om te controleren' });
  } else if (pair.ok) {
    const c = pair.charger;
    push({
      id: 'lora',
      status: 'ok',
      evidence: `adres ${c?.addr ?? '?'} kanaal ${c?.channel ?? '?'} aan beide kanten gelijk`,
    });
  } else {
    const issues = pair.issues;
    const mismatch = issues.includes('addr-mismatch') || issues.includes('channel-mismatch');
    push({
      id: 'lora',
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
