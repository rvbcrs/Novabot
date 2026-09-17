/**
 * The mDNS sidecar: advertise opennova.local on the host network, and nothing
 * else.
 *
 * A container on docker's bridge cannot be found by mDNS. The mower asks
 * 224.0.0.251:5353, a multicast address, and Linux does not carry multicast
 * from the LAN onto docker0; the "5353:5353/udp" port mapping is a DNAT rule
 * on the host address and never sees those packets. Host networking fixes it
 * but also needs 80 and 443 free on the host, which on a NAS they rarely are.
 *
 * So this runs as a second, tiny service in the same compose, with
 * network_mode: host, from the same image. It claims only 5353/udp, and
 * shares that with avahi if the host runs one, as mDNS responders always do
 * (SO_REUSEADDR plus the multicast group). The main container keeps its
 * bridge and its port mappings; the mower learns the host address from here
 * and reaches the broker through the mapped 1883.
 *
 * Its own entry point on purpose: importing index.ts would open the database
 * and bind every port before we could decline.
 */
import { startMdnsAdvertiser, mdnsStatus } from './services/mdnsAdvertiser.js';

const TAG = '[MDNS-ONLY]';

if (!process.env.TARGET_IP) {
  // Inside a host-network container the LAN address is detectable, but the
  // sidecar exists to advertise the address the MAIN container is reached on,
  // and that is only ever known from outside. Be loud about it.
  console.warn(`${TAG} TARGET_IP is not set; falling back to the first LAN address of this host`);
}

startMdnsAdvertiser();
const st = mdnsStatus();
if (!st.running) {
  console.error(`${TAG} advertiser did not start: ${st.notStartedReason ?? st.lastError ?? 'unknown'}`);
  process.exit(1);
}
console.log(`${TAG} advertising ${st.hostname} -> ${st.ip} on ${st.port}/udp (host network)`);

const stop = (sig: string) => {
  console.log(`${TAG} ${sig}, stopping`);
  process.exit(0);
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
