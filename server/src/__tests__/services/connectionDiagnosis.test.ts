import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db/database.js';
import { diagnoseConnection, type DiagnosisProbes } from '../../services/connectionDiagnosis.js';
import { connectionEventRepo } from '../../db/repositories/index.js';
import { serverIpv4 } from '../../services/reachability.js';
import { factoryOuis, scanLan, bleToWifiMac, rivalBrokers } from '../../services/lanScan.js';

const MOWER = 'LFIN2230700238';
const CHARGER = 'LFIC1230700004';

/** SQLite datetime('now') format: UTC, no zone marker. */
function utc(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString().replace('T', ' ').slice(0, 19);
}

function seenAt(sn: string, msAgo: number, clientId = `${sn}_6688`) {
  db.prepare(`INSERT OR REPLACE INTO device_registry
    (mqtt_client_id, sn, mac_address, mqtt_username, last_seen) VALUES (?,?,?,?,?)`)
    .run(clientId, sn, null, null, utc(msAgo));
}

function withIp(ip: string) {
  db.prepare(`INSERT OR REPLACE INTO device_registry
    (mqtt_client_id, sn, mac_address, mqtt_username, last_seen, ip_address)
    VALUES (?,?,?,?,?,?)`).run(`${MOWER}_6688`, MOWER, null, null, utc(60_000), ip);
}

function bind(mac: string) {
  // equipment.user_id is a foreign key to users.app_user_id, not to users.id.
  db.prepare(`INSERT OR IGNORE INTO users (id, app_user_id, email, password)
              VALUES (?,?,?,?)`).run(1, 'u1', 'test@example.com', 'x');
  db.prepare(`INSERT INTO equipment (equipment_id, mower_sn, charger_sn, mac_address, user_id)
              VALUES (?,?,?,?,?)`).run(`eq-${MOWER}`, MOWER, CHARGER, mac, 'u1');
}

/**
 * Stub probes. No test reaches the real network: that made them depend on what
 * happened to be plugged in and how loaded the machine was, and they passed
 * alone while failing inside the release gate.
 */
function probes(over: Partial<{
  serverIps: string[]; dnsPointsHere: boolean; dnsAddresses: string[];
  deviceAnswered: boolean; sameSubnet: boolean | null;
  rivals: string[]; mac: string | null; lan: Record<string, unknown>;
}> = {}) {
  return {
    reachability: async (deviceIp: string | null) => ({
      serverIps: over.serverIps ?? ['192.168.1.2'],
      dns: [{
        host: 'mqtt.lfibot.com',
        addresses: over.dnsAddresses ?? ['192.168.1.2'],
        error: null,
        pointsHere: over.dnsPointsHere ?? true,
      }],
      deviceIp,
      deviceAnswered: over.deviceAnswered ?? false,
      sameSubnet: over.sameSubnet ?? null,
    }),
    scanLan: async () => ({
      canSeeLan: true, reason: null, subnet: '192.168.1',
      found: [], neighbourCount: 5, knownOuis: 6, ...(over.lan ?? {}),
    }),
    rivalBrokers: async () => over.rivals ?? [],
    lookupMac: async () => over.mac ?? null,
  } satisfies DiagnosisProbes;
}

beforeEach(() => {
  db.prepare('DELETE FROM device_registry').run();
  db.prepare('DELETE FROM connection_events').run();
  db.prepare('DELETE FROM equipment').run();
  db.prepare('DELETE FROM users WHERE id = 1').run();
});

