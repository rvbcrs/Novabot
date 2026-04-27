"""Runtime configuration for mqtt_node.

Sources (in precedence order):
1. Environment variables (BROKER_HOST, BROKER_PORT, AES_BYPASS_SNS,
   ROS_DOMAIN_ID, MAP_DIR)
2. /userdata/lfi/json_config.json — mqtt section
3. /userdata/lfi/http_address.txt — host:port (NO http:// prefix per
   CLAUDE.md)

Live binary string evidence: research/documents/mqtt_node-strings.md:752-753.
"""
from __future__ import annotations
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Set


DEFAULT_JSON = Path('/userdata/lfi/json_config.json')
DEFAULT_HTTP_ADDR = Path('/userdata/lfi/http_address.txt')
DEFAULT_MAP_DIR = Path('/userdata/lfi/maps/')


@dataclass
class Config:
    mqtt_host: str
    mqtt_port: int
    http_host: str
    http_port: int
    map_dir: Path = DEFAULT_MAP_DIR
    aes_bypass_sns: Set[str] = field(default_factory=set)
    # Shadow mode: run alongside the stock /mqtt_node binary for parity
    # observation. Different ROS node name (open_mqtt_node_shadow) and
    # different outbound MQTT topic (Dart/Receive_mqtt_shadow/<SN>) so the
    # app keeps receiving stock responses. Service/action calls are
    # logged-only — handlers see "service unavailable" and produce fake
    # error responds that go to the shadow topic only.
    shadow_mode: bool = False


def load(json_path: Path = DEFAULT_JSON,
         http_addr_path: Path = DEFAULT_HTTP_ADDR) -> Config:
    """Load the runtime configuration. Missing files are tolerated and
    fall back to defaults; env vars always win."""
    mqtt_host, mqtt_port = '127.0.0.1', 1883
    http_host, http_port = '127.0.0.1', 80

    if json_path.exists():
        try:
            data = json.loads(json_path.read_text())
            mqtt = data.get('mqtt', {}) or {}
            # Live mower shape (verified on LFIN1231000211 2026-04-27):
            #   {"mqtt": {"set": 1, "value": {"addr": "<host>", "port": <p>}}}
            # Older test shape: {"mqtt": {"server": "<host>", "port": <p>}}
            value = mqtt.get('value') if isinstance(mqtt.get('value'), dict) else mqtt
            mqtt_host = value.get('addr', value.get('server', mqtt_host))
            mqtt_port = int(value.get('port', mqtt_port))
        except Exception:
            pass

    if http_addr_path.exists():
        try:
            line = http_addr_path.read_text().strip()
            if ':' in line:
                h, p = line.rsplit(':', 1)
                http_host = h
                http_port = int(p)
            else:
                http_host = line
        except Exception:
            pass

    if 'BROKER_HOST' in os.environ:
        mqtt_host = os.environ['BROKER_HOST']
    if 'BROKER_PORT' in os.environ:
        mqtt_port = int(os.environ['BROKER_PORT'])
    if 'HTTP_HOST' in os.environ:
        http_host = os.environ['HTTP_HOST']
    if 'HTTP_PORT' in os.environ:
        http_port = int(os.environ['HTTP_PORT'])

    bypass: Set[str] = set()
    if 'AES_BYPASS_SNS' in os.environ:
        bypass = {s.strip() for s in os.environ['AES_BYPASS_SNS'].split(',') if s.strip()}

    map_dir = Path(os.environ.get('MAP_DIR', str(DEFAULT_MAP_DIR)))

    shadow_mode = os.environ.get('OPEN_MQTT_NODE_SHADOW', '0').lower() in (
        '1', 'true', 'yes', 'on')

    return Config(
        mqtt_host=mqtt_host,
        mqtt_port=mqtt_port,
        http_host=http_host,
        http_port=http_port,
        map_dir=map_dir,
        aes_bypass_sns=bypass,
        shadow_mode=shadow_mode,
    )
