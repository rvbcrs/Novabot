/**
 * Read the mower's own state over SSH.
 *
 * Everything above this looks at the mower from the outside. That was not
 * enough for the case on 2026-09-14: the mower was online, publishing RTK
 * telemetry, and completely absent from the map. From the outside it looked
 * fine. From the inside mqtt_node had been stuck for seventeen hours in a
 * connect-retry loop while, at that same moment, a connection from that very
 * mower to the broker succeeded in 0.05 s.
 *
 * Tried on every mower with an address. SSH is something our build enables,
 * so a login that WORKS proves custom firmware, whatever the server has on
 * record: on 2026-09-16 LFIN1231000009 ran custom-38 while the database still
 * said v5.7.1, because mqtt_node had never connected to report otherwise.
 * Gating the probe on the recorded version hid exactly the case it was for.
 *
 * One SSH round trip collecting key=value lines, because a diagnosis that takes
 * ten round trips is a diagnosis nobody waits for.
 */
import { execFile } from 'child_process';

const SSH_TIMEOUT_MS = 12_000;
const SSH_USER = 'root';
/** The password the custom firmware build sets. Overridable for other builds. */
const SSH_PASSWORD = process.env.MOWER_SSH_PASSWORD ?? 'novabot';

export interface MowerProbe {
  reachable: boolean;
  /** Why not, when reachable is false. */
  error: string | null;
  /** mqtt addr from json_config.json: an IP, a cloud hostname, or absent. */
  mqttAddr: string | null;
  /** Does json_config.json carry a serial at all. mqtt_node needs it. */
  hasSn: boolean;
  /** /userdata/lfi/server_ip.txt, the fallback set_server_urls falls back to. */
  serverIp: string | null;
  /** Does opennova.local resolve on the mower. */
  mdnsResolves: boolean;
  /** Is the mqtt_node process alive. */
  mqttNodeRunning: boolean;
  /** Seconds since mqtt_node started, null when not running. */
  mqttNodeUptimeS: number | null;
  /** Does mqtt_node hold a socket to a broker on 1883. */
  mqttNodeConnected: boolean;
  /** Count of MQTT_EVENT_INIT_NET_ERROR lines in the tail of its log. */
  mqttNetErrors: number;
  /** set_server_urls skipped the json_config update for want of a server IP. */
  skippedConfigUpdate: boolean;
  /** Our own helpers, which can be fine while the firmware stack is not. */
  extendedCommandsRunning: boolean;
  /** novabot_version_code from the firmware's own params file, the truth on disk. */
  version: string | null;
  /** host:port from http_address.txt, where mqtt_node posts its net check. */
  httpAddr: string | null;
  /** HTTP status of that net check done from the mower, 0 = no answer, null = not tried. */
  httpCheck: number | null;
}

/**
 * One shell script, one round trip. Everything it cannot determine prints an
 * empty value rather than failing, so a missing file never costs us the rest.
 */
const SCRIPT = `
cfg=/userdata/lfi/json_config.json
addr=$(python3 -c "import json;print(json.load(open('$cfg')).get('mqtt',{}).get('value',{}).get('addr',''))" 2>/dev/null)
sn=$(python3 -c "import json;print(json.load(open('$cfg')).get('sn',{}).get('value',{}).get('code',''))" 2>/dev/null)
echo "mqtt_addr=$addr"
echo "has_sn=$([ -n "$sn" ] && echo 1 || echo 0)"
echo "server_ip=$(cat /userdata/lfi/server_ip.txt 2>/dev/null)"
echo "mdns=$(getent hosts opennova.local 2>/dev/null | head -1 | awk '{print $1}')"
pid=$(ps aux 2>/dev/null | grep "[m]qtt_node" | awk '{print $2}' | head -1)
echo "mqtt_pid=$pid"
if [ -n "$pid" ]; then
  echo "mqtt_uptime=$(awk -v t=$(awk '{print int($1)}' /proc/uptime) 'NR==1{print t-int($22/100)}' /proc/$pid/stat 2>/dev/null)"
  echo "mqtt_conn=$(netstat -tn 2>/dev/null | grep -c ':1883 .*ESTABLISHED')"
  log=$(readlink /proc/$pid/fd/* 2>/dev/null | grep -i mqtt_node | head -1)
  echo "mqtt_errs=$(tail -40 "$log" 2>/dev/null | grep -c MQTT_EVENT_INIT_NET_ERROR)"
fi
echo "skipped_cfg=$(tail -40 /userdata/ota/custom_firmware.log 2>/dev/null | grep -c 'SKIP json_config.json update')"
echo "ext_cmd=$(ps aux 2>/dev/null | grep -c "[e]xtended_commands.py")"
echo "version=$(sed -n 's/^ *novabot_version_code: *//p' /root/novabot/install/novabot_api/share/novabot_api/config/novabot_api.yaml 2>/dev/null | head -1)"
haddr=$(cat /userdata/lfi/http_address.txt 2>/dev/null | tr -d '[:space:]')
echo "http_addr=$haddr"
if [ -n "$haddr" ]; then
  echo "http_check=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "http://$haddr/api/nova-network/network/connection" 2>/dev/null)"
fi
`;

function run(ip: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'sshpass',
      ['-p', SSH_PASSWORD, 'ssh',
        '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=6', '-o', 'BatchMode=no',
        `${SSH_USER}@${ip}`, SCRIPT],
      { timeout: SSH_TIMEOUT_MS },
      (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)),
    );
  });
}

function parse(out: string): Record<string, string> {
  const kv: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return kv;
}

export async function probeMower(ip: string | null): Promise<MowerProbe> {
  const empty: MowerProbe = {
    reachable: false, error: null, mqttAddr: null, hasSn: false, serverIp: null,
    mdnsResolves: false, mqttNodeRunning: false, mqttNodeUptimeS: null,
    mqttNodeConnected: false, mqttNetErrors: 0, skippedConfigUpdate: false,
    extendedCommandsRunning: false, version: null, httpAddr: null, httpCheck: null,
  };
  if (!ip) return { ...empty, error: 'geen adres bekend' };

  let out: string;
  try {
    out = await run(ip);
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }

  const kv = parse(out);
  const uptime = parseInt(kv.mqtt_uptime ?? '', 10);
  return {
    reachable: true,
    error: null,
    mqttAddr: kv.mqtt_addr || null,
    hasSn: kv.has_sn === '1',
    serverIp: kv.server_ip || null,
    mdnsResolves: !!kv.mdns,
    mqttNodeRunning: !!kv.mqtt_pid,
    mqttNodeUptimeS: Number.isFinite(uptime) ? uptime : null,
    mqttNodeConnected: (parseInt(kv.mqtt_conn ?? '0', 10) || 0) > 0,
    mqttNetErrors: parseInt(kv.mqtt_errs ?? '0', 10) || 0,
    skippedConfigUpdate: (parseInt(kv.skipped_cfg ?? '0', 10) || 0) > 0,
    extendedCommandsRunning: (parseInt(kv.ext_cmd ?? '0', 10) || 0) > 0,
    version: kv.version || null,
    httpAddr: kv.http_addr || null,
    httpCheck: kv.http_check === undefined ? null : (parseInt(kv.http_check, 10) || 0),
  };
}
