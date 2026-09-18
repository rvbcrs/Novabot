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
import { dockSamplesRepo } from '../db/repositories/dockSamples.js';
import { computeDockDrift } from './dockDrift.js';
import { deviceRepo, equipmentRepo, connectionEventRepo } from '../db/repositories/index.js';
import { getLoraPair } from './loraPair.js';
import { checkReachability, serverIpv4, type Reachability } from './reachability.js';
import { probeMower, type MowerProbe } from './mowerProbe.js';
import { inspectContainerNetwork, type ContainerNetwork } from './containerNetwork.js';
import { mdnsStatus, selfQuery, type MdnsStatus } from './mdnsAdvertiser.js';
import { scanLan, lookupMac, rivalBrokers, identifyBroker, bleToWifiMac,
         type LanScanResult, type RivalBrokers, type BrokerIdentity } from './lanScan.js';
import { statfs } from 'fs/promises';
import { mapRepo, userRepo } from '../db/repositories/index.js';
import { deriveHasError } from '../mqtt/mowerActivity.js';
import { MAP_NAMES_SELECTION_BUILD } from './mowingArea.js';
import { translator, normalizeLang, type Lang, type Translate } from './diagnosisText.js';

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
  containerNetwork: () => ContainerNetwork;
  scanLan: () => Promise<LanScanResult>;
  rivalBrokers: (ourIps: string[]) => Promise<RivalBrokers>;
  identifyBroker: (ip: string) => Promise<BrokerIdentity>;
  lookupMac: (ip: string) => Promise<string | null>;
  mdnsStatus: () => MdnsStatus;
  mdnsSelfQuery: () => Promise<string[]>;
  /** MDNS_SIDECAR=true: the opennova-mdns service advertises from the host network on our behalf. */
  mdnsSidecar: () => boolean;
}

export const realProbes: DiagnosisProbes = {
  reachability: checkReachability,
  mower: probeMower,
  containerNetwork: inspectContainerNetwork,
  scanLan,
  rivalBrokers,
  identifyBroker,
  lookupMac,
  mdnsStatus,
  mdnsSelfQuery: selfQuery,
  mdnsSidecar: () => process.env.MDNS_SIDECAR === 'true' || process.env.MDNS_SIDECAR === '1',
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
  /**
   * Taal van de uitleg. Alleen de labels stonden in i18n; de zinnen eronder
   * kwamen altijd in het Nederlands binnen, ook bij een Duitse gebruiker.
   */
  lang?: Lang | string;
}

