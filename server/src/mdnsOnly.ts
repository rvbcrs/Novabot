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
 * Nothing to configure: on a host network the LAN address is right there in
 * the interface list, which is the one thing the bridged main container can
 * never see. TARGET_IP still wins when set.
 *
 * Its own entry point on purpose: importing index.ts would open the database
 * and bind every port before we could decline.
 */
import { startMdnsAdvertiser, mdnsStatus, detectLanIp, isDockerDesktopVm } from './services/mdnsAdvertiser.js';

const TAG = '[MDNS-ONLY]';

if (isDockerDesktopVm()) {
  // Docker Desktop (macOS, Windows): "host network" is the VM's own, the LAN
  // never hears it. Say so once and stop; compose has restart: on-failure,
  // so a clean exit stays stopped instead of looping.
  console.log(`${TAG} Docker Desktop detected (${detectLanIp() ?? 'no address'} is the VM, not your LAN); mDNS cannot reach the LAN from a container here, nothing to do`);
  process.exit(0);
}

startMdnsAdvertiser();
const st = mdnsStatus();
if (!st.running) {
  console.error(`${TAG} advertiser did not start: ${st.notStartedReason ?? st.lastError ?? 'unknown'}`);
  process.exit(1);
}
console.log(`${TAG} advertising ${st.hostname} -> ${st.ip} on ${st.port}/udp (host network${process.env.TARGET_IP ? ', TARGET_IP' : ', detected'})`);

const stop = (sig: string) => { console.log(`${TAG} ${sig}, stopping`); process.exit(0); };
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
