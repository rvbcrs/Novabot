#!/usr/bin/env python3
"""Standalone runtime discovery loop for mowers running custom-firmware
without the open mqtt_node Python wrapper.

Polls `opennova.local` every 60 s. When the resolved IP differs from the
current mqtt addr in /userdata/lfi/json_config.json for 2 consecutive
polls, atomically rewrites the config files (json_config.json,
http_address.txt, server_ip.txt), kills mqtt_node so the existing
mqtt_node_monitor.sh respawns it with the new broker, and restarts the
OpenNova MQTT helpers the way run_novabot.sh starts them.

When mDNS stays silent (server in a Docker bridge), the DNS redirect of
mqtt.lfibot.com is followed too (GH #160), but only for an address this
firmware wrote itself (a stock name, or equal to server_ip.txt) and only to
a server that answers /api/setup/health as OpenNova. A broker set by hand
(BLE provisioning, ESP32 tool) is left to mDNS alone, as before.

Verified deployment target: LFIN1231000211 (Python 3.8.10, aarch64).
Uses only Python stdlib + libnss-mdns (which is already wired into
nsswitch on this firmware — `getent hosts opennova.local` works).
"""
from __future__ import annotations

import glob
import json
import logging
import os
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

LOG = logging.getLogger('opennova_discovery')

JSON_PATH = Path('/userdata/lfi/json_config.json')
HTTP_ADDR_PATH = Path('/userdata/lfi/http_address.txt')
SERVER_IP_PATH = Path('/userdata/lfi/server_ip.txt')
HOSTNAMES = ('opennova.local', 'opennovabot.local')
DNS_HOSTNAMES = ('mqtt.lfibot.com',)
# What set_server_urls.sh treats as "not set by hand" (stap 4 there).
STOCK_ADDRS = ('', 'mqtt.lfibot.com', 'mqtt-dev.lfibot.com', 'app.lfibot.com')
INTERVAL_S = 60
DEBOUNCE = 2
MQTT_NODE_BINARY = '/root/novabot/install/novabot_api/lib/novabot_api/mqtt_node'

SCRIPTS = '/root/novabot/scripts'
HELPER_LOG_DIR = '/root/novabot/novabot_log'
# The environment run_novabot.sh gives everything it starts (its header).
ROS_ENV = (
    'source /opt/ros/galactic/setup.bash; '
    'source /root/novabot/install/setup.bash; '
    'export LD_LIBRARY_PATH=/usr/lib/hbmedia/:/usr/lib/hbbpu/:/usr/lib/sensorlib:/usr/local/lib:'
    '/usr/lib/aarch64-linux-gnu:/usr/bpu:/usr/opencv_world_4.6/lib:$LD_LIBRARY_PATH; '
    'export ROS_LOG_DIR=/root/novabot/data/ros2_log; '
    'export ROS_LOCALHOST_ONLY=1; '
)
# The MQTT helpers beside mqtt_node. Each read the broker address at start,
# so after a switch they are restarted like run_novabot.sh starts them, in
# its environment (this service itself starts with a bare one):
# (log name, processes to stop in this order, command that starts it again).
HELPERS = (
    # start_ext.sh: the documented restart route, adds the cyclonedds RMW.
    ('extended_commands', (SCRIPTS + '/extended_commands.py',),
     ROS_ENV + 'exec bash ' + SCRIPTS + '/start_ext.sh'),
    ('led_bridge', (SCRIPTS + '/led_bridge.py',),
     ROS_ENV + 'exec python3 ' + SCRIPTS + '/led_bridge.py'),
    # start_auto_map.sh is the node's own respawn loop: stop it first, or it
    # starts a second node next to the one started here.
    ('auto_map_node', (SCRIPTS + '/start_auto_map.sh', SCRIPTS + '/auto_map_node.py'),
     ROS_ENV + 'exec bash ' + SCRIPTS + '/start_auto_map.sh'),
)
STOP_WAIT_STEPS = 10   # x 0.5 s before SIGKILL