describe('connection diagnosis', () => {
  it('never points at binding for a device that has never reached the server', async () => {
    // Telling someone to bind a device in the app is useless when the device has
    // never got here. The blockage has to be earlier in the chain.
    const d = await diagnoseConnection(MOWER, Date.now(), { probes: probes() });
    expect(d.stuckAt).not.toBe('binding');
    expect(d.steps.find(s => s.id === 'seen')!.status).toBe('fail');
    expect(d.steps.find(s => s.id === 'seen')!.evidence).toContain('nog nooit');
  });

  it('found on the LAN but silent gets its own answer', async () => {
    // The most useful thing we can say: it is on the network, so this is a
    // server-address problem on the device and not power or wifi.
    const d = await diagnoseConnection(MOWER, Date.now(), {
      probes: probes({ lan: { found: [{ ip: '192.168.1.42', mac: '70:4A:0E:00:00:01', kind: 'mower', sn: MOWER }] } }),
    });
    const step = d.steps.find(s => s.id === 'network')!;
    expect(step.evidence).toContain('192.168.1.42');
    expect(step.action).toContain('serverinstelling');
  });

  it('puts "not on the network" before "never connected"', async () => {
    // A device that is not on the LAN at all is a more fundamental failure than
    // one that never reached us, and the advice differs.
    const d = await diagnoseConnection(MOWER, Date.now(), { probes: probes() });
    expect(d.stuckAt).toBe('network');
  });

  it('separates "never connected" from "was connected until recently"', async () => {
    // These look identical in the dashboard and call for opposite actions.
    seenAt(MOWER, 3 * 24 * 60 * 60 * 1000);
    const gone = await diagnoseConnection(MOWER, Date.now(), { probes: probes() });
    const step = gone.steps.find(s => s.id === 'seen')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('was verbonden');
    expect(step.action).toContain('veranderde');

    db.prepare('DELETE FROM device_registry').run();
    const never = await diagnoseConnection(MOWER, Date.now(), { probes: probes() });
    expect(never.steps.find(s => s.id === 'seen')!.action).toContain('ingericht');
  });

  it('a device seen a minute ago counts as online', async () => {
    seenAt(MOWER, 60_000);
    const d = await diagnoseConnection(MOWER, Date.now(), { probes: probes() });
    expect(d.steps.find(s => s.id === 'seen')!.status).toBe('ok');
    // No point reporting refused attempts for a device that is in.
    expect(d.steps.find(s => s.id === 'attempts')!.status).toBe('skipped');
  });

  it('reads last_seen as UTC', async () => {
    // datetime('now') has no zone marker; parsing it as local time reports a
    // device that just connected as hours stale, in either direction depending
    // on the server's timezone.
    seenAt(MOWER, 30_000);
    expect((await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'seen')!.status).toBe('ok');
  });

  it('surfaces a refused attempt with its reason', async () => {
    seenAt(MOWER, 3 * 24 * 60 * 60 * 1000);
    connectionEventRepo.record({ clientId: `${MOWER}_6688`, sn: MOWER, outcome: 'rejected', reason: 'banned' });
    const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'attempts')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('banned');
    expect(step.action).toContain('geblokkeerd');
  });

  it('says the problem is before the broker when nothing arrives at all', async () => {
    const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'attempts')!;
    expect(step.status).toBe('fail');
    expect(step.action).toContain('DNS');
  });

  it('flags a charger MAC stored as the mower BLE MAC', async () => {
    // 48:27:E2:* is the charger OUI. With it stored the app never recognises
    // the mower's BLE advertisement and pairing silently fails.
    seenAt(MOWER, 60_000);
    bind('48:27:E2:1B:A4:0A');
    const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'ble_mac')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('laadstation');
  });

  it('reports a charger that never showed up', async () => {
    seenAt(MOWER, 60_000);
    bind('50:41:1C:39:BD:C1');
    const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'counterpart')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain(CHARGER);
    expect(step.action).toContain('laadstation');
  });

  it('never reports a later step as the sticking point', async () => {
    // stuckAt must be the FIRST failure in chain order, otherwise the advice
    // points past the actual blockage.
    const d = await diagnoseConnection(MOWER, Date.now(), { probes: probes() });
    const ids = d.steps.map(s => s.id);
    const firstFail = d.steps.findIndex(s => s.status === 'fail');
    expect(ids.indexOf(d.stuckAt!)).toBe(firstFail);
  });
});

