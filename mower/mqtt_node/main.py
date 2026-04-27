"""Open mqtt_node entry point.

Wire ROS2 bridge + MQTT client + dispatcher + sensor aggregator + HTTP
client + OTA client + BLE framer. MultiThreadedExecutor spins the rclpy
node. Signal handlers shut everything down cleanly.
"""
from __future__ import annotations
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

import rclpy
from rclpy.executors import MultiThreadedExecutor

from config import load as load_config
from mqtt_client import MqttClient
from command_dispatcher import CommandDispatcher
from ros2_bridge import Ros2Bridge
from sensor_aggregator import SensorAggregator
from http_client import HttpClient
from ota_client import OtaClient

log = logging.getLogger('mqtt_node.main')


def _detect_sn() -> str:
    """SN sources, in order of preference:

    1. SN env var (dev/host runs, also useful for shadow tests)
    2. /userdata/lfi/json_config.json sn.value.code (live mower —
       verified on LFIN1231000211 2026-04-27)
    3. /userdata/factory/sn (legacy — never observed on this firmware
       but kept for compatibility)
    4. /etc/sn (legacy)
    """
    sn = os.environ.get('SN')
    if sn:
        return sn

    cfg_path = Path('/userdata/lfi/json_config.json')
    if cfg_path.exists():
        try:
            data = json.loads(cfg_path.read_text())
            sn_section = data.get('sn', {})
            value = sn_section.get('value') if isinstance(sn_section, dict) else None
            if isinstance(value, dict):
                code = value.get('code')
                if isinstance(code, str) and code.strip():
                    return code.strip()
        except Exception:
            pass

    for p in ('/userdata/factory/sn', '/etc/sn'):
        try:
            sn = Path(p).read_text().strip()
            if sn:
                return sn
        except Exception:
            pass

    raise RuntimeError(
        'Cannot determine mower SN — set SN env var or populate '
        '/userdata/lfi/json_config.json sn.value.code')


def _detect_versions() -> dict:
    """Read sv/hv/ov from on-disk sources.

    sv (software): parse /userdata/ota/upgrade_pkg/mower_firmware_*.deb
       filename; falls back to '' if no .deb is staged.
    ov (OS): /userdata/lfi/system_version.txt (e.g. 'V0.3.2').
    hv (hardware): hardcoded 'v0.0.1' to match the stock catalog —
       /userdata/lfi/mcu_message.json only carries an int that the
       stock binary never seems to surface.
    """
    sv = ''
    pkg_dir = Path('/userdata/ota/upgrade_pkg')
    if pkg_dir.is_dir():
        for f in pkg_dir.iterdir():
            m = re.match(r'mower_firmware_(.+)\.deb$', f.name)
            if m:
                sv = m.group(1)
                break

    ov = ''
    try:
        ov = Path('/userdata/lfi/system_version.txt').read_text().strip()
    except Exception:
        pass

    return {'sv': sv, 'hv': 'v0.0.1', 'ov': ov}