def resolve_mdns(hostnames):
    """Best-effort A-record lookup via stdlib resolver (libnss-mdns)."""
    for h in hostnames:
        try:
            ip = socket.gethostbyname(h)
            if ip and not ip.startswith('127.'):
                return ip
        except OSError:
            continue
    return None


def resolve_dns(hostnames=DNS_HOSTNAMES):
    """The DNS redirect of the stock cloud name (the same libc lookup)."""
    return resolve_mdns(hostnames)


def read_current_mqtt_host():
    if not JSON_PATH.exists():
        return None
    try:
        d = json.loads(JSON_PATH.read_text())
        m = d.get('mqtt', {}) or {}
        v = m.get('value') if isinstance(m.get('value'), dict) else m
        return v.get('addr', v.get('server'))
    except Exception:
        LOG.exception('failed to read %s', JSON_PATH)
        return None


def read_last_known():
    """The server set_server_urls.sh (or this loop) last wrote, or None."""
    try:
        return SERVER_IP_PATH.read_text().strip() or None
    except OSError:
        return None


def http_ports():
    """HTTP ports to ask: the one in http_address.txt, then the usual ones."""
    ports = []
    try:
        line = HTTP_ADDR_PATH.read_text().strip()
        if ':' in line:
            ports.append(int(line.rsplit(':', 1)[1]))
    except (OSError, ValueError):
        pass
    for p in (80, 8080, 443):
        if p not in ports:
            ports.append(p)
    return ports


def answers_as_opennova(ip, ports=None):
    """True when http://ip:<port>/api/setup/health answers as OpenNova.

    Same test as set_server_urls.sh's probe_http: a NAS web UI or the public
    lfibot.com does not name a server and a broker in a small JSON body.
    """
    for port in (ports if ports is not None else http_ports()):
        try:
            with urllib.request.urlopen('http://%s:%d/api/setup/health' % (ip, port), timeout=3) as r:
                body = r.read(2000).decode('utf-8', 'ignore')
            if '"server"' in body and '"mqtt"' in body:
                return True
        except Exception:
            continue
    return False


def may_follow_dns(current, last_known):
    """DNS only replaces an address this firmware wrote itself."""
    return (current or '') in STOCK_ADDRS or current == last_known


def find_server(current, last_known):
    """(ip, source) of the server to follow, or (None, None)."""
    ip = resolve_mdns(HOSTNAMES)
    if ip:
        return ip, 'mDNS'
    if not may_follow_dns(current, last_known):
        return None, None
    ip = resolve_dns()
    if not ip:
        return None, None
    if ip == current or answers_as_opennova(ip):
        return ip, 'DNS'
    return None, None


