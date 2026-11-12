#!/usr/bin/env python3
"""Keeps every server address on the mower pointing at the OpenNova server.

Every 60 s it asks server_address.find_server() which server answers (mDNS
opennova.local first, then the DNS redirect of the stock names, then the last
server found; only one that answers as OpenNova counts) and compares that with
ALL three addresses: json_config.json's broker, http_address.txt and
server_ip.txt. When any of them differs for 2 consecutive polls, they are all
rewritten together (server_address.write_server), mqtt_node is killed so
mqtt_node_monitor.sh respawns it with the new files, and when the broker
moved the OpenNova MQTT helpers are restarted the way run_novabot.sh starts
them.

It used to compare only the broker, so a stale http_address.txt next to a
correct broker was never fixed (GH #170), and it would not touch a broker set
by hand. A verified OpenNova server now always wins: the mower must point at
one server everywhere.

Verified deployment target: LFIN1231000211 (Python 3.8.10, aarch64).
Uses only Python stdlib + libnss-mdns (which is already wired into
nsswitch on this firmware — `getent hosts opennova.local` works).
"""
from __future__ import annotations

import glob
import logging
import os
import shlex
import shutil
import signal
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server_address  # noqa: E402  (installed next to this script)

LOG = logging.getLogger('opennova_discovery')

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
    current = server_address.read_state()
    found = server_address.find_server(current)
    stale = server_address.differences(*found, current) if found else []

    if not stale:
        if state['candidate'] is not None:
            LOG.info('candidate %s no longer differs — debounce reset', state['candidate'])
        state['candidate'], state['hits'] = None, 0
        return
    if state['candidate'] == found:
        state['hits'] += 1
    else:
        state['candidate'], state['hits'] = found, 1
    LOG.info('server %s:%d differs in %s, seen %d/%d (mqtt=%s http=%s server_ip=%s)',
             found[0], found[1], ', '.join(stale), state['hits'], DEBOUNCE,
             current['mqtt_addr'], current['http'], current['server_ip'])
    if state['hits'] < DEBOUNCE:
        return
    state['candidate'], state['hits'] = None, 0
    try:
        changed = server_address.write_server(*found)
    except Exception:
        LOG.exception('rewrite failed — leaving the addresses alone')
        return
    LOG.warning('addresses now %s:%d (rewrote %s) — restarting mqtt_node', found[0], found[1], ', '.join(changed))
    kill_mqtt_node()
    if 'mqtt_addr' in changed:
        restart_helpers()


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