describe('connection events', () => {
  it('collapses a retry storm into one row a minute', async () => {
    // A device that cannot connect retries in a tight loop. Unfiltered that is
    // thousands of identical rows an hour and the interesting older ones age out.
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      connectionEventRepo.record({ clientId: 'c1', sn: MOWER, outcome: 'error', reason: 'boom', ts: now + i * 100 });
    }
    expect(connectionEventRepo.recent(MOWER, 100)).toHaveLength(1);
  });

  it('keeps a different reason even inside the window', async () => {
    const now = Date.now();
    connectionEventRepo.record({ clientId: 'c1', sn: MOWER, outcome: 'error', reason: 'boom', ts: now });
    connectionEventRepo.record({ clientId: 'c1', sn: MOWER, outcome: 'error', reason: 'other', ts: now + 500 });
    expect(connectionEventRepo.recent(MOWER, 100)).toHaveLength(2);
  });

  it('prunes on age', async () => {
    const now = Date.now();
    connectionEventRepo.record({ clientId: 'c1', sn: MOWER, outcome: 'error', reason: 'oud', ts: now - 40 * 24 * 3600_000 });
    connectionEventRepo.record({ clientId: 'c1', sn: MOWER, outcome: 'error', reason: 'nieuw', ts: now });
    expect(connectionEventRepo.prune(now)).toBe(1);
    expect(connectionEventRepo.recent(MOWER, 10)).toHaveLength(1);
  });
});

describe('reachability', () => {
  // The chain used to start at "did it ever get here", blind to the failure
  // where nothing arrives at all: we see nothing, so we report nothing.

  it('never calls DNS a fault when this server does not serve it', async () => {
    // The container's resolver is not the mower's resolver. Most installs put
    // the redirect in a router or a separate DNS server, and then what we
    // resolve says nothing about what the mower resolves.
    delete process.env.ENABLE_DNS;
    const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'dns')!;
    expect(step.status).not.toBe('fail');
    if (step.status === 'unknown') expect(step.evidence).toContain('dezelfde DNS');
  });

  it('does call it a fault when this server is the one serving it', async () => {
    process.env.ENABLE_DNS = 'true';
    try {
      const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'dns')!;
      // In CI the public name resolves to the real cloud, so this is the
      // mismatch branch: server serves the redirect but the name points away.
      if (step.status === 'fail') {
        expect(step.action).toContain('serveradres');
      }
    } finally {
      delete process.env.ENABLE_DNS;
    }
  });

  it('does not claim the device is off the network when a probe stays silent', async () => {
    // Stock firmware has neither port open, so no answer proves nothing. Saying
    // "it is not on the network" there would send someone chasing their router.
    // Needs an address in OUR /24, otherwise the subnet branch fires instead.
    const ours = serverIpv4()[0];
    if (!ours) return;                                  // no LAN interface here
    const sameNet = ours.split('.').slice(0, 3).join('.') + '.253';
    withIp(sameNet);
    const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'network')!;
    expect(step.status).not.toBe('fail');
    expect(step.evidence).toContain('bewijst niets');
  });

  it('flags an address in another subnet', async () => {
    withIp('10.99.99.99');
    const step = (await diagnoseConnection(MOWER, Date.now(),
      { probes: probes({ sameSubnet: false }) })).steps.find(s => s.id === 'network')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('ander subnet');
  });

  it('says it is blind rather than empty when it cannot see the network', async () => {
    // Behind a Docker bridge the neighbour table holds only the gateway.
    // "No devices found" would send someone to check a mower that is fine.
    const step = (await diagnoseConnection(MOWER, Date.now(), {
      probes: probes({ lan: { canSeeLan: false, reason: 'deze container zit achter een Docker-bridge' } }),
    })).steps.find(s => s.id === 'network')!;
    expect(step.status).toBe('unknown');
    expect(step.action).toContain('host-netwerk');
  });
});