def _read_system_metrics() -> dict:
    """Snapshot polled system metrics for report_state_to_server_work_respond.

    Returns mb counts + working_time_min (since boot).
    """
    disk_mb = 0
    try:
        v = os.statvfs('/userdata')
        disk_mb = (v.f_bavail * v.f_frsize) // (1024 * 1024)
    except Exception:
        pass

    memory_mb = 0
    try:
        with open('/proc/meminfo') as f:
            for line in f:
                if line.startswith('MemAvailable:'):
                    memory_mb = int(line.split()[1]) // 1024
                    break
    except Exception:
        pass

    working_time_min = 0
    try:
        with open('/proc/uptime') as f:
            working_time_min = int(float(f.read().split()[0]) // 60)
    except Exception:
        pass

    return {
        'disk_mb': disk_mb,
        'memory_mb': memory_mb,
        'working_time_min': working_time_min,
    }


def _read_wifi_rssi() -> int:
    """Read wifi signal strength from /proc/net/wireless.
    Returns 0 on failure (matches stock behavior when no wifi).
    Format: link quality (0-70) — we keep the raw integer to match the
    stock catalog's value range (54 in the live capture).
    """
    try:
        with open('/proc/net/wireless') as f:
            for line in f.readlines()[2:]:
                parts = line.split()
                if len(parts) >= 3:
                    return int(float(parts[2].rstrip('.')))
    except Exception:
        pass
    return 0


def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(name)s %(levelname)s %(message)s')

    cfg = load_config()
    sn = _detect_sn()
    if cfg.shadow_mode:
        log.warning('open_mqtt_node SHADOW MODE for %s, broker %s:%s — '
                    'service calls logged only, outbound MQTT goes to '
                    'Dart/Receive_mqtt_shadow/<SN>',
                    sn, cfg.mqtt_host, cfg.mqtt_port)
    else:
        log.info('open_mqtt_node starting for %s, broker %s:%s',
                 sn, cfg.mqtt_host, cfg.mqtt_port)

    # ROS 2 init
    rclpy.init()
    bridge = Ros2Bridge(shadow_mode=cfg.shadow_mode)
    aggregator = SensorAggregator()
    bridge.bind_aggregator(aggregator)

    # One-shot version read (sv/hv/ov)
    versions = _detect_versions()
    aggregator.update_versions(**versions)
    log.info('versions: sv=%r ov=%r hv=%r',
             versions['sv'], versions['ov'], versions['hv'])

    # MQTT side: register every command on the bridge.
    # MQTT key → handler (keys per ros2_bridge docstrings + RE-5 catalog)
    dispatcher = CommandDispatcher()
    dispatcher.register('start_navigation', bridge.handle_start_navigation)
    dispatcher.register('start_run', bridge.handle_start_run)
    dispatcher.register('stop_task', bridge.handle_stop_task)
    dispatcher.register('stop_to_charge', bridge.handle_stop_to_charge)
    dispatcher.register('auto_recharge', bridge.handle_auto_recharge)
    dispatcher.register('go_to_charge', bridge.handle_nav_to_recharge)
    dispatcher.register('cancel_task', bridge.handle_cancel_task)
    dispatcher.register('cancel_recharge', bridge.handle_cancel_recharge)
    dispatcher.register('start_scan_map', bridge.handle_start_scan_map)
    dispatcher.register('add_scan_map', bridge.handle_add_scan_map)
    dispatcher.register('save_map', bridge.handle_save_map)
    dispatcher.register('delete_map', bridge.handle_delete_map)
    dispatcher.register('quit_mapping_mode', bridge.handle_quit_mapping_mode)
    dispatcher.register('start_assistant_build_map',
                        bridge.handle_start_assistant_build_map)
    dispatcher.register('get_preview_cover_path',
                        bridge.handle_get_preview_cover_path)
    dispatcher.register('save_recharge_pos', bridge.handle_save_recharge_pos)

    # OTA
    ota = OtaClient(work_dir=Path('/userdata/ota'),
                    progress_cb=lambda pct: log.info('ota progress: %s%%', pct))
    dispatcher.register('ota_upgrade_cmd', ota.handle_upgrade)

    # MQTT client glue
    mqtt = MqttClient(host=cfg.mqtt_host, port=cfg.mqtt_port, sn=sn)
    outbound_topic = (
        f'Dart/Receive_mqtt_shadow/{sn}' if cfg.shadow_mode
        else f'Dart/Receive_mqtt/{sn}'
    )
    server_topic = (
        f'Dart/Receive_server_mqtt_shadow/{sn}' if cfg.shadow_mode
        else f'Dart/Receive_server_mqtt/{sn}'
    )

    def publish_respond(respond_key: str, body: dict) -> None:
        wrapped = json.dumps({respond_key: body}, separators=(',', ':')).encode('utf-8')
        mqtt.publish(outbound_topic, wrapped, encrypted=True)

    dispatcher.set_respond_publisher(publish_respond)

    def on_inbound(_sn, _topic, payload_bytes):
        try:
            payload = json.loads(payload_bytes.decode('utf-8'))
        except Exception as e:
            log.warning('main: bad JSON inbound: %s', e)
            return
        dispatcher.dispatch(payload)

    mqtt.on_message(on_inbound)
    mqtt.connect()
    mqtt.loop_start()

    # HTTP loops
    http = HttpClient(host=cfg.http_host, port=cfg.http_port, sn=sn)
    http.start()

    # Periodic state report publish (matches stock ~2.3 s cadence —
    # see research/documents/mqtt_node-payload-catalog.md report_state_robot).
    publish_period_sec = 2.3
    publish_stop = threading.Event()

    def publish_state_reports():
        while not publish_stop.is_set():
            try:
                for builder_name in ('report_state_robot',
                                     'report_state_timer_data',
                                     'report_exception_state'):
                    builder = getattr(aggregator, f'build_{builder_name}', None)
                    if builder is None:
                        continue
                    body = builder()
                    payload = json.dumps({builder_name: body},
                                         separators=(',', ':')).encode('utf-8')
                    mqtt.publish(outbound_topic, payload, encrypted=True)
            except Exception:
                log.exception('publish_state_reports iteration failed')
            publish_stop.wait(publish_period_sec)

    publish_thread = threading.Thread(
        target=publish_state_reports,
        daemon=True,
        name='mqtt_node_publish_loop')
    publish_thread.start()

    # Server-only reports (Dart/Receive_server_mqtt/<SN>) — 60 s cadence.
    # Same loop also polls /proc + statvfs + /proc/net/wireless for the
    # system metrics that go inside report_state_to_server_work_respond.
    server_period_sec = 60.0

    def publish_server_reports():
        while not publish_stop.is_set():
            try:
                metrics = _read_system_metrics()
                aggregator.update_system_metrics(**metrics)
                aggregator.update_signal(
                    wifi_rssi=_read_wifi_rssi(),
                    rtk_sat=getattr(aggregator, '_rtk_sat', 0),
                )
                # Stock binary publishes BOTH every 60 s — exception is
                # documented as event-driven but the catalog only saw it
                # once per 30 min window. Mirror the cadence here for
                # parity; receivers idempotently read either.
                for builder_name in (
                        'report_state_to_server_work_respond',
                        'report_state_to_server_exception_respond'):
                    builder = getattr(aggregator, f'build_{builder_name}', None)
                    if builder is None:
                        continue
                    body = builder()
                    payload = json.dumps(body, separators=(',', ':')).encode('utf-8')
                    mqtt.publish(server_topic, payload, encrypted=True)
            except Exception:
                log.exception('publish_server_reports iteration failed')
            publish_stop.wait(server_period_sec)

    server_thread = threading.Thread(
        target=publish_server_reports,
        daemon=True,
        name='mqtt_node_server_loop')
    server_thread.start()

    # ROS2 spin
    executor = MultiThreadedExecutor(num_threads=4)
    executor.add_node(bridge)

    stop_evt = threading.Event()

    def _shutdown(_sig=None, _frame=None):
        log.info('mqtt_node shutting down')
        stop_evt.set()

    signal.signal(signal.SIGINT, _shutdown)
    signal.signal(signal.SIGTERM, _shutdown)

    try:
        while not stop_evt.is_set():
            executor.spin_once(timeout_sec=1.0)
    finally:
        publish_stop.set()
        publish_thread.join(timeout=2.0)
        server_thread.join(timeout=2.0)
        http.stop()
        mqtt.loop_stop()
        mqtt.disconnect()
        bridge.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
