/**
 * Connection events — every MQTT connect attempt, accepted or refused.
 *
 * device_registry only ever holds the successes: a row appears once a device is
 * in. So "it does not come online", the single most common complaint, left no
 * trace at all. The refusal went to the console and the MQTT log is a 500-entry
 * in-memory ring that is gone after a restart, so by the time someone asks for
 * help the evidence has evaporated.
 *
 * Deliberately small: who, when, and why refused. No payloads.
 */
import { db } from '../database.js';

export type ConnectionOutcome = 'accepted' | 'rejected' | 'error' | 'disconnect';

export interface ConnectionEventRow {
  id: number;
  ts: number;
  mqtt_client_id: string;
  sn: string | null;
  outcome: ConnectionOutcome;
  reason: string | null;
  remote_addr: string | null;
}

/** Keep a month. Long enough to answer "it stopped working last week". */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A device that cannot connect retries in a tight loop, so an unfiltered log
 * would be thousands of identical rows an hour and the interesting older ones
 * would age out of any cap. One row per (client, address, outcome, reason) per
 * minute is enough to reconstruct what happened.
 */
export const DEDUP_WINDOW_MS = 60_000;

export const connectionEventRepo = {
  record(e: {
    clientId: string;
    sn?: string | null;
    outcome: ConnectionOutcome;
    reason?: string | null;
    remoteAddr?: string | null;
    ts?: number;
  }): void {
    const ts = e.ts ?? Date.now();
    // remote_addr hoort in de sleutel: hetzelfde client_id vanaf TWEE adressen
    // is precies het signaal dat twee apparaten elkaar er om beurten uitgooien,
    // en zonder het adres in de vergelijking vouwt de dedup dat weg.
    const recent = db.prepare(`
      SELECT id FROM connection_events
      WHERE mqtt_client_id = ? AND outcome = ? AND IFNULL(reason,'') = IFNULL(?,'')
        AND IFNULL(remote_addr,'') = IFNULL(?,'') AND ts > ?
      LIMIT 1
    `).get(e.clientId, e.outcome, e.reason ?? null, e.remoteAddr ?? null, ts - DEDUP_WINDOW_MS);
    if (recent) return;

    db.prepare(`
      INSERT INTO connection_events (ts, mqtt_client_id, sn, outcome, reason, remote_addr)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(ts, e.clientId, e.sn ?? null, e.outcome, e.reason ?? null, e.remoteAddr ?? null);
  },

  /** Newest first. `sn` null matches on the client id instead. */
  recent(sn: string | null, limit = 50): ConnectionEventRow[] {
    if (sn) {
      return db.prepare(`
        SELECT * FROM connection_events
        WHERE sn = ? OR mqtt_client_id LIKE ?
        ORDER BY ts DESC LIMIT ?
      `).all(sn, `%${sn}%`, limit) as ConnectionEventRow[];
    }
    return db.prepare('SELECT * FROM connection_events ORDER BY ts DESC LIMIT ?')
      .all(limit) as ConnectionEventRow[];
  },

  /** Most recent event of a given outcome, or null. */
  lastOf(sn: string, outcome: ConnectionOutcome): ConnectionEventRow | null {
    return (db.prepare(`
      SELECT * FROM connection_events
      WHERE (sn = ? OR mqtt_client_id LIKE ?) AND outcome = ?
      ORDER BY ts DESC LIMIT 1
    `).get(sn, `%${sn}%`, outcome) ?? null) as ConnectionEventRow | null;
  },

  prune(now = Date.now()): number {
    return db.prepare('DELETE FROM connection_events WHERE ts < ?')
      .run(now - RETENTION_MS).changes;
  },
};
