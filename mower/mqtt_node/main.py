"""Open mqtt_node entry point.

Wire ROS2 bridge + MQTT client + dispatcher + sensor aggregator + HTTP
client + OTA client + BLE framer. MultiThreadedExecutor spins the rclpy
node. Signal handlers shut everything down cleanly.
"""
from __future__ import annotations
import json
import logging
import os
import signal
import sys
import threading
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
    """SN comes from /userdata/factory/sn or /etc/sn — fall back to
    SN env var for dev/host runs."""
    for p in ('/userdata/factory/sn', '/etc/sn'):
        try:
            sn = Path(p).read_text().strip()
            if sn:
                return sn
        except Exception:
            pass
    sn = os.environ.get('SN')
    if not sn:
        raise RuntimeError(
            'Cannot determine mower SN — set SN env var or populate '
            '/userdata/factory/sn')
    return sn


def main():
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(name)s %(levelname)s %(message)s')

    cfg = load_config()
    sn = _detect_sn()
    log.info('open_mqtt_node starting for %s, broker %s:%s',
             sn, cfg.mqtt_host, cfg.mqtt_port)

    # ROS 2 init
    rclpy.init()
    bridge = Ros2Bridge()
    aggregator = SensorAggregator()
    if hasattr(bridge, 'bind_aggregator'):
        bridge.bind_aggregator(aggregator)

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
    outbound_topic = f'Dart/Receive_mqtt/{sn}'

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
        http.stop()
        mqtt.loop_stop()
        mqtt.disconnect()
        bridge.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
