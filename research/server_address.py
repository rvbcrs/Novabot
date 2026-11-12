#!/usr/bin/env python3
"""Which OpenNova server this mower uses, and the one writer of every address
that points at it (GH #170).

Three files hold the server, and they used to be written by three different
rules (set_server_urls.sh at boot, opennova_discovery.py every 60 s, and
broker_resolver.py on every reconnect). They drifted apart: on LFIN2231000451
the broker was the local server while http_address.txt still said the cloud
(47.253.145.99:80), so sync_map fetched the ZIP from the cloud and failed.

Now one rule finds the server and one function writes all of them, always to
the same IP:
  json_config.json   mqtt.value.addr   mqtt_node's broker; the helpers read it too
  http_address.txt   <ip>:<http port>  mqtt_node HTTP, sync_map, terrain_scan
  server_ip.txt      <ip>              the last server found, tried when the
                                       names give nothing
  sensor.json        mqttServer        autosys_monitor's broker; stock it is
                                       the LFI cloud (47.253.57.111), read at
                                       its start

Candidates, in this order: the mDNS names the server advertises
(opennova.local, then the legacy opennovabot.local), the DNS redirect of the
stock cloud names (mqtt.lfibot.com, app.lfibot.com), then server_ip.txt. A
candidate only counts when its MQTT port accepts a connect AND one of its HTTP
ports answers /api/setup/health as OpenNova: the public cloud, a reverse proxy
without a broker, or the ESP32 setup AP never do. A public address is never
a candidate and never written, not even as a fallback: that is the LFI cloud.
When nothing counts, nothing is written: the files keep the last server that
did.

The address is always the IP, never the hostname: mDNS only reaches the mower
on the same subnet and when the server advertises at all (not from a Docker
bridge), an IP also works through a router or VPN, and the mower must stay
connected.

Stdlib only. build_custom_firmware.sh copies it next to the helpers in
/root/novabot/scripts/. `python3 server_address.py --once` finds and writes
once (set_server_urls.sh at boot and after sync_map); opennova_discovery.py
imports it and checks every 60 s.
"""
import ipaddress
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.request
from pathlib import Path

JSON_PATH = Path('/userdata/lfi/json_config.json')
HTTP_ADDR_PATH = Path('/userdata/lfi/http_address.txt')
SERVER_IP_PATH = Path('/userdata/lfi/server_ip.txt')
PORT_OVERRIDE_PATH = Path('/userdata/lfi/server_port_override.txt')
# Stock config of autosys_monitor (the system-health watchdog): its own broker,
# hardcoded to the LFI cloud (tcp://47.253.57.111:1883). Read at its start.
SENSOR_JSON_PATH = Path('/root/novabot/install/config/sensor.json')
SENSOR_SERVER_RE = re.compile(r'("mqttServer"\s*:\s*")([^"]*)(")')
MDNS_NAMES = ('opennova.local', 'opennovabot.local')
DNS_NAMES = ('mqtt.lfibot.com', 'app.lfibot.com')
HTTP_PORTS = (80, 8080, 443)
DEFAULT_MQTT_PORT = 1883
CONNECT_TIMEOUT_S = 2.0


def lookup(name):
    """IPv4 address of `name` via the libc resolver (files, mdns4_minimal, dns), or None."""
    try:
        ip = socket.gethostbyname(name)
    except (OSError, UnicodeError):
        return None
    return None if ip.startswith('127.') else ip


def is_local(ip):
    """True for a LAN/VPN address (private, link-local, CGNAT/Tailscale).

    A public address is never written anywhere: that is the LFI cloud
    (app.lfibot.com 47.253.145.99, mqtt.lfibot.com 47.253.162.193), which is
    what a stock name resolves to without a DNS redirect.
    """
    try:
        return not ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def accepts_connect(ip, port, timeout=CONNECT_TIMEOUT_S):
    try:
        socket.create_connection((ip, port), timeout).close()
        return True
    except (OSError, ValueError):
        return False


def answers_as_opennova(ip, port):
    """True when http://ip:port/api/setup/health answers as OpenNova.

    A NAS web UI, a reverse proxy or the public lfibot.com does not name a
    server and a broker in a small JSON body.
    """
    try:
        with urllib.request.urlopen('http://%s:%d/api/setup/health' % (ip, port), timeout=3) as r:
            body = r.read(2000).decode('utf-8', 'ignore')
        return '"server"' in body and '"mqtt"' in body
    except Exception:
        return False


