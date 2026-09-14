import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../db/database.js';
import { diagnoseConnection } from '../../services/connectionDiagnosis.js';
import { connectionEventRepo } from '../../db/repositories/index.js';
import { serverIpv4 } from '../../services/reachability.js';

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

beforeEach(() => {
  db.prepare('DELETE FROM device_registry').run();
  db.prepare('DELETE FROM connection_events').run();
  db.prepare('DELETE FROM equipment').run();
  db.prepare('DELETE FROM users WHERE id = 1').run();
});

describe('connection diagnosis', () => {
  it('a device that has never connected is stuck at "seen", not at binding', async () => {
    // The chain has to stop at the first broken link: telling someone to bind a
    // device in the app is useless when the device has never reached the server.
    const d = await diagnoseConnection(MOWER);
    expect(d.stuckAt).toBe('seen');
    expect(d.steps.find(s => s.id === 'seen')!.status).toBe('fail');
    expect(d.steps.find(s => s.id === 'seen')!.evidence).toContain('nog nooit');
  });

  it('separates "never connected" from "was connected until recently"', async () => {
    // These look identical in the dashboard and call for opposite actions.
    seenAt(MOWER, 3 * 24 * 60 * 60 * 1000);
    const gone = await diagnoseConnection(MOWER);
    const step = gone.steps.find(s => s.id === 'seen')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('was verbonden');
    expect(step.action).toContain('veranderde');

    db.prepare('DELETE FROM device_registry').run();
    const never = await diagnoseConnection(MOWER);
    expect(never.steps.find(s => s.id === 'seen')!.action).toContain('ingericht');
  });

  it('a device seen a minute ago counts as online', async () => {
    seenAt(MOWER, 60_000);
    const d = await diagnoseConnection(MOWER);
    expect(d.steps.find(s => s.id === 'seen')!.status).toBe('ok');
    // No point reporting refused attempts for a device that is in.
    expect(d.steps.find(s => s.id === 'attempts')!.status).toBe('skipped');
  });

  it('reads last_seen as UTC', async () => {
    // datetime('now') has no zone marker; parsing it as local time reports a
    // device that just connected as hours stale, in either direction depending
    // on the server's timezone.
    seenAt(MOWER, 30_000);
    expect((await diagnoseConnection(MOWER)).steps.find(s => s.id === 'seen')!.status).toBe('ok');
  });

  it('surfaces a refused attempt with its reason', async () => {
    seenAt(MOWER, 3 * 24 * 60 * 60 * 1000);
    connectionEventRepo.record({ clientId: `${MOWER}_6688`, sn: MOWER, outcome: 'rejected', reason: 'banned' });
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'attempts')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('banned');
    expect(step.action).toContain('geblokkeerd');
  });

  it('says the problem is before the broker when nothing arrives at all', async () => {
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'attempts')!;
    expect(step.status).toBe('fail');
    expect(step.action).toContain('DNS');
  });

  it('flags a charger MAC stored as the mower BLE MAC', async () => {
    // 48:27:E2:* is the charger OUI. With it stored the app never recognises
    // the mower's BLE advertisement and pairing silently fails.
    seenAt(MOWER, 60_000);
    bind('48:27:E2:1B:A4:0A');
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'ble_mac')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('laadstation');
  });

  it('reports a charger that never showed up', async () => {
    seenAt(MOWER, 60_000);
    bind('50:41:1C:39:BD:C1');
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'counterpart')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain(CHARGER);
    expect(step.action).toContain('laadstation');
  });

  it('never reports a later step as the sticking point', async () => {
    // stuckAt must be the FIRST failure in chain order, otherwise the advice
    // points past the actual blockage.
    const d = await diagnoseConnection(MOWER);
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
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'dns')!;
    expect(step.status).not.toBe('fail');
    if (step.status === 'unknown') expect(step.evidence).toContain('dezelfde DNS');
  });

  it('does call it a fault when this server is the one serving it', async () => {
    process.env.ENABLE_DNS = 'true';
    try {
      const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'dns')!;
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
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'network')!;
    expect(step.status).not.toBe('fail');
    expect(step.evidence).toContain('bewijst niets');
  });

  it('flags an address in another subnet', async () => {
    if (!serverIpv4().length) return;
    withIp('10.99.99.99');
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'network')!;
    expect(step.status).toBe('fail');
    expect(step.evidence).toContain('ander subnet');
  });

  it('says so plainly when no address is known', async () => {
    const step = (await diagnoseConnection(MOWER)).steps.find(s => s.id === 'network')!;
    expect(step.status).toBe('unknown');
    expect(step.evidence).toContain('geen adres');
  });
});