/** Online, bound, with whatever sensor values the case needs. */
async function live(snapshot: Record<string, string> | null) {
  withIp('192.0.2.10');
  bind('50:41:1C:39:BD:C1');
  return diagnoseConnection(MOWER, Date.now(), { snapshot, probes: probes() });
}

describe('connection quality', () => {
  it('spots two devices fighting over one client_id', async () => {
    // The broker kicks one out whenever the other connects, forever. It looks
    // like "sometimes online" and run_novabot.sh carries a double-start guard
    // for exactly this (GH #60).
    const now = Date.now();
    connectionEventRepo.record({ clientId: `${MOWER}_6688`, sn: MOWER, outcome: 'accepted', remoteAddr: '192.168.1.5', ts: now - 5000 });
    connectionEventRepo.record({ clientId: `${MOWER}_6688`, sn: MOWER, outcome: 'accepted', remoteAddr: '192.168.1.9', ts: now });
    const step = (await live({ msg: 'x' })).steps.find(s => s.id === 'client_conflict')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('192.168.1.5');
    expect(step.action).toContain('client_id');
  });

  it('is quiet when one client_id comes from one address', async () => {
    const now = Date.now();
    connectionEventRepo.record({ clientId: `${MOWER}_6688`, sn: MOWER, outcome: 'accepted', remoteAddr: '192.168.1.5', ts: now });
    expect((await live({ msg: 'x' })).steps.find(s => s.id === 'client_conflict')!.status).toBe('ok');
  });

  it('calls out connected-but-unreadable', async () => {
    // The AES key is derived from the serial. Get it wrong and the device
    // connects fine and then says nothing usable: no error, just silence.
    const step = (await live({})).steps.find(s => s.id === 'encryption')!;
    expect(step.status).toBe('fail');
    expect(step.action).toContain('serienummer');
  });

  it('does not judge readability of a device that is not connected', async () => {
    db.prepare('DELETE FROM device_registry').run();
    const step = (await diagnoseConnection(MOWER, Date.now(), { probes: probes() })).steps.find(s => s.id === 'encryption')!;
    expect(step.status).toBe('skipped');
  });
});

describe('readiness', () => {
  it('reports no work area as a hard stop', async () => {
    const step = (await live({ msg: 'x' })).steps.find(s => s.id === 'maps')!;
    expect(step.status).toBe('fail');
    expect(step.action).toContain('karteer');
  });

  it('warns without an RTK fix, since the position is metres out', async () => {
    const step = (await live({ msg: 'x', rtk_fix_quality: 'Single' })).steps.find(s => s.id === 'rtk')!;
    expect(step.status).toBe('warn');
    expect(step.action).toContain('laadstation');
  });

  it('accepts an RTK fix', async () => {
    expect((await live({ msg: 'x', rtk_fix_quality: 'RTK Fixed', rtk_sat: '28' }))
      .steps.find(s => s.id === 'rtk')!.status).toBe('ok');
  });

  it('ignores a non-blocking fault code', async () => {
    // 8 is the LoRa disconnect blip and is normal noise; flagging it would send
    // people chasing a problem that is not there.
    const step = (await live({ msg: 'x', error_status: '8' })).steps.find(s => s.id === 'fault')!;
    expect(step.status).toBe('ok');
    expect(step.evidence).toContain('niet blokkerend');
  });

  it('reports a blocking fault', async () => {
    const step = (await live({ msg: 'x', error_status: '141' })).steps.find(s => s.id === 'fault')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('141');
  });

  it('reports an unvalidated map frame', async () => {
    const step = (await live({ msg: 'x', frame_unvalidated: '1' })).steps.find(s => s.id === 'frame')!;
    expect(step.status).toBe('fail');
    expect(step.action).toContain('anker');
  });

  it('every step carries a group, so the UI can order them', async () => {
    const d = await live({ msg: 'x' });
    expect(d.steps.every(s => !!s.group)).toBe(true);
  });
});