def atomic_write(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(content)
    fd = os.open(str(tmp), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(str(tmp), str(path))


def rewrite_configs(new_ip):
    if JSON_PATH.exists():
        d = json.loads(JSON_PATH.read_text())
        m = d.setdefault('mqtt', {})
        if isinstance(m.get('value'), dict):
            m['value']['addr'] = new_ip
        else:
            m['server'] = new_ip
        atomic_write(JSON_PATH, json.dumps(d, indent=2))
    if HTTP_ADDR_PATH.exists():
        line = HTTP_ADDR_PATH.read_text().strip()
        if ':' in line:
            _, p = line.rsplit(':', 1)
            atomic_write(HTTP_ADDR_PATH, '%s:%s' % (new_ip, p))
        else:
            atomic_write(HTTP_ADDR_PATH, new_ip)
    else:
        atomic_write(HTTP_ADDR_PATH, '%s:80' % new_ip)
    # set_server_urls.sh reads this as "the address I wrote": without it the
    # next boot would take the new address for one set by hand.
    atomic_write(SERVER_IP_PATH, new_ip + '\n')


def kill_mqtt_node():
    try:
        out = subprocess.check_output(['pgrep', '-f', MQTT_NODE_BINARY])
        for pid in out.decode().split():
            try:
                os.kill(int(pid), signal.SIGTERM)
                LOG.info('sent SIGTERM to mqtt_node pid=%s', pid)
            except ProcessLookupError:
                pass
    except subprocess.CalledProcessError:
        LOG.warning('mqtt_node not running — nothing to kill')


def pids_of(pattern):
    """PIDs whose command line matches `pattern`, never this process."""
    try:
        out = subprocess.check_output(['pgrep', '-f', pattern])
    except subprocess.CalledProcessError:
        return []
    return [int(p) for p in out.decode().split() if int(p) != os.getpid()]


def send_signal(pid, sig):
    try:
        os.kill(pid, sig)
    except ProcessLookupError:
        pass


def helper_log(name):
    """This boot's log of a helper (run_novabot.sh writes novabot_log/<boot>/<name>.log)."""
    logs = glob.glob(os.path.join(HELPER_LOG_DIR, '*', name + '.log'))
    if logs:
        return max(logs, key=os.path.getmtime)
    return os.path.join(HELPER_LOG_DIR, name + '.log')


def spawn_detached(command, log_path):
    """Start bash `command` in the background, output appended to log_path.

    Through systemd-run --scope when available: this loop runs as a systemd
    service, and a helper left in its cgroup would be killed with it on the
    next restart of the service.
    """
    shell = 'nohup bash -c %s >> %s 2>&1 </dev/null &' % (shlex.quote(command), shlex.quote(str(log_path)))
    argv = ['bash', '-c', shell]
    if shutil.which('systemd-run'):
        try:
            r = subprocess.run(['systemd-run', '--scope', '--quiet'] + argv, timeout=30,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL)
            if r.returncode == 0:
                return
            LOG.warning('systemd-run failed (%s), starting without it', r.returncode)
        except Exception:
            LOG.exception('systemd-run failed, starting without it')
    subprocess.run(argv, timeout=30, stdin=subprocess.DEVNULL,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def restart_helpers():
    """Restart every helper that is running; one that is not stays off."""
    for name, patterns, start in HELPERS:
        pids = [p for pattern in patterns for p in pids_of(pattern)]
        if not pids:
            continue
        for pattern in patterns:
            for pid in pids_of(pattern):
                send_signal(pid, signal.SIGTERM)
        for _ in range(STOP_WAIT_STEPS):
            if not any(pids_of(pattern) for pattern in patterns):
                break
            time.sleep(0.5)
        else:
            for pattern in patterns:
                for pid in pids_of(pattern):
                    send_signal(pid, signal.SIGKILL)
        try:
            spawn_detached(start, helper_log(name))
            LOG.info('restarted %s (was pid %s)', name, pids)
        except Exception:
            LOG.exception('could not start %s again', name)


def new_state():
    return {'candidate': None, 'hits': 0}


def poll_once(state):
    current = read_current_mqtt_host()
    resolved, source = find_server(current, read_last_known())

    if not resolved:
        LOG.debug('mDNS/DNS resolve failed — skipping')
        state['candidate'], state['hits'] = None, 0
    elif resolved == current:
        if state['candidate'] is not None:
            LOG.info('candidate %s matched current — debounce reset', state['candidate'])
        state['candidate'], state['hits'] = None, 0
    else:
        if state['candidate'] == resolved:
            state['hits'] += 1
        else:
            state['candidate'], state['hits'] = resolved, 1

        LOG.info('%s candidate %s seen %d/%d (current=%s)',
                 source, state['candidate'], state['hits'], DEBOUNCE, current)

        if state['hits'] >= DEBOUNCE:
            LOG.warning('confirmed switch %s -> %s, rewriting configs',
                        current, state['candidate'])
            try:
                rewrite_configs(state['candidate'])
                LOG.info('configs rewritten — killing mqtt_node so monitor respawns it')
                kill_mqtt_node()
                restart_helpers()
            except Exception:
                LOG.exception('switch failed — leaving previous config alone')
            state['candidate'], state['hits'] = None, 0


def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(name)s %(levelname)s %(message)s',
    )

    state = new_state()
    while True:
        poll_once(state)
        time.sleep(INTERVAL_S)


if __name__ == '__main__':
    sys.exit(main())