export interface Diagnosis {
  sn: string;
  deviceType: 'mower' | 'charger' | 'unknown';
  /** First hard failure, or null. A warning is not a blockage. */
  stuckAt: string | null;
  /** True only when something actually blocks. Drives the colour in the UI. */
  blocked: boolean;
  warningCount: number;
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

function ago(ts: number, now: number, T: Translate): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 90) return T`${s} s geleden`;
  const m = Math.round(s / 60);
  if (m < 90) return T`${m} min geleden`;
  const h = Math.round(m / 60);
  if (h < 48) return T`${h} uur geleden`;
  return T`${Math.round(h / 24)} dagen geleden`;
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
  const T = translator(normalizeLang(input.lang));
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
      evidence: T`${freeMb} MB vrij van ${totalMb} MB (${pct}%)`,
      action: freeMb < 1024
        ? T`kaartuploads en de database hebben ruimte nodig; maak schijfruimte vrij`
        : undefined,
    });
  } catch {
    push({ id: 'disk', group: 'server', status: 'unknown', evidence: T`schijfruimte niet op te vragen` });
  }

  // Twee brokers op één netwerk is een echte en verwarrende storing: maaiers
  // vinden via mDNS de verkeerde, springen heen en weer en lijken met tussen-
  // pozen offline. Precies wat hier op 14-09-2026 gebeurde toen een release een
  // tweede container op 1883 liet staan.
  const rivals = input.probeNetwork === false ? null : await probe.rivalBrokers(serverIpv4());
  // Groen melden vanaf een plek waar niets te zien valt is erger dan zwijgen:
  // binnen een bridged container kent de buurtabel alleen de docker-gateway.
  //
  // En een broker op 1883 is nog geen concurrent. Een Mosquitto voor Home
  // Assistant deelt het netwerk zonder ooit een maaier te zien; alleen een
  // tweede OpenNova-server claimt ze, via opennova.local en mqtt.lfibot.com.
  // Dus vragen we het elke broker: antwoordt dezelfde host als OpenNova, dan
  // is het er een. Een gebruiker met drie eigen brokers kreeg hier een rood
  // kruis met "zet er één uit" (2026-09-15); dat was de check, niet zijn netwerk.
  const identities = rivals?.looked ? await Promise.all(rivals.ips.map(ip => probe.identifyBroker(ip))) : [];
  const opennovaRivals = identities.filter(i => i.opennova);
  const foreign = identities.filter(i => !i.opennova);
  const describe = (i: BrokerIdentity) => i.version ? `${i.ip} (v${i.version})` : i.ip;
  push({
    id: 'rival_broker',
    group: 'server',
    status: rivals === null ? 'skipped' : !rivals.looked ? 'unknown' : opennovaRivals.length > 0 ? 'fail' : 'ok',
    evidence: rivals === null
      ? T`niet gepeild`
      : !rivals.looked
      ? T`niet te peilen: geen adres van deze server op het thuisnetwerk bekend`
      : opennovaRivals.length > 0
      ? T`nog een OpenNova-server op dit netwerk: ${opennovaRivals.map(describe).join(', ')}`
      : foreign.length > 0
      ? T`${foreign.length} andere MQTT-broker(s) op dit netwerk (${foreign.map(i => i.ip).join(', ')}); geen ervan is OpenNova, ze concurreren niet om de maaiers`
      : T`geen tweede MQTT-broker op dit netwerk`,
    action: opennovaRivals.length > 0
      ? T`twee OpenNova-servers claimen dezelfde maaiers via opennova.local en mqtt.lfibot.com; zet er één uit`
      : undefined,
  });

  // Of mDNS werkt is NIET af te leiden uit de netwerkmodus van de container.
  // Gemeten op 15-09-2026: een server in een bridged container (172.17.0.9) en
  // toch `getent hosts opennova.local -> 192.168.0.247` op de maaier ernaast.
  // De enige plek waar dit te meten valt is het apparaat dat de server moet
  // vinden, en dat doen we verderop met de SSH-peiling. Hier alleen de context,
  // zonder oordeel.
  const net = probe.containerNetwork();
  const here = net.addresses.join(', ') || T`deze machine`;
  const netDesc = !net.inContainer
    ? T`draait rechtstreeks op ${here}`
    : net.bridged
    ? T`container met bridge-netwerk (${net.addresses.join(', ')})`
    : T`container met host-netwerk (${net.addresses.join(', ')})`;
  // With the sidecar doing the advertising from the host network, the
  // bridge is no longer the thing standing between the mower and the name,
  // so the hint would only send someone looking for a problem that is not
  // there. Ramon: "die warnings zijn wat vreemd want dat is dan niet relevant
  // want je hebt sidecar".
  push({
    id: 'container_network', group: 'server', status: 'ok',
    evidence: netDesc,
    action: net.bridged && !probe.mdnsSidecar()
      ? T`in bridge-modus komt multicast meestal niet op het thuisnetwerk; of de maaier de server zo vindt staat verderop bij de maaier zelf`
      : undefined,
  });

  // ── mDNS op 5353: gemeten, en bij falen de oorzaak en de remedie ─────────
  //
  // Maaiers vinden de server via opennova.local. De advertiser start zonder
  // fout en wordt dan al dan niet gehoord; tot nu toe controleerde niets dat.
  // De zelftest vraagt het netwerk wie er voor onze naam antwoordt. Onszelf:
  // de weg over 224.0.0.251:5353 werkt. Iemand anders: een tweede server.
  // Niemand: multicast komt nergens. Wat de MAAIER hoort staat verderop.
  const md = probe.mdnsStatus();
  const sidecar = probe.mdnsSidecar();
  if (sidecar) {
    // The advertising happens in opennova-mdns, on the host network, where
    // this container cannot see it. The proof is at the mower (mdns_reach).
    push({
      id: 'mdns_service', group: 'server', status: 'ok',
      evidence: T`mDNS wordt geadverteerd door de opennova-mdns sidecar op het host-netwerk`,
      action: T`of de maaier de naam hoort staat verderop bij de maaier zelf`,
    });
  } else if (md.notStartedReason === 'disabled') {
    push({
      id: 'mdns_service', group: 'server', status: 'warn',
      evidence: T`mDNS is uitgezet (ENABLE_MDNS)`,
      action: T`maaiers kunnen deze server dan niet zelf vinden en hebben je DNS-omleiding nodig; zet ENABLE_MDNS niet op false als je automatisch ontdekken wilt`,
    });
  } else if (md.notStartedReason === 'no_ip') {
    push({
      id: 'mdns_service', group: 'server', status: 'fail',
      evidence: T`de advertiser is niet gestart: geen LAN-adres bekend`,
      action: T`zet TARGET_IP op het adres van deze server op je thuisnetwerk, binnen een container is dat niet zelf te bepalen`,
    });
  } else if (!md.running) {
    push({
      id: 'mdns_service', group: 'server', status: 'fail',
      evidence: md.lastError
        ? T`de advertiser draait niet: ${md.lastError}`
        : T`de advertiser draait niet`,
      action: T`herstart de server en kijk in het log naar [MDNS]`,
    });
  } else {
    const answers = input.probeNetwork === false ? null : await probe.mdnsSelfQuery();
    const others = (answers ?? []).filter(a => a !== md.ip);
    if (answers === null) {
      push({ id: 'mdns_service', group: 'server', status: 'skipped', evidence: T`niet gepeild` });
    } else if (md.lastError && answers.length === 0) {
      push({
        id: 'mdns_service', group: 'server', status: 'fail',
        evidence: T`poort ${md.port} geeft een fout: ${md.lastError}`,
        action: /EADDRINUSE|in use/i.test(md.lastError)
          ? T`iets anders heeft 5353 al, meestal avahi op de host bij host-netwerk; stop dat of zet MDNS_PORT anders (de maaiers verwachten wel 5353)`
          : /EPERM|EACCES/i.test(md.lastError)
          ? T`de container mag geen multicast versturen; geef hem host-netwerk of de juiste rechten`
          : T`kijk in het serverlog naar [MDNS] voor de volledige fout`,
      });
    } else if (others.length > 0) {
      push({
        id: 'mdns_service', group: 'server', status: 'fail',
        evidence: T`${md.hostname} wordt óók beantwoord door ${others.join(', ')}`,
        action: T`twee servers claimen dezelfde naam en maaiers kiezen willekeurig; zet de andere uit of geef hem ENABLE_MDNS=false`,
      });
    } else if (answers.includes(md.ip ?? '') && probe.containerNetwork().bridged) {
      // On docker's bridge our own answer always arrives: multicast loops back
      // to the sender on docker0. That proves the socket works, not that the
      // home network hears us, which is what the question was. So no green
      // tick. Ramon: "als mDNS alleen door de server zelf wordt beantwoord heb
      // je niks aan de test". The proof is at the mower (mdns_reach).
      push({
        id: 'mdns_service', group: 'server', status: 'unknown',
        evidence: T`${md.hostname} wordt op 5353 alleen door deze container zelf beantwoord; in bridge-modus zegt dat niets over je thuisnetwerk`,
        action: T`of de maaier de naam hoort staat verderop bij de maaier zelf. Wil je automatisch ontdekken, zet de opennova-mdns sidecar aan (staat in docker-compose.yml) of draai met host-netwerk`,
      });
    } else if (answers.includes(md.ip ?? '')) {
      push({
        id: 'mdns_service', group: 'server', status: 'ok',
        evidence: T`${md.hostname} wordt op 5353 beantwoord met ${md.ip}`,
      });
    } else {
      const net = probe.containerNetwork();
      push({
        id: 'mdns_service', group: 'server', status: 'fail',
        evidence: T`${md.hostname} wordt op 224.0.0.251:5353 door niemand beantwoord, ook niet door deze server zelf`,
        action: net.bridged
          ? T`multicast komt de container niet in of uit; zet "5353:5353/udp" in de compose-ports of draai met network_mode: host`
          : T`controleer of een firewall multicast op 224.0.0.251 blokkeert`,
      });
    }
  }

  // No "is the server up" step: this answer only exists because the server
  // answered. A check that cannot fail is noise, and importing the broker here
  // to ask it drags in the socketHandler -> broker -> demoSimulator cycle.

  // 1. Can the device reach us at all? Without this the chain is blind to its
  //    own most basic failure: nothing arrives, so we see nothing, so we report
  //    nothing. Measurements only, no conclusions about what "probably" broke.
  const regEarly = deviceRepo.findBySn(sn);
  const reach = await probe.reachability(regEarly?.ip_address ?? null);
  const dnsAnswers = reach.dns.filter(d => d.addresses.length > 0);
  // Toon het adres waartegen we vergeleken hebben. serverIps bevat in een
  // bridged container 172.17.0.x, en dat stond onder een match die op het
  // LAN-adres gemaakt was.
  const ourAddr = (reach.lanIps.length ? reach.lanIps : reach.serverIps).join(', ');
  // null = niet te beoordelen: binnen een bridged container kennen we ons eigen
  // adres op het thuisnetwerk niet, en dan zegt een vergelijking niets.
  const dnsUnknown = dnsAnswers.length > 0 && dnsAnswers.every(d => d.pointsHere === null);
  const dnsPointsHere = dnsAnswers.some(d => d.pointsHere === true);
  const dnsElsewhere = dnsAnswers.filter(d => d.pointsHere === false);

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
      evidence: T`${DEVICE_HOSTNAMES_LABEL} lost hier niet op`,
    });
  } else if (dnsUnknown) {
    push({
      id: 'dns',
      group: 'reach',
      status: 'unknown',
      evidence: T`${dnsAnswers[0].host} lost op naar ${dnsAnswers[0].addresses.join(', ')}; deze server draait in een container en kent zijn eigen adres op het thuisnetwerk niet, dus daar valt niets uit af te leiden`,
    });
  } else if (dnsPointsHere) {
    push({
      id: 'dns',
      group: 'reach',
      status: 'ok',
      evidence: T`${dnsAnswers.find(d => d.pointsHere)!.host} wijst naar deze server (${ourAddr || 'onbekend adres'})`,
    });
  } else if (weServeDns) {
    push({
      id: 'dns',
      group: 'reach',
      status: 'fail',
      evidence: T`deze server serveert de omleiding, maar ${dnsElsewhere[0].host} wijst naar ${dnsElsewhere[0].addresses.join(', ')} en niet naar ${ourAddr || 'onbekend'}`,
      action: T`zet de omleiding op het huidige serveradres; dit adres is waarschijnlijk veranderd sinds de installatie`,
    });
  } else {
    push({
      id: 'dns',
      group: 'reach',
      status: 'unknown',
      evidence: T`${dnsElsewhere[0].host} lost hier op naar ${dnsElsewhere[0].addresses.join(', ')}. Deze server serveert de omleiding niet, dus dit zegt alleen iets als je apparaten dezelfde DNS gebruiken als deze container`,
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
        evidence: T`geen adres van dit apparaat bekend, dus niet te peilen`,
      });
    } else if (!lan.canSeeLan) {
      push({
        id: 'network',
        group: 'reach',
        status: 'unknown',
        evidence: T`geen adres bekend en ${lan.reason}`,
        action: lan.reason?.includes('bridge')
          ? T`draai de container met host-netwerk om het lokale netwerk te kunnen inzien`
          : undefined,
      });
    } else if (lan.found.length === 0) {
      push({
        id: 'network',
        group: 'reach',
        status: 'fail',
        evidence: T`geen enkel LFI-apparaat gevonden op ${lan.subnet}.0/24 (${lan.neighbourCount} apparaten bekeken)`,
        action: T`het apparaat hangt niet aan dit netwerk: controleer de stroom en of de wifi-gegevens goed zijn doorgegeven`,
      });
    } else {
      const mine = lan.found.find(f => f.sn === sn);
      const sameKind = lan.found.filter(f => f.kind === deviceType);
      if (mine) {
        push({
          id: 'network',
          group: 'reach',
          status: 'fail',
          evidence: T`gevonden op ${mine.ip} (MAC ${mine.mac}), maar hij praat geen MQTT met ons`,
          action: T`hij hangt aan het netwerk, dus het probleem zit in de serverinstelling van het apparaat: naar welk adres wijst het`,
        });
      } else if (sameKind.length > 0) {
        push({
          id: 'network',
          group: 'reach',
          status: 'warn',
          evidence: deviceType === 'charger'
            ? T`${sameKind.length} laadstation(s) op het netwerk (${sameKind.map(f => f.ip).join(', ')}), maar niet deze`
            : T`${sameKind.length} maaier(s) op het netwerk (${sameKind.map(f => f.ip).join(', ')}), maar niet deze`,
          action: T`controleer of het serienummer klopt, of dit apparaat staat uit`,
        });
      } else {
        push({
          id: 'network',
          group: 'reach',
          status: 'fail',
          evidence: deviceType === 'charger'
            ? T`wel ${lan.found.length} LFI-apparaat(en) gezien, geen ervan is een laadstation`
            : T`wel ${lan.found.length} LFI-apparaat(en) gezien, geen ervan is een maaier`,
          action: T`dit apparaat hangt niet aan het netwerk`,
        });
      }
    }
  } else if (reach.deviceAnswered) {
    push({
      id: 'network',
      group: 'reach',
      status: 'ok',
      evidence: T`${reach.deviceIp} antwoordt, het apparaat staat aan en zit op het netwerk`,
    });
  } else if (deviceType === 'charger') {
    // 22 en 8000 zijn maaierpoorten. Een laadstation is een ESP32 en heeft
    // geen van beide, dus "antwoordt niet op poort 22 of 8000" zei bij elke
    // lader hetzelfde en betekende niets. Wat we wel weten: of hij zich meldt.
    const seenAt = parseLastSeen(regEarly);
    const chargerOnline = seenAt !== null && (now - seenAt) < OFFLINE_AFTER_MS;
    push({
      id: 'network',
      group: 'reach',
      status: chargerOnline ? 'ok' : 'unknown',
      evidence: chargerOnline
        ? T`${reach.deviceIp} is via MQTT verbonden, dus hij zit op het netwerk`
        : T`een laadstation heeft geen poorten om te peilen, dus van buitenaf valt niet te zien of ${reach.deviceIp} er nog is`,
    });
  } else if (reach.sameSubnet === null) {
    push({
      id: 'network',
      group: 'reach',
      status: 'unknown',
      evidence: T`${reach.deviceIp} antwoordt niet op poort 22 of 8000; op stock firmware staan die dicht, dus dit bewijst niets`,
    });
  } else if (reach.sameSubnet === false) {
    push({
      id: 'network',
      group: 'reach',
      status: 'fail',
      evidence: T`laatst bekende adres ${reach.deviceIp} zit in een ander subnet dan deze server (${ourAddr || 'onbekend'})`,
      action: T`zet beide in hetzelfde netwerk, of laat het verkeer ertussen door`,
    });
  } else {
    push({
      id: 'network',
      group: 'reach',
      status: 'unknown',
      evidence: T`${reach.deviceIp} antwoordt niet op poort 22 of 8000; op stock firmware staan die dicht, dus dit bewijst niets`,
    });
  }

  // Wifi: deze apparaten hebben geen ethernet, dus een adres op het netwerk
  // betekent dat de wifi staat. Het MAC wordt opgezocht en niet uitgerekend: de
  // afstand tussen wifi en BLE verschilt per hardware (ESP32 +2, LFIN +1).
  if (!reach.deviceIp) {
    push({ id: 'wifi', group: 'reach', status: 'skipped', evidence: T`geen adres bekend` });
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
    const parts = [T`verbonden via wifi op ${reach.deviceIp}`];
    if (looked) parts.push(T`MAC ${looked}`);
    else if (derived) parts.push(T`MAC ${derived} (afgeleid uit de BLE-MAC ${bleKnown})`);
    if (Number.isFinite(rssi)) parts.push(T`signaal ${rssi}%`);
    // Onder de 40% valt de verbinding met enige regelmaat weg, en dat is
    // precies het beeld van "hij is soms online".
    const weak = Number.isFinite(rssi) && rssi < 40;
    push({
      id: 'wifi',
      group: 'reach',
      status: weak ? 'warn' : 'ok',
      evidence: parts.join(', ')
              + (looked || derived ? '' : T` (MAC nergens bekend)`),
      action: weak ? T`zwak signaal, de verbinding valt daar met regelmaat van weg; zet een toegangspunt dichterbij` : undefined,
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
      evidence: T`${sn} heeft zich nog nooit bij deze server gemeld`,
      action: T`het apparaat is nog niet ingericht of wijst naar een andere server: controleer wifi, de BLE-provisioning en of mqtt.lfibot.com naar dit adres verwijst`,
    });
  } else if (online) {
    push({
      id: 'seen',
      group: 'connect',
      status: 'ok',
      evidence: T`laatst gezien ${ago(lastSeen as number, now, T)} als ${reg!.mqtt_client_id}`,
    });
  } else {
    push({
      id: 'seen',
      group: 'connect',
      status: 'fail',
      evidence: T`was verbonden, maar laatst gezien ${ago(lastSeen as number, now, T)}`,
      action: T`hij wérkte eerder, dus zoek wat er rond dat moment veranderde: stroom, wifi, DNS of een serverherstart`,
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
      group: 'connect', status: 'skipped', evidence: T`niet nodig, hij is binnen` });
  } else if (worst && now - worst.ts < 24 * 60 * 60 * 1000) {
    push({
      id: 'attempts',
      group: 'connect',
      status: 'fail',
      evidence: T`laatste poging ${ago(worst.ts, now, T)} geweigerd: ${worst.reason ?? 'onbekende reden'}`,
      action: worst.reason === 'banned'
        ? T`dit serienummer staat geblokkeerd na een "verwijder en verban": koppel het apparaat opnieuw via de app`
        : T`het apparaat bereikt de server wel maar komt niet door: controleer de inloggegevens en het serienummer`,
    });
  } else {
    push({
      id: 'attempts',
      group: 'connect',
      status: everSeen ? 'warn' : 'fail',
      evidence: T`geen enkele verbindingspoging geregistreerd in de laatste 24 uur`,
      action: T`er komt niets binnen, dus het probleem zit vóór de broker: netwerk, DNS of het apparaat staat uit`,
    });
  }

  // 4. Bound to a user? An unbound device connects fine and then does nothing.
  const eq = equipmentRepo.findBySn(sn);
  if (!eq) {
    push({
      id: 'binding',
      group: 'identity',
      status: 'fail',
      evidence: T`geen koppeling in equipment`,
      action: T`koppel het apparaat via de app, dat schrijft de equipment-rij`,
    });
  } else if (!eq.user_id) {
    push({
      id: 'binding',
      group: 'identity',
      status: 'warn',
      evidence: T`gekoppeld maar zonder gebruiker (user_id leeg)`,
      action: T`de app doet dan BLE-provisioning; rond die stap af in de app`,
    });
  } else {
    // De guid zegt niemand iets. De naam of het e-mailadres wel.
    const user = userRepo.findById(eq.user_id);
    const who = user?.username || user?.email || eq.user_id;
    push({ id: 'binding', group: 'identity', status: 'ok', evidence: T`gekoppeld aan ${who}` });
  }

  // 4b. The factory table came from a one-off scan of the LFI cloud and can
  //     miss a serial. Then the official app fails at pairing with "Device is
  //     missing mac address" and nothing on this server explains why. The
  //     cloud login during setup learns missing serials; someone who skipped
  //     it only finds out here.
  if (deviceType === 'mower' || deviceType === 'charger') {
    if (deviceRepo.getFactoryDevice(sn)) {
      push({ id: 'factory', group: 'identity', status: 'ok', evidence: T`serienummer staat in de fabriekslijst` });
    } else {
      push({
        id: 'factory',
        group: 'identity',
        status: 'warn',
        evidence: T`serienummer ${sn} staat niet in OpenNova's fabriekslijst`,
        action: T`de officiële Novabot-app kan dit apparaat dan niet koppelen ("Device is missing mac address"); gebruik de OpenNova-app, die vindt het apparaat via Bluetooth, of log in het admin-paneel eenmalig in bij de cloud (Settings → Cloud import), en meld het serienummer op GitHub zodat het aan de lijst wordt toegevoegd`,
      });
    }
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
        evidence: T`geen BLE MAC bekend bij de koppeling`,
        action: T`zonder MAC herkent de app de maaier niet in een BLE-scan`,
      });
    } else if (bound.toUpperCase().startsWith('48:27:E2')) {
      push({
        id: 'ble_mac',
      group: 'identity',
        status: 'fail',
        evidence: T`de opgeslagen MAC ${bound} is die van een laadstation, niet van de maaier`,
        action: T`laat de MAC opnieuw afleiden uit device_factory`,
      });
    } else if (factory && bound.toUpperCase() !== factory.toUpperCase()) {
      push({
        id: 'ble_mac',
      group: 'identity',
        status: 'warn',
        evidence: T`MAC ${bound} wijkt af van de fabriekswaarde ${factory}`,
      });
    } else {
      push({ id: 'ble_mac',
      group: 'identity', status: 'ok', evidence: T`BLE MAC ${bound}` });
    }
  } else if (deviceType === 'charger') {
    // Een laadstation heeft net zo goed BLE, en de fabriekstabel kent zijn MAC:
    // de wifi-stap hierboven leidt het wifi-adres er al uit af. equipment
    // .mac_address is hier NIET de bron, die hoort per ontwerp bij de maaier.
    const factory = deviceRepo.getFactoryMac(sn);
    push({
      id: 'ble_mac',
      group: 'identity',
      status: factory ? 'ok' : 'unknown',
      evidence: factory ? T`BLE MAC ${factory}` : T`geen BLE MAC bekend voor dit laadstation`,
    });
  } else {
    push({ id: 'ble_mac',
      group: 'identity', status: 'skipped', evidence: T`alleen van toepassing op een maaier of laadstation` });
  }

  // 6. The charger side. A mower alone is half a system: without the charger
  //    there is no RTK correction, so it will mow badly or not at all.
  const counterpartSn = deviceType === 'mower' ? eq?.charger_sn : eq?.mower_sn;
  if (!counterpartSn) {
    push({
      id: 'counterpart',
      group: 'pair',
      status: 'warn',
      evidence: deviceType === 'mower' ? T`geen laadstation gekoppeld` : T`geen maaier gekoppeld`,
      action: T`zonder laadstation is er geen RTK-correctie en dus geen nauwkeurige positie`,
    });
  } else {
    const cReg = deviceRepo.findBySn(counterpartSn);
    const cSeen = parseLastSeen(cReg);
    if (cSeen === null) {
      push({
        id: 'counterpart',
      group: 'pair',
        status: 'fail',
        evidence: T`${counterpartSn} heeft zich nog nooit gemeld`,
        action: T`richt ook het laadstation in; het heeft een eigen wifi- en MQTT-verbinding`,
      });
    } else if (now - cSeen > OFFLINE_AFTER_MS) {
      push({
        id: 'counterpart',
      group: 'pair',
        status: 'fail',
        evidence: T`${counterpartSn} laatst gezien ${ago(cSeen, now, T)}`,
        action: T`controleer de stroom en het wifi-bereik van het laadstation`,
      });
    } else {
      push({ id: 'counterpart',
      group: 'pair', status: 'ok', evidence: T`${counterpartSn} gezien ${ago(cSeen, now, T)}` });
    }
  }

  // 7. LoRa pair. Reuses the existing comparison rather than re-deriving it.
  //
  // Alleen te controleren op OpenNova-firmware: de maaierkant wordt opgevraagd
  // over novabot/extended/<SN>, en dat topic bestaat op stock niet. Daar bleef
  // het antwoord dus altijd uit en stond er een rood kruis met
  // "missing-mower-cache" bij een lader die gewoon werkte.
  const mowerVersionForLora = snap?.sw_version ?? eq?.mower_version ?? null;
  const canReadLora = /custom|opennova/i.test(mowerVersionForLora ?? '');
  const pair = getLoraPair(sn);
  const unreadOnly = pair !== null && !pair.ok
    && pair.issues.every(i => i === 'missing-mower-cache' || i === 'missing-charger-cache');
  if (!pair) {
    push({ id: 'lora',
      group: 'pair', status: 'skipped', evidence: T`geen LoRa-paar om te controleren` });
  } else if (!canReadLora) {
    push({
      id: 'lora',
      group: 'pair',
      status: 'skipped',
      evidence: T`de LoRa-instellingen van de maaier zijn alleen op OpenNova-firmware uit te lezen`,
    });
  } else if (pair.ok) {
    const c = pair.charger;
    push({
      id: 'lora',
      group: 'pair',
      status: 'ok',
      evidence: T`adres ${c?.addr ?? '?'} kanaal ${c?.channel ?? '?'} aan beide kanten gelijk`,
    });
  } else if (unreadOnly) {
    // Nog niet gelezen is geen ongelijk paar.
    push({
      id: 'lora',
      group: 'pair',
      status: 'unknown',
      evidence: T`de LoRa-instellingen zijn nog niet van beide apparaten gelezen`,
    });
  } else {
    push({
      id: 'lora',
      group: 'pair',
      status: 'fail',
      evidence: T`maaier ${pair.mower?.addr ?? '?'}/${pair.mower?.channel ?? '?'} tegen lader ${pair.charger?.addr ?? '?'}/${pair.charger?.channel ?? '?'}`,
      action: T`adres en kanaal moeten IDENTIEK zijn aan beide kanten; koppel opnieuw via de app`,
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
      evidence: T`client_id ${clashing[0]} komt van ${[...clashing[1]].join(' en ')}`,
      action: T`twee apparaten of processen gebruiken hetzelfde client_id en gooien elkaar er om beurten uit; zet er één uit`,
    });
  } else {
    push({
      id: 'client_conflict',
      group: 'connect',
      status: 'ok',
      evidence: T`geen dubbel gebruikt client_id gezien`,
    });
  }

  // ── Verbinding: komen de berichten leesbaar binnen ─────────────────────
  //
  // De AES-sleutel wordt afgeleid uit het serienummer. Klopt die niet, dan
  // verbindt het apparaat prima en komt er verder niets bruikbaars door: geen
  // foutmelding, alleen stilte. Verbonden zonder enige sensorwaarde is precies
  // dat beeld.
  if (!online) {
    push({ id: 'encryption', group: 'connect', status: 'skipped', evidence: T`hij is niet verbonden` });
  } else if (!snap || Object.keys(snap).length === 0) {
    push({
      id: 'encryption',
      group: 'connect',
      status: 'fail',
      evidence: T`verbonden, maar er is geen enkele meetwaarde binnengekomen`,
      action: T`de berichten zijn niet te ontcijferen of hebben een ander formaat; controleer of het serienummer klopt, daar wordt de sleutel uit afgeleid`,
    });
  } else {
    push({
      id: 'encryption',
      group: 'connect',
      status: 'ok',
      evidence: T`${Object.keys(snap).length} meetwaarden ontvangen`,
    });
  }

  // ── Op de maaier inloggen, vóór het firmware-oordeel ───────────────────
  // SSH is iets wat onze build aanzet. Lukt inloggen, dan IS het OpenNova,
  // wat de server ook geregistreerd heeft. Op 2026-09-16 draaide
  // LFIN1231000009 custom-38 terwijl de database v5.7.1 zei: mqtt_node had
  // nooit verbonden en dus nooit een versie gemeld. De peiling op de gemelde
  // versie laten afhangen verborg precies het geval waar hij voor was.
  const m = deviceType === 'mower' && input.probeNetwork !== false && reach.deviceIp
    ? await probe.mower(reach.deviceIp)
    : null;
  const sshWorks = m?.reachable === true;

  // ── Firmware ───────────────────────────────────────────────────────────
  // Bij een lader stond hier de versie van de GEKOPPELDE MAAIER: eq draagt
  // beide kanten, en mower_version was de enige bron. In het admin panel las
  // dat als "deze lader draait v5.7.1 stock" (2026-09-15).
  const version = deviceType === 'charger'
    ? eq?.charger_version ?? null
    : snap?.sw_version ?? eq?.mower_version ?? null;
  const recordedCustom = /custom|opennova/i.test(version ?? '');
  if (sshWorks && !recordedCustom) {
    push({
      id: 'firmware',
      group: 'firmware',
      status: 'warn',
      evidence: version
        ? T`de server kent ${version} (stock), maar inloggen via SSH lukt en dat kan alleen op OpenNova-firmware; op de maaier staat ${m!.version ?? 'geen leesbare versie'}`
        : T`de server kent geen versie, maar inloggen via SSH lukt en dat kan alleen op OpenNova-firmware; op de maaier staat ${m!.version ?? 'geen leesbare versie'}`,
      action: T`de versie in de server komt van mqtt_node; zolang die niet verbindt blijft de oude staan, zie de maaier-groep hieronder`,
    });
  } else if (!version) {
    push({
      id: 'firmware',
      group: 'firmware',
      status: 'unknown',
      evidence: T`firmwareversie nog niet gemeld`,
    });
  } else {
    push({
      id: 'firmware',
      group: 'firmware',
      status: 'ok',
      evidence: recordedCustom ? T`${version} (OpenNova)` : T`${version} (stock)`,
    });
  }
  {
    const custom = sshWorks || recordedCustom;
    const buildNum = Number((m?.version ?? version ?? '').match(/custom-(\d+)/)?.[1] ?? NaN);
    // De firmware stuurt map_ids boven 60000 naar zijn vision_test-taak, die
    // faalt met fout 125. Builds vanaf MAP_NAMES_SELECTION_BUILD kiezen zones op
    // naam en hebben er geen last van (GH #114).
    const workMaps = mapRepo.findByMowerSnAndType(sn, 'work').length;
    if (workMaps > 5 && !(custom && buildNum >= MAP_NAMES_SELECTION_BUILD)) {
      push({
        id: 'zone_limit',
        group: 'firmware',
        status: 'warn',
        evidence: T`${workMaps} werkzones op firmware die er maximaal 5 aankan`,
        action: T`zones boven de vijfde eindigen in fout 125; werk de firmware bij naar custom-${MAP_NAMES_SELECTION_BUILD} of hoger`,
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
      evidence: workMaps > 0 ? T`${workMaps} werkgebied(en)` : T`geen enkel werkgebied bekend`,
      action: workMaps > 0 ? undefined : T`karteer eerst een gebied, zonder kaart start er niets`,
    });

    if (!snap) {
      push({ id: 'rtk', group: 'ready', status: 'skipped', evidence: T`geen meetwaarden` });
      push({ id: 'fault', group: 'ready', status: 'skipped', evidence: T`geen meetwaarden` });
      push({ id: 'frame', group: 'ready', status: 'skipped', evidence: T`geen meetwaarden` });
    } else {
      // Zonder RTK-fix is de positie metersgroot onnauwkeurig en rijdt hij de
      // tuin uit. De correctie komt van het laadstation over LoRa, dus dit hangt
      // aan de stappen hierboven.
      const q = snap.rtk_fix_quality ?? snap.rtk_ok ?? '';
      const fixed = /fix/i.test(q) || q === '4';
      // Niets ontvangen is niet hetzelfde als geen fix. Advies over vrij zicht
      // op de hemel onder "geen RTK-status gemeld" leest als een diagnose van
      // de ontvangst, terwijl er alleen nog geen meting binnen is.
      push({
        id: 'rtk',
        group: 'ready',
        status: !q ? 'unknown' : fixed ? 'ok' : 'warn',
        evidence: !q ? T`nog geen RTK-status ontvangen`
                : snap.rtk_sat ? T`RTK-status ${q}, ${snap.rtk_sat} satellieten`
                : T`RTK-status ${q}`,
        action: !q || fixed ? undefined
          : T`zonder RTK-fix is de positie te onnauwkeurig om te maaien; controleer het laadstation en of het zicht op de hemel heeft`,
      });

      const code = parseInt(snap.error_status ?? '0', 10) || 0;
      const blocking = deriveHasError(snap);
      push({
        id: 'fault',
        group: 'ready',
        status: blocking ? 'fail' : 'ok',
        evidence: code === 0 ? T`geen storing`
                : blocking ? T`storing ${code} actief` : T`melding ${code}, niet blokkerend`,
        action: blocking ? T`los de storing op of wis hem, anders start er geen taak` : undefined,
      });

      // Mapping-modus blokkeert het starten van een taak én het verwijderen van
      // kaarten. Hij komt er niet vanzelf uit.
      const mapping = snap.task_mode === '2' || snap.start_edit_or_assistant_map_flag === '1';
      push({
        id: 'mapping_mode',
        group: 'ready',
        status: mapping ? 'fail' : 'ok',
        evidence: mapping ? T`de maaier staat in karteermodus` : T`niet in karteermodus`,
        action: mapping
          ? T`in deze stand start geen maaitaak en kun je geen kaart verwijderen; sluit het karteren af`
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
        evidence: parked ? T`een onderbroken maaibeurt staat geparkeerd (status ${ws})`
                         : T`geen geparkeerde taak`,
        action: parked
          ? T`de firmware weigert een nieuwe start zolang deze er staat; hervat hem of beëindig de sessie`
          : undefined,
      });

      const unvalidated = (snap.frame_unvalidated ?? '0') === '1';
      push({
        id: 'frame',
        group: 'ready',
        status: unvalidated ? 'fail' : 'ok',
        evidence: unvalidated ? T`het kaartframe is nog niet gecontroleerd na een herstel`
                              : T`kaartframe gecontroleerd`,
        action: unvalidated ? T`anker de maaier opnieuw op het laadstation voor je gaat maaien`
                            : undefined,
      });

      // Het laadstation staat stil, dus de gedockte positie (RTK Fixed) moet
      // elke dag dezelfde zijn. Loopt die weg, dan is de antenne van het
      // station of het kaartframe verschoven en liggen de zones niet meer
      // waar ze gereden zijn.
      const drift = computeDockDrift(dockSamplesRepo.listSince(sn, 90));
      if (drift.status === 'unknown' || !drift.latest || !drift.referenceAt) {
        push({ id: 'dock_drift', group: 'ready', status: 'unknown', evidence: T`nog te weinig dockingen gezien om de positie te vergelijken` });
      } else {
        const cm = Math.round(drift.latest.dist * 100);
        const since = drift.referenceAt.slice(0, 10);
        push({
          id: 'dock_drift',
          group: 'ready',
          status: drift.status,
          evidence: drift.status === 'ok'
            ? T`gedockte positie stabiel (${cm} cm t.o.v. ${since})`
            : T`de maaier parkeert ${cm} cm van waar hij op ${since} stond`,
          action: drift.status === 'ok' ? undefined
            : T`controleer of het laadstation of zijn antenne is verschoven; staat het goed, anker dan opnieuw`,
        });
      }
    }
  }

  // ── Op de maaier zelf ──────────────────────────────────────────────────
  //
  // Alles hierboven kijkt van buitenaf. Dat was niet genoeg: een maaier kan
  // online zijn, telemetrie sturen en toch volledig van de kaart verdwenen.
  // Van buiten ziet dat er gezond uit, van binnen stond mqtt_node zeventien uur
  // vast in een verbindingslus terwijl een verbinding vanaf diezelfde maaier op
  // datzelfde moment in 0,05 s lukte.
  if (deviceType !== 'mower') {
    // niets: de groep gaat over de maaier
  } else if (m === null) {
    push({
      id: 'mower_login',
      group: 'mower',
      status: 'skipped',
      evidence: reach.deviceIp ? T`niet gepeild` : T`geen adres bekend`,
    });
  } else if (!m.reachable && !recordedCustom) {
    push({
      id: 'mower_login',
      group: 'mower',
      status: 'skipped',
      evidence: T`stock firmware heeft geen SSH, dus hier valt niets te lezen`,
    });
  } else {
    if (!m.reachable) {
      push({
        id: 'mower_login',
        group: 'mower',
        status: 'warn',
        evidence: T`kan niet inloggen op ${reach.deviceIp}: ${m.error ?? 'onbekende reden'}`,
        action: T`zonder toegang tot de maaier zelf blijft de diagnose bij wat van buitenaf te zien is`,
      });
    } else {
      push({ id: 'mower_login', group: 'mower', status: 'ok', evidence: T`ingelogd op ${reach.deviceIp}` });

      // mqtt_node is de firmware-stack. Onze eigen scripts kunnen prima draaien
      // terwijl deze zwijgt, en dan lijkt alles in orde terwijl er niets werkt.
      if (!m.mqttNodeRunning) {
        push({
          id: 'mqtt_node',
          group: 'mower',
          status: 'fail',
          evidence: T`mqtt_node draait niet`,
          action: T`zonder dit proces stuurt de maaier geen enkele status; herstart hem met set_server_urls.sh --restart-mqtt`,
        });
      } else if (!m.mqttNodeConnected) {
        const uren = m.mqttNodeUptimeS != null ? Math.round(m.mqttNodeUptimeS / 3600) : null;
        push({
          id: 'mqtt_node',
          group: 'mower',
          status: 'fail',
          evidence: uren != null
            ? m.mqttNetErrors > 0
              ? T`mqtt_node draait al ${uren} uur maar heeft geen verbinding met de broker, ${m.mqttNetErrors} netwerkfouten in zijn log`
              : T`mqtt_node draait al ${uren} uur maar heeft geen verbinding met de broker`
            : m.mqttNetErrors > 0
              ? T`mqtt_node draait maar heeft geen verbinding met de broker, ${m.mqttNetErrors} netwerkfouten in zijn log`
              : T`mqtt_node draait maar heeft geen verbinding met de broker`,
          action: T`hij is bij het opstarten blijven hangen en komt daar niet zelf uit; herstart hem met set_server_urls.sh --restart-mqtt`,
        });
      } else {
        push({ id: 'mqtt_node', group: 'mower', status: 'ok', evidence: T`mqtt_node verbonden met de broker` });
      }

      // De netcheck van mqtt_node zelf: een POST naar http_address.txt. Faalt
      // die, dan komt hij nooit uit MQTT_EVENT_INIT_NET_ERROR en verbindt hij
      // nooit. Op 2026-09-16 stond daar opennova.local:8080: een naam die op
      // de maaier niet oploste, en een poort die de server niet had.
      if (m.httpAddr) {
        const ok = m.httpCheck === 200;
        push({
          id: 'http_address',
          group: 'mower',
          status: ok ? 'ok' : 'fail',
          evidence: ok
            ? T`de netcheck van mqtt_node naar http://${m.httpAddr} slaagt`
            : m.httpCheck
            ? T`de netcheck van mqtt_node naar http://${m.httpAddr} geeft ${m.httpCheck}`
            : T`de netcheck van mqtt_node naar http://${m.httpAddr} krijgt geen antwoord`,
          action: ok ? undefined
            : T`zolang dit faalt verbindt mqtt_node nooit; zet in /userdata/lfi/http_address.txt het adres van deze server met de juiste poort (bv. ${md.ip ?? 'server-ip'}:${process.env.PORT ?? '80'}) en herstart met set_server_urls.sh --restart-mqtt`,
        });
      } else {
        push({
          id: 'http_address',
          group: 'mower',
          status: 'fail',
          evidence: T`/userdata/lfi/http_address.txt ontbreekt of is leeg`,
          action: T`zonder dit adres slaat de netcheck van mqtt_node nergens op; draai set_server_urls.sh --restart-mqtt`,
        });
      }

      // Het serveradres waar mqtt_node op afgaat. Een cloudnaam werkt alleen
      // zolang de DNS-omleiding staat; een IP is onafhankelijk.
      const cloudName = /lfibot\.com/i.test(m.mqttAddr ?? '');
      push({
        id: 'mower_config',
        group: 'mower',
        status: !m.hasSn ? 'fail' : cloudName ? 'warn' : 'ok',
        evidence: !m.hasSn
          ? T`json_config.json mist het serienummer`
          : T`mqtt-adres in json_config.json: ${m.mqttAddr ?? 'leeg'}`,
        action: !m.hasSn
          ? T`zonder serienummer kan mqtt_node zich niet aanmelden`
          : cloudName
          ? T`dit is het cloudadres; het werkt alleen zolang je DNS het omleidt naar je eigen server. Een IP is betrouwbaarder`
          : undefined,
      });

      // Hier valt het pas te meten: vindt het apparaat dat de server moet
      // vinden hem daadwerkelijk. De netwerkmodus van de container is hooguit
      // een verklaring achteraf, geen bewijs vooraf.
      push({
        id: 'mdns_reach',
        group: 'mower',
        status: m.mdnsResolves ? 'ok' : 'warn',
        evidence: m.mdnsResolves
          ? T`de maaier vindt de server zelf via opennova.local`
          : T`de maaier vindt opennova.local niet (server: ${netDesc})`,
        action: m.mdnsResolves ? undefined
          : probe.mdnsSidecar()
          ? T`hij leunt nu volledig op je DNS-omleiding. De opennova-mdns sidecar hoort dit te doen: kijk of die container draait (docker logs opennova-mdns) en of TARGET_IP daar het adres van deze server is`
          : net.bridged
          ? T`hij leunt nu volledig op je DNS-omleiding. Automatisch ontdekken werkt niet omdat de container multicast niet naar het thuisnetwerk krijgt; zet de opennova-mdns sidecar aan (docker-compose.yml) of draai met host-netwerk`
          : T`hij leunt nu volledig op je DNS-omleiding. Automatisch ontdekken werkt pas als de server zich op het netwerk adverteert`,
      });

      if (m.skippedConfigUpdate) {
        push({
          id: 'server_ip_file',
          group: 'mower',
          status: 'warn',
          evidence: !m.mdnsResolves
            ? m.serverIp
              ? T`set_server_urls sloeg de config-update over, opennova.local lost op de maaier niet op`
              : T`set_server_urls sloeg de config-update over, opennova.local lost op de maaier niet op en /userdata/lfi/server_ip.txt bestaat niet`
            : m.serverIp
              ? T`set_server_urls sloeg de config-update over`
              : T`set_server_urls sloeg de config-update over en /userdata/lfi/server_ip.txt bestaat niet`,
          action: T`zet het serveradres in /userdata/lfi/server_ip.txt, dan vult het script json_config.json bij de volgende boot alsnog`,
        });
      } else {
        push({
          id: 'server_ip_file',
          group: 'mower',
          status: 'ok',
          evidence: m.serverIp ? T`laatst bekende server ${m.serverIp}` : T`config-update liep door`,
        });
      }

      push({
        id: 'helpers',
        group: 'mower',
        status: m.extendedCommandsRunning ? 'ok' : 'warn',
        evidence: m.extendedCommandsRunning
          ? T`extended_commands draait`
          : T`extended_commands draait niet`,
        action: m.extendedCommandsRunning ? undefined
          : T`zonder dit script werken de OpenNova-commando's en de RTK-telemetrie niet`,
      });
    }
  }

  // Vastlopen is iets anders dan een aandachtspunt. Eerder werd de eerste
  // waarschuwing als samenvatting getoond, in het rood, onder de kop "Waarom
  // komt hij niet online?". Bij een maaier die gewoon online is las dat als de
  // oorzaak: "container met bridge-netwerk" stond bovenaan terwijl er niets
  // kapot was. Alleen een echte fout blokkeert.
  const blocking = steps.find(s => s.status === 'fail') ?? null;
  const warnings = steps.filter(s => s.status === 'warn');
  const summary = blocking
    ? blocking.evidence
    : warnings.length === 0
    ? T`geen blokkade gevonden, alles staat goed`
    : warnings.length === 1
    ? T`geen blokkade gevonden, wel 1 aandachtspunt: ${warnings.map(w => w.id).join(', ')}`
    : T`geen blokkade gevonden, wel ${warnings.length} aandachtspunten: ${warnings.map(w => w.id).join(', ')}`;

  return {
    sn,
    deviceType,
    stuckAt: blocking?.id ?? null,
    /** Alleen gevuld als er ook echt iets vastzit. */
    blocked: blocking !== null,
    warningCount: warnings.length,
    summary,
    steps,
    generatedAt: now,
  };
}