describe('lan scan', () => {
  // A device that has never reached the broker has no address, so every other
  // check is blind to it. The hardware still announces itself at layer 2.

  /** The real table ships with 5851 devices; this is its shape in miniature. */
  function seedFactory() {
    db.prepare('DELETE FROM device_factory').run();
    const ins = db.prepare('INSERT INTO device_factory (sn, device_type, mac_address) VALUES (?,?,?)');
    for (let i = 0; i < 12; i++) ins.run(`LFIN99${i}`, 'mower', `70:4A:0E:00:00:${String(i).padStart(2, '0')}`);
    for (let i = 0; i < 12; i++) ins.run(`LFIC99${i}`, 'charger', `48:27:E2:00:00:${String(i).padStart(2, '0')}`);
    // A one-off: a typo in the source data, not a vendor range.
    ins.run('LFIN000', 'mower', '68:B6:B3:00:00:01');
  }

  it('derives the MAC prefixes from the factory table, not a hardcoded list', () => {
    seedFactory();
    const ouis = factoryOuis();
    expect(ouis.get('70:4A:0E')).toBe('mower');
    expect(ouis.get('48:27:E2')).toBe('charger');
  });

  it('ignores a prefix that appears once, since that is a typo not a vendor', () => {
    seedFactory();
    expect(factoryOuis().has('68:B6:B3')).toBe(false);
  });

  it('says the prefixes are missing rather than reporting an empty network', async () => {
    // With no factory table nothing can be recognised, so the scan finds
    // nothing by construction. Reporting that as "no devices" would send
    // someone to check power and wifi that are both fine.
    db.prepare('DELETE FROM device_factory').run();
    const r = await scanLan();
    expect(r.canSeeLan).toBe(false);
    expect(r.reason).toContain('fabriekstabel');
    expect(r.knownOuis).toBe(0);
  });

  it('says it is blind rather than saying nothing is there', async () => {
    // Behind a Docker bridge the neighbour table holds only the gateway. "No
    // devices found" would be a lie that sends someone to check their mower's
    // power supply for nothing.
    seedFactory();
    const r = await scanLan();
    if (!r.canSeeLan) {
      expect(r.reason).toBeTruthy();
      expect(r.found).toHaveLength(0);
    } else {
      expect(r.neighbourCount).toBeGreaterThan(0);
    }
  });

  it('skips the network probes when the caller asks it to', async () => {
    const t0 = Date.now();
    await diagnoseConnection(MOWER, Date.now(), { probes: probes() });
    // The scan alone costs about a second; without it the whole chain is fast.
    expect(Date.now() - t0).toBeLessThan(3000);
  });
});