def srv_port(timeout=4):
    """HTTP port from the server's mDNS SRV record _opennova-http._tcp.local, or None.

    Only a record whose target is one of our names counts: other responders on
    a LAN (CasaOS apps, neighbouring containers) claim the same service with
    their own ports (wrong ports 6466 and 8009 live, 2026-05-13).
    """
    def name_at(data, offset, depth=0):
        labels = []
        while offset < len(data) and depth < 16:
            length = data[offset]
            if length == 0:
                return '.'.join(labels), offset + 1
            if length & 0xc0 == 0xc0:
                tail, _ = name_at(data, ((length & 0x3f) << 8) | data[offset + 1], depth + 1)
                return '.'.join(labels + [tail]), offset + 2
            labels.append(data[offset + 1:offset + 1 + length].decode(errors='ignore'))
            offset += 1 + length
        return '.'.join(labels), offset

    def wlan0_ip():
        try:
            import fcntl
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as q:
                return socket.inet_ntoa(fcntl.ioctl(q.fileno(), 0x8915, struct.pack('256s', b'wlan0'))[20:24])
        except Exception:
            return None

    query = struct.pack('!6H', 0, 0, 1, 0, 0, 0) + b'\x0e_opennova-http\x04_tcp\x05local\x00' + struct.pack('!2H', 33, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.settimeout(1)
        s.bind(('', 5353))
        # Pinned to wlan0: without a multicast route (LFIN2231000633) the join
        # raises ENODEV and sendto ENETUNREACH on INADDR_ANY.
        iface = wlan0_ip()
        if iface:
            s.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_IF, socket.inet_aton(iface))
            mreq = struct.pack('4s4s', socket.inet_aton('224.0.0.251'), socket.inet_aton(iface))
        else:
            mreq = struct.pack('4sL', socket.inet_aton('224.0.0.251'), socket.INADDR_ANY)
        s.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
        end = time.time() + timeout
        while time.time() < end:
            s.sendto(query, ('224.0.0.251', 5353))
            try:
                data, _ = s.recvfrom(4096)
            except socket.timeout:
                continue
            if len(data) < 12 or not struct.unpack('!H', data[2:4])[0] & 0x8000:
                continue
            offset = 12
            for _ in range(struct.unpack('!H', data[4:6])[0]):
                offset = name_at(data, offset)[1] + 4
            for _ in range(struct.unpack('!H', data[6:8])[0]):
                offset = name_at(data, offset)[1]
                if offset + 10 > len(data):
                    break
                rtype, rdlen = struct.unpack('!H', data[offset:offset + 2])[0], struct.unpack('!H', data[offset + 8:offset + 10])[0]
                if rtype == 33 and offset + 16 <= len(data):
                    target = name_at(data, offset + 16)[0].lower()
                    if any(target == t or target.endswith('.' + t) for t in MDNS_NAMES):
                        return struct.unpack('!H', data[offset + 14:offset + 16])[0]
                offset += 10 + rdlen
    except OSError:
        return None
    finally:
        s.close()
    return None


def _read(path):
    try:
        return path.read_text().strip()
    except OSError:
        return ''


def read_state():
    """The addresses the mower holds now."""
    addr, port = None, DEFAULT_MQTT_PORT
    try:
        value = (json.loads(JSON_PATH.read_text()).get('mqtt') or {}).get('value') or {}
        addr = value.get('addr') or None
        port = int(value.get('port') or DEFAULT_MQTT_PORT)
    except Exception:
        pass
    http = _read(HTTP_ADDR_PATH)
    for prefix in ('http://', 'https://'):
        if http.startswith(prefix):
            http = http[len(prefix):]
    sensor = SENSOR_SERVER_RE.search(_read(SENSOR_JSON_PATH))
    return {'mqtt_addr': addr, 'mqtt_port': port, 'http': http.rstrip('/'),
            'server_ip': _read(SERVER_IP_PATH) or None,
            # None when the file is absent: nothing to point anywhere.
            'sensor': sensor.group(2) if sensor else None}


