#!/usr/bin/env python3
"""Self-check for research/broker_resolver.py and the helpers that use it (GH #160).

A server that moved to a new IP kept the mower's helpers on the old broker:
extended_commands.py, led_bridge.py and auto_map_node.py each read the address
once at start and reconnected to that same address forever. Live on
LFIN2231000451: DNS and the new broker were fine, the log still said
"[LED-BRIDGE] SN=..., MQTT=192.168.178.8:1883" and the mower stayed offline.

The helpers now read the broker anew before every connect: json_config's,
the same one mqtt_node uses. Which server that is, is decided in
server_address.py (GH #170); the resolver's own list of names took the public
mqtt.lfibot.com over the local broker (GH #169).

Run: python3 research/__tests__/test_broker_resolver.py
"""
import importlib.util
import json
import os
import signal
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(("ok   " if ok else "FAIL ") + name + (f" | {detail}" if detail else ""))


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(RESEARCH, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


OLD, NEW = "192.168.178.8", "192.168.178.228"

br = load("broker_resolver_under_test", "broker_resolver.py")

tmp = tempfile.mkdtemp()
CFG = os.path.join(tmp, "json_config.json")
LAST = os.path.join(tmp, "server_ip.txt")


def write_cfg(addr, port=1883):
    with open(CFG, "w") as fh:
        json.dump({"sn": {"value": {"code": "LFIN2231000451"}},
                   "mqtt": {"set": 1, "value": {"addr": addr, "port": port}}}, fh)


def write_last(addr):
    if addr is None:
        if os.path.exists(LAST):
            os.remove(LAST)
    else:
        with open(LAST, "w") as fh:
            fh.write(addr + "\n")


def resolve(last_known=OLD):
    write_last(last_known)
    return br.resolve_broker(config_file=CFG, last_known_file=LAST)


# ── The broker is json_config's, read on every call ─────────────────────────
write_cfg(OLD)
check("the configured broker", resolve() == (OLD, 1883), resolve())

write_cfg(OLD, port=1884)
check("  ... with its port", resolve() == (OLD, 1884), resolve())

# GH #169: the resolver tried names first and took the public cloud.
write_cfg("192.168.178.228")
check("no name lookups of its own: the configured local broker, never mqtt.lfibot.com",
      not hasattr(br, "lookup") and resolve() == ("192.168.178.228", 1883), resolve())

write_cfg("mqtt.lfibot.com")
check("before the first server is found, the stock name as is (ESP32 setup AP)",
      resolve() == ("mqtt.lfibot.com", 1883), resolve())

write_cfg(OLD)
first = resolve(last_known=None)
write_cfg(NEW)
second = resolve(last_known=None)
check("json_config is read on every call, not once at start",
      first == (OLD, 1883) and second == (NEW, 1883), (first, second))

with open(CFG, "w") as fh:
    fh.write("{broken")
check("unreadable config, nothing known -> 127.0.0.1:1883 as before", resolve(last_known=None) == ("127.0.0.1", 1883))
check("unreadable config -> server_ip.txt as the fallback", resolve(last_known=OLD) == (OLD, 1883))


# ── The helpers pick the broker before every connect ─────────────────────────
class StopLoop(BaseException):
    """Ends a helper's `while True` reconnect loop from the fake sleep."""


def picks(addresses):
    """A resolve_broker stub that hands out `addresses` in turn."""
    seq = list(addresses)
    calls = []

    def resolve_broker(**_kw):
        calls.append(1)
        return seq[min(len(calls) - 1, len(seq) - 1)], 1883
    return resolve_broker, calls


class FakeClient:
    made = []

    def __init__(self, host, port, client_id, on_message=None):
        self.host, self.port = host, port
        FakeClient.made.append((host, port, client_id))

    def connect(self):
        raise ConnectionRefusedError(f"{self.host} refused")


def sleeper(limit):
    count = [0]

    def sleep(_s):
        count[0] += 1
        if count[0] >= limit:
            raise StopLoop()
    return types.SimpleNamespace(sleep=sleep, time=lambda: 0.0, monotonic=lambda: 0.0)


saved_signals = {s: signal.getsignal(s) for s in (signal.SIGTERM, signal.SIGCHLD)}


def restore_signals():
    for s, h in saved_signals.items():
        signal.signal(s, h)


# extended_commands.py
ec = load("ec_under_test", "extended_commands.py")
check("extended_commands.read_config no longer resolves DNS itself (the resolver does, per connect)",
      "gethostbyname" not in open(os.path.join(RESEARCH, "extended_commands.py")).read().split("def read_config", 1)[1].split("\ndef ", 1)[0])
ec.broker_resolver = types.SimpleNamespace(resolve_broker=picks([OLD, NEW])[0])
FakeClient.made = []
ec.MiniMQTT = FakeClient
for _ in range(2):
    try:
        ec.connect_mqtt("ext_cmd_X", None)
    except ConnectionRefusedError:
        pass
check("extended_commands.connect_mqtt resolves on every call",
      [m[0] for m in FakeClient.made] == [OLD, NEW], FakeClient.made)

stub, calls = picks([OLD, OLD, NEW])
ec.broker_resolver = types.SimpleNamespace(resolve_broker=stub)
FakeClient.made = []
for name in ("recover_patrol_status_after_restart", "start_blade_telemetry_relay",
             "start_recharge_light_watcher", "start_charging_station_guard",
             "start_perception_model_client", "start_rtk_telemetry_relay"):
    setattr(ec, name, lambda *a, **k: None)
ec.enable_rtk_telemetry = lambda: False
ec.read_config = lambda: ("LFIN2231000451", OLD, 1883)
ec.time = sleeper(3)
try:
    ec.main()
except StopLoop:
    pass
finally:
    restore_signals()
check("extended_commands main: each reconnect picks the broker again",
      [m[0] for m in FakeClient.made] == [OLD, OLD, NEW] and len(calls) == 3, FakeClient.made)

# led_bridge.py
lb = load("lb_under_test", "led_bridge.py")
lb.MiniMQTT = FakeClient
stub, calls = picks([OLD, NEW, NEW])
lb.broker_resolver = types.SimpleNamespace(resolve_broker=stub)
FakeClient.made = []


class FakeLed:
    def init(self):
        pass

    def publish(self, _v):
        pass

    def destroy(self):
        pass


lb.LedPublisher = FakeLed
lb.read_config = lambda: ("LFIN2231000451", OLD, 1883)
lb.time = sleeper(3)
try:
    lb.main()
except StopLoop:
    pass
finally:
    restore_signals()
check("led_bridge main: each reconnect picks the broker again (it had no DNS fallback at all)",
      [m[0] for m in FakeClient.made] == [OLD, NEW, NEW], FakeClient.made)

# auto_map_node.py: uses extended_commands.connect_mqtt
amn = load("amn_under_test", "auto_map_node.py")
made = []


def fake_connect(client_id, on_message):
    made.append(client_id)
    raise ConnectionRefusedError("refused")


amn._EC = types.SimpleNamespace(read_config=lambda: ("LFIN2231000451", OLD, 1883),
                                log=lambda *_a: None, connect_mqtt=fake_connect)
amn.time = sleeper(3)
try:
    amn.main()
except StopLoop:
    pass
check("auto_map_node main: connects through extended_commands.connect_mqtt on every attempt",
      made == ["auto_map_LFIN2231000451"] * 3, made)

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