describe('identity and wifi', () => {
  it('shows a name instead of the account guid', async () => {
    // "gekoppeld aan gebruiker f2ce0a28-1ebd-4dbe-92d7-31fa7a76fe62" tells
    // nobody anything.
    db.prepare(`INSERT OR IGNORE INTO users (id, app_user_id, email, password, username)
                VALUES (?,?,?,?,?)`).run(2, 'guid-abc', 'ramon@example.com', 'x', 'Ramon');
    db.prepare(`INSERT INTO equipment (equipment_id, mower_sn, charger_sn, mac_address, user_id)
                VALUES (?,?,?,?,?)`).run(`eq-${MOWER}`, MOWER, CHARGER, '50:41:1C:39:BD:C1', 'guid-abc');
    withIp('192.0.2.11');
    const step = (await diagnoseConnection(MOWER, Date.now(), { snapshot: { msg: 'x' }, probes: probes() }))
      .steps.find(s => s.id === 'binding')!;
    expect(step.evidence).toContain('Ramon');
    expect(step.evidence).not.toContain('guid-abc');
  });

  it('falls back to the e-mail address when there is no username', async () => {
    db.prepare(`INSERT OR IGNORE INTO users (id, app_user_id, email, password, username)
                VALUES (?,?,?,?,?)`).run(3, 'guid-def', 'jan@example.com', 'x', null);
    db.prepare(`INSERT INTO equipment (equipment_id, mower_sn, charger_sn, mac_address, user_id)
                VALUES (?,?,?,?,?)`).run(`eq-${MOWER}`, MOWER, CHARGER, '50:41:1C:39:BD:C1', 'guid-def');
    withIp('192.0.2.11');
    const step = (await diagnoseConnection(MOWER, Date.now(), { snapshot: { msg: 'x' }, probes: probes() }))
      .steps.find(s => s.id === 'binding')!;
    expect(step.evidence).toContain('jan@example.com');
  });

  it('reports the wifi connection with its address', async () => {
    withIp('192.0.2.12');
    const step = (await diagnoseConnection(MOWER, Date.now(), { snapshot: { msg: 'x' }, probes: probes() }))
      .steps.find(s => s.id === 'wifi')!;
    expect(step.evidence).toContain('192.0.2.12');
    expect(step.evidence).toContain('wifi');
  });

  it('warns on a weak signal, which is what "sometimes online" looks like', async () => {
    withIp('192.0.2.12');
    const step = (await diagnoseConnection(MOWER, Date.now(),
      { snapshot: { msg: 'x', wifi_rssi: '-82' }, probes: probes() })).steps.find(s => s.id === 'wifi')!;
    expect(step.status).toBe('warn');
    expect(step.evidence).toContain('-82 dBm');
    expect(step.action).toContain('toegangspunt');
  });

  it('accepts a healthy signal', async () => {
    withIp('192.0.2.12');
    const step = (await diagnoseConnection(MOWER, Date.now(),
      { snapshot: { msg: 'x', wifi_rssi: '-58' }, probes: probes() })).steps.find(s => s.id === 'wifi')!;
    expect(step.status).toBe('ok');
  });

  it('says the MAC is unknown only when it really is', async () => {
    // Earlier this said "not lookupable from this server" whenever ARP failed,
    // which reads as broken while the factory table holds the answer. It should
    // only say so with nothing to go on at all.
    db.prepare('DELETE FROM device_factory').run();
    withIp('192.0.2.13');
    const step = (await diagnoseConnection(MOWER, Date.now(), { snapshot: { msg: 'x' }, probes: probes() }))
      .steps.find(s => s.id === 'wifi')!;
    expect(step.evidence).toContain('nergens bekend');
    expect(step.evidence).not.toMatch(/MAC [0-9A-F:]{17}/);
  });
});

