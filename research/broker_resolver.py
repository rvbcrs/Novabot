#!/usr/bin/env python3
"""Which MQTT broker should a helper connect to right now? (GH #160)

Shared by extended_commands.py, led_bridge.py and auto_map_node.py (through
extended_commands.connect_mqtt). They used to read the broker address once at
start and reconnect to that address forever, so a server that moved to a new
IP kept them on the old one while DNS and the new broker were fine. They now
call resolve_broker() before every connect.

Candidates, in order; the first that accepts a TCP connect on the MQTT port
within a short timeout wins:
  1. opennova.local      mDNS, follows the server when it moves
  2. mqtt.lfibot.com     the DNS redirect of the stock cloud name
  3. json_config.json    the configured mqtt address
  4. server_ip.txt       the last server set_server_urls.sh found
When none answers, the configured address is returned, so the caller's retry
loop keeps trying the address it was given.

Stdlib only. build_custom_firmware.sh copies it next to the helpers in
/root/novabot/scripts/.
"""
import json
import socket

CONFIG_FILE = "/userdata/lfi/json_config.json"
LAST_KNOWN_FILE = "/userdata/lfi/server_ip.txt"
MDNS_NAME = "opennova.local"
DNS_NAME = "mqtt.lfibot.com"
DEFAULT_ADDR = "127.0.0.1"
DEFAULT_PORT = 1883
CONNECT_TIMEOUT_S = 2.0


def configured_broker(path=CONFIG_FILE):
    """(addr, port) of the mqtt section in json_config.json; addr None when unreadable."""
    try:
        with open(path) as fh:
            value = (json.load(fh).get("mqtt") or {}).get("value") or {}
        return (str(value["addr"]) if value.get("addr") else None,
                int(value.get("port") or DEFAULT_PORT))
    except Exception:
        return None, DEFAULT_PORT


def last_known_server(path=LAST_KNOWN_FILE):
    try:
        with open(path) as fh:
            return fh.read().strip() or None
    except OSError:
        return None


def lookup(name):
    """IPv4 address of `name` via the libc resolver (files, mdns4_minimal, dns), or None."""
    try:
        return socket.gethostbyname(name)
    except (OSError, UnicodeError):
        return None


def accepts_connect(addr, port, timeout=CONNECT_TIMEOUT_S):
    try:
        socket.create_connection((addr, port), timeout).close()
        return True
    except (OSError, ValueError):
        return False


def resolve_broker(config_file=CONFIG_FILE, last_known_file=LAST_KNOWN_FILE,
                   lookup=lookup, reachable=accepts_connect, timeout=CONNECT_TIMEOUT_S):
    """(addr, port) to connect to now. Reads the files on every call."""
    configured, port = configured_broker(config_file)
    last_known = last_known_server(last_known_file)
    candidates = []
    for addr in (lookup(MDNS_NAME), lookup(DNS_NAME), configured, last_known):
        if addr and addr not in candidates:
            candidates.append(addr)
    for addr in candidates:
        if reachable(addr, port, timeout):
            return addr, port
    return configured or last_known or DEFAULT_ADDR, port
