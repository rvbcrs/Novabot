/**
 * Who is listening for commands to a device: the MQTT clients subscribed to
 * `Dart/Send_mqtt/<SN>`. On a mower that is mqtt_node, and it is not always
 * there: the stock network check drops it into a restart for 20-30 s at a
 * time (live .244, 2026-09-26: five restarts in one night). A command
 * published in such a gap is gone, and the caller waits for an answer that
 * cannot come. awaitCommand uses this to hold a command until someone
 * listens, and to send it again once if the listener dropped mid-wait.
 *
 * Its own module with no imports, so broker and mapSync can both use it
 * without one mocking the other away in tests.
 */
import { EventEmitter } from 'node:events';

const listeners = new Map<string, Set<string>>();
export const commandChannelEvents = new EventEmitter();
commandChannelEvents.setMaxListeners(0);

const topicSn = (topic: string): string | null => {
  const m = /^Dart\/Send_mqtt\/(LFI[^/]+)$/.exec(topic);
  return m ? m[1] : null;
};

/** A client subscribed: note it when the topic is a device's command topic. */
export function noteSubscribe(clientId: string, topic: string): void {
  const sn = topicSn(topic);
  if (!sn) return;
  const set = listeners.get(sn) ?? new Set<string>();
  const wasEmpty = set.size === 0;
  set.add(clientId);
  listeners.set(sn, set);
  if (wasEmpty) commandChannelEvents.emit('up', sn);
}

/** A client went away: every device it listened for may now be deaf. */
export function noteDisconnect(clientId: string): void {
  for (const [sn, set] of listeners) {
    if (set.delete(clientId) && set.size === 0) commandChannelEvents.emit('down', sn);
  }
}

/**
 * Whether a command published now reaches the device. Unknown (never seen a
 * subscription for it, e.g. right after a server start) counts as yes, so
 * this only ever holds a command back when it knows the listener is gone.
 */
export function isListening(sn: string): boolean {
  const set = listeners.get(sn);
  return set === undefined || set.size > 0;
}

/** Tests only. */
export function resetCommandChannel(): void {
  listeners.clear();
  commandChannelEvents.removeAllListeners();
}