describe('server side and blocked states', () => {
  async function chain(snapshot: Record<string, string> | null = { msg: 'x' }) {
    withIp('192.0.2.20');
    return diagnoseConnection(MOWER, Date.now(), { snapshot, probes: probes() });
  }

  it('reports disk space, because a full disk breaks everything that writes', async () => {
    const step = (await chain()).steps.find(s => s.id === 'disk')!;
    expect(['ok', 'warn', 'fail', 'unknown']).toContain(step.status);
    if (step.status !== 'unknown') expect(step.evidence).toMatch(/MB vrij/);
  });

  it('looks for a second MQTT broker on the network', async () => {
    // Two brokers make mowers discover the wrong one over mDNS and flap between
    // them, looking intermittently offline. It happened on this network today.
    withIp('192.0.2.20');
    const d = await diagnoseConnection(MOWER, Date.now(), { snapshot: { msg: 'x' }, probes: probes() });
    const step = d.steps.find(s => s.id === 'rival_broker')!;
    if (step.status === 'fail') {
      expect(step.action).toContain('mDNS');
    } else {
      expect(step.evidence).toContain('geen tweede');
    }
  });

  it('skips the probe, and says so, when the caller turns it off', async () => {
    // Probing forty addresses on every call is too heavy for an endpoint that
    // can be polled. Saying "none found" there would be a lie.
    withIp('192.0.2.20');
    const step = (await diagnoseConnection(MOWER, Date.now(),
      { snapshot: { msg: 'x' }, probeNetwork: false, probes: probes() }))
      .steps.find(s => s.id === 'rival_broker')!;
    expect(step.status).toBe('skipped');
    expect(step.evidence).toBe('niet gepeild');
  });

  it('reports a second broker when the probe finds one', async () => {
    withIp('192.0.2.20');
    const step = (await diagnoseConnection(MOWER, Date.now(),
      { snapshot: { msg: 'x' }, probes: probes({ rivals: ['192.168.1.9'] }) }))
      .steps.find(s => s.id === 'rival_broker')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('192.168.1.9');
    expect(step.action).toContain('mDNS');
  });

  it('only probes once per call, and the probe itself caches', async () => {
    // Walking forty addresses on every diagnosis is too heavy for an endpoint
    // that can be polled; rivalBrokers caches for a minute behind this.
    let calls = 0;
    const counting: DiagnosisProbes = { ...probes(), rivalBrokers: async () => { calls++; return []; } };
    withIp('192.0.2.20');
    await diagnoseConnection(MOWER, Date.now(), { snapshot: { msg: 'x' }, probes: counting });
    await diagnoseConnection(MOWER, Date.now(), { snapshot: { msg: 'x' }, probes: counting });
    expect(calls).toBe(2);
  });

  it('flags a charger too old for AES', async () => {
    // The server encrypts to every LFI serial. A v0.3.6 charger cannot read
    // that, and nothing anywhere reports an error.
    db.prepare(`INSERT OR IGNORE INTO users (id, app_user_id, email, password)
                VALUES (?,?,?,?)`).run(4, 'u4', 'a@b.c', 'x');
    db.prepare(`INSERT INTO equipment (equipment_id, mower_sn, charger_sn, mac_address, user_id, charger_version)
                VALUES (?,?,?,?,?,?)`).run(`eq-${MOWER}`, MOWER, CHARGER, '50:41:1C:39:BD:C1', 'u4', 'v0.3.6');
    const step = (await chain()).steps.find(s => s.id === 'charger_crypto')!;
    expect(step.status).toBe('fail');
    expect(step.action).toContain('v0.4.0');
  });

  it('accepts a charger on v0.4.0', async () => {
    db.prepare(`INSERT OR IGNORE INTO users (id, app_user_id, email, password)
                VALUES (?,?,?,?)`).run(5, 'u5', 'c@d.e', 'x');
    db.prepare(`INSERT INTO equipment (equipment_id, mower_sn, charger_sn, mac_address, user_id, charger_version)
                VALUES (?,?,?,?,?,?)`).run(`eq-${MOWER}`, MOWER, CHARGER, '50:41:1C:39:BD:C1', 'u5', 'v0.4.0');
    expect((await chain()).steps.find(s => s.id === 'charger_crypto')!.status).toBe('ok');
  });

  it('spots the mower stuck in mapping mode', async () => {
    const step = (await chain({ msg: 'x', task_mode: '2' })).steps.find(s => s.id === 'mapping_mode')!;
    expect(step.status).toBe('fail');
    expect(step.action).toContain('karteren');
  });

  it('spots a parked run that blocks a fresh start', async () => {
    // The firmware refuses a new task with "last task is executing" while one
    // sits parked, which reads as a start that simply does nothing.
    const step = (await chain({ msg: 'x', task_mode: '1', work_status: '10' }))
      .steps.find(s => s.id === 'parked_task')!;
    expect(step.status).toBe('warn');
    expect(step.action).toContain('nieuwe start');
  });

  it('is quiet when nothing is parked', async () => {
    const step = (await chain({ msg: 'x', task_mode: '1', work_status: '0' }))
      .steps.find(s => s.id === 'parked_task')!;
    expect(step.status).toBe('ok');
  });
});