def http_ports(ip, state, srv=srv_port):
    """HTTP ports to ask, cheapest first; the SRV query (4 s) only when the usual ones fail."""
    ports = []
    override = _read(PORT_OVERRIDE_PATH)
    if override.isdigit() and 0 < int(override) < 65536:
        ports.append(int(override))
    host, _, port = state['http'].rpartition(':')
    if host == ip and port.isdigit():
        ports.append(int(port))
    ports.extend(HTTP_PORTS)
    seen = []
    for p in ports:
        if p not in seen:
            seen.append(p)
            yield p
    p = srv()
    if p and p not in seen:
        yield p


def find_server(state, lookup=lookup, reachable=accepts_connect, opennova=answers_as_opennova, srv=srv_port):
    """(ip, http_port) of the OpenNova server to use, or None when none answers."""
    candidates = []
    for ip in [lookup(n) for n in MDNS_NAMES + DNS_NAMES] + [state['server_ip']]:
        if ip and is_local(ip) and ip not in candidates:
            candidates.append(ip)
    for ip in candidates:
        if not reachable(ip, state['mqtt_port']):
            continue
        for port in http_ports(ip, state, srv):
            if opennova(ip, port):
                return ip, port
    return None


def differences(ip, http_port, state):
    """Which of the three addresses do not point at (ip, http_port)."""
    want = {'mqtt_addr': ip, 'http': '%s:%d' % (ip, http_port), 'server_ip': ip}
    if state.get('sensor') is not None:
        want['sensor'] = 'tcp://%s:%d' % (ip, state['mqtt_port'])
    return [k for k, v in want.items() if state.get(k) != v]


def _atomic_write(path, content):
    tmp = path.with_suffix(path.suffix + '.tmp')
    with open(tmp, 'w') as fh:
        fh.write(content)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(str(tmp), str(path))


def write_server(ip, http_port):
    """Point all three addresses at the server. Returns the keys that changed.

    json_config.json is only rewritten when it parses as an object, with every
    section it had (wifi, lora, sn) kept; the broker port that was there
    stays. An unreadable one is left alone (set_server_urls.sh restores it
    from its backups) and the other two are still written.
    """
    if not is_local(ip):
        raise ValueError('refusing to write public address %s (the LFI cloud never goes in a file)' % ip)
    state = read_state()
    changed = differences(ip, http_port, state)
    if 'mqtt_addr' in changed:
        try:
            cfg = json.loads(JSON_PATH.read_text())
        except (OSError, ValueError):
            cfg = None
        if isinstance(cfg, dict):
            mqtt = cfg.get('mqtt') if isinstance(cfg.get('mqtt'), dict) else {}
            value = mqtt.get('value') if isinstance(mqtt.get('value'), dict) else {}
            value['addr'] = ip
            value.setdefault('port', DEFAULT_MQTT_PORT)
            mqtt.update({'set': 1, 'value': value})
            cfg['mqtt'] = mqtt
            _atomic_write(JSON_PATH, json.dumps(cfg))
        else:
            changed.remove('mqtt_addr')
    if 'http' in changed:
        # host:port only: mqtt_node puts http:// in front and breaks on a newline.
        _atomic_write(HTTP_ADDR_PATH, '%s:%d' % (ip, http_port))
    if 'server_ip' in changed:
        _atomic_write(SERVER_IP_PATH, ip + '\n')
    if 'sensor' in changed:
        # Only the value: the rest of the stock file stays byte for byte.
        text = SENSOR_JSON_PATH.read_text()
        _atomic_write(SENSOR_JSON_PATH, SENSOR_SERVER_RE.sub(
            lambda m: m.group(1) + 'tcp://%s:%d' % (ip, state['mqtt_port']) + m.group(3), text, count=1))
    return changed


def main(argv):
    if argv[1:] != ['--once']:
        print('usage: server_address.py --once', file=sys.stderr)
        return 2
    state = read_state()
    found = find_server(state)
    if not found:
        print('no OpenNova server answers; addresses unchanged (mqtt %s, http %s)' % (state['mqtt_addr'], state['http']))
        return 1
    ip, port = found
    changed = write_server(ip, port)
    print('server %s (http %d, mqtt %d): %s' % (ip, port, state['mqtt_port'],
                                               'updated ' + ', '.join(changed) if changed else 'unchanged'))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