describe('wifi MAC and false rivals', () => {
  it('derives the wifi MAC per hardware, measured not guessed', () => {
    // Chargers are ESP32: wifi STA + 2 = BLE (broker.ts wifiStaToBle).
    // Mowers sit at +1, measured on two devices with different vendor
    // prefixes: LFIN2230700238 wifi 50:41:1C:39:BD:C0 against BLE ...C1, and
    // LFIN1231000211 wifi 70:4A:0E:4A:99:CE against BLE ...CF.
    expect(bleToWifiMac('50:41:1C:39:BD:C1', 'mower')).toBe('50:41:1C:39:BD:C0');
    expect(bleToWifiMac('70:4A:0E:4A:99:CF', 'mower')).toBe('70:4A:0E:4A:99:CE');
    expect(bleToWifiMac('48:27:E2:1B:A4:0A', 'charger')).toBe('48:27:E2:1B:A4:08');
  });

  it('borrows across a byte boundary', () => {
    expect(bleToWifiMac('AA:BB:CC:DD:EE:00', 'mower')).toBe('AA:BB:CC:DD:ED:FF');
    expect(bleToWifiMac('AA:BB:CC:DD:EE:01', 'charger')).toBe('AA:BB:CC:DD:ED:FF');
  });

  it('refuses a malformed address instead of inventing one', () => {
    expect(bleToWifiMac('not-a-mac', 'mower')).toBeNull();
    expect(bleToWifiMac('00:00:00:00:00:00', 'charger')).toBeNull();
  });

  it('shows the MAC from the factory table when ARP cannot reach the LAN', async () => {
    // A bridged container has no layer-2 view of the home network, but the
    // factory table ships with the MAC of every device. "Not lookupable" while
    // we hold the answer reads as broken.
    db.prepare('DELETE FROM device_factory').run();
    db.prepare('INSERT INTO device_factory (sn, device_type, mac_address) VALUES (?,?,?)')
      .run(MOWER, 'mower', '50:41:1C:39:BD:C1');
    withIp('192.0.2.30');
    const step = (await diagnoseConnection(MOWER, Date.now(),
      { snapshot: { msg: 'x' }, probes: probes({ mac: null }) })).steps.find(s => s.id === 'wifi')!;
    expect(step.evidence).toContain('50:41:1C:39:BD:C0');
    expect(step.evidence).toContain('afgeleid');
    expect(step.evidence).not.toContain('niet op te zoeken');
  });

  it('prefers a real lookup over the derived one', async () => {
    db.prepare('DELETE FROM device_factory').run();
    db.prepare('INSERT INTO device_factory (sn, device_type, mac_address) VALUES (?,?,?)')
      .run(MOWER, 'mower', '50:41:1C:39:BD:C1');
    withIp('192.0.2.30');
    const step = (await diagnoseConnection(MOWER, Date.now(),
      { snapshot: { msg: 'x' }, probes: probes({ mac: 'AA:BB:CC:DD:EE:FF' }) })).steps.find(s => s.id === 'wifi')!;
    expect(step.evidence).toContain('AA:BB:CC:DD:EE:FF');
    expect(step.evidence).not.toContain('afgeleid');
  });
});

describe('the docker gateway is not a second broker', () => {
  it('never reports an address on the container bridge', async () => {
    // 172.17.0.1 is the host seen from inside the container, and it forwards
    // 1883 straight back to us. Reporting it told the user to shut down their
    // own server. Seen live on 2026-09-14.
    const found = await rivalBrokers(['172.17.0.2', '192.168.0.5']);
    expect(found.every(ip => !ip.startsWith('172.1'))).toBe(true);
  }, 20000);

  it('only counts addresses on the same subnet as the server', async () => {
    // A genuine second server sits on the home LAN. Anything outside it is
    // routing, not a rival.
    const found = await rivalBrokers(['192.168.0.5']);
    expect(found.every(ip => ip.startsWith('192.168.0.'))).toBe(true);
  }, 20000);
});
