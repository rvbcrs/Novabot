#!/usr/bin/env python3
"""Self-check for research/server_address.py (GH #170).

One rule decides which OpenNova server the mower uses and one function points
all three addresses at it: json_config.json's broker, http_address.txt and
server_ip.txt, always the same IP. Live on LFIN2231000451 the broker was the
local server while http_address.txt said the cloud (47.253.145.99:80), and
sync_map fetched the ZIP from the cloud.

Run: python3 research/__tests__/test_server_address.py
"""
import http.server
import importlib.util
import json
import os
import tempfile
import threading
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)

checks = []


def check(name, ok, detail=""):
    checks.append(bool(ok))
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else f" | {detail}"))


spec = importlib.util.spec_from_file_location("server_address", os.path.join(RESEARCH, "server_address.py"))
sa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sa)

tmp = Path(tempfile.mkdtemp())
sa.JSON_PATH = tmp / "json_config.json"
sa.HTTP_ADDR_PATH = tmp / "http_address.txt"
sa.SERVER_IP_PATH = tmp / "server_ip.txt"
sa.PORT_OVERRIDE_PATH = tmp / "server_port_override.txt"

LOCAL, CLOUD, PROXY = "192.168.178.228", "47.253.145.99", "192.168.0.248"


def setup(addr=LOCAL, port=1883, http=None, server_ip=None):
    sa.JSON_PATH.write_text(json.dumps({
        "sn": {"set": 1, "value": {"code": "LFIN2231000451"}},
        "wifi": {"set": 1, "value": {"ssid": "home"}},
        "lora": {"set": 1, "value": {"addr": 718, "channel": 17}},
        "mqtt": {"set": 1, "value": {"addr": addr, "port": port}}}))
    for path, value in ((sa.HTTP_ADDR_PATH, http), (sa.SERVER_IP_PATH, server_ip)):
        if value is None:
            path.unlink(missing_ok=True)
        else:
            path.write_text(value)
    sa.PORT_OVERRIDE_PATH.unlink(missing_ok=True)


def world(names, brokers=(), opennova=(), srv=None):
    """Stubs: names -> ip, ips with a broker, 'ip:port' that answer as OpenNova."""
    asked = []

    def opennova_fn(ip, port):
        asked.append(f"{ip}:{port}")
        return f"{ip}:{port}" in opennova

    srv_calls = []
    return dict(lookup=lambda n: names.get(n), reachable=lambda ip, port: ip in brokers,
                opennova=opennova_fn, srv=lambda: (srv_calls.append(1), srv)[1]), asked, srv_calls


def find(names, **kw):
    stubs, asked, srv_calls = world(names, **kw)
    return sa.find_server(sa.read_state(), **stubs), asked, srv_calls


# ── Which server ─────────────────────────────────────────────────────────────
setup()
got, _, _ = find({"opennova.local": LOCAL}, brokers={LOCAL}, opennova={LOCAL + ":8080"})
check("mDNS answer that is OpenNova -> its IP and HTTP port", got == (LOCAL, 8080), got)

got, _, _ = find({"opennova.local": "10.0.0.7", "mqtt.lfibot.com": LOCAL}, brokers={"10.0.0.7", LOCAL},
                 opennova={LOCAL + ":80"})
check("an mDNS name that is not OpenNova is passed over -> the DNS redirect", got == (LOCAL, 80), got)

# GH #169/#170: no DNS redirect, the stock names are the cloud.
setup(server_ip=LOCAL)
got, asked, _ = find({"mqtt.lfibot.com": "47.253.162.193", "app.lfibot.com": CLOUD},
                     brokers={"47.253.162.193", LOCAL}, opennova={LOCAL + ":80"})
check("the public cloud never counts -> the last server found", got == (LOCAL, 80), got)
check("  ... the cloud was asked, but did not answer as OpenNova",
      any(a.startswith("47.253.162.193:") for a in asked), asked)

got, _, _ = find({"mqtt.lfibot.com": LOCAL, "app.lfibot.com": PROXY}, brokers={LOCAL}, opennova={PROXY + ":80"})
check("a reverse proxy without a broker (app.lfibot.com -> NPM) does not count", got is None, got)

setup(server_ip="10.0.0.1")
got, _, _ = find({"mqtt.lfibot.com": "10.0.0.1"}, brokers={"10.0.0.1"})
check("the ESP32 setup AP (a broker, no OpenNova) does not count", got is None, got)

# ── HTTP port ────────────────────────────────────────────────────────────────
setup(http=LOCAL + ":3000")
got, asked, srv_calls = find({"opennova.local": LOCAL}, brokers={LOCAL}, opennova={LOCAL + ":3000"})
check("the port already in http_address.txt is asked first", got == (LOCAL, 3000) and asked == [LOCAL + ":3000"], asked)
check("  ... and the 4 s SRV query is skipped", srv_calls == [], srv_calls)

setup()
sa.PORT_OVERRIDE_PATH.write_text("8443\n")
got, asked, _ = find({"opennova.local": LOCAL}, brokers={LOCAL}, opennova={LOCAL + ":8443", LOCAL + ":80"})
check("server_port_override.txt wins", got == (LOCAL, 8443) and asked[0] == LOCAL + ":8443", asked)

setup()
got, asked, srv_calls = find({"opennova.local": LOCAL}, brokers={LOCAL}, opennova={LOCAL + ":5000"}, srv=5000)
check("an unusual port comes from SRV, after 80/8080/443", got == (LOCAL, 5000)
      and asked == [LOCAL + ":80", LOCAL + ":8080", LOCAL + ":443", LOCAL + ":5000"], asked)

# ── Writing ──────────────────────────────────────────────────────────────────
# The issue: broker local, http_address.txt still the cloud.
setup(addr=LOCAL, http=CLOUD + ":80", server_ip=LOCAL)
check("GH #170: only http_address.txt differs", sa.differences(LOCAL, 80, sa.read_state()) == ["http"],
      sa.differences(LOCAL, 80, sa.read_state()))
changed = sa.write_server(LOCAL, 80)
check("  ... and writing fixes exactly that", changed == ["http"] and sa.HTTP_ADDR_PATH.read_text() == LOCAL + ":80",
      (changed, sa.HTTP_ADDR_PATH.read_text()))

setup(addr="192.168.0.50", port=1884, http="opennova.local:8080", server_ip="192.168.0.50")
changed = sa.write_server(LOCAL, 8080)
cfg = json.loads(sa.JSON_PATH.read_text())
check("all three point at the same IP", (cfg["mqtt"]["value"]["addr"], sa.HTTP_ADDR_PATH.read_text(),
      sa.SERVER_IP_PATH.read_text()) == (LOCAL, LOCAL + ":8080", LOCAL + "\n"),
      (cfg["mqtt"], sa.HTTP_ADDR_PATH.read_text(), sa.SERVER_IP_PATH.read_text()))
check("  ... a broker set by hand is replaced too (one server everywhere)", "mqtt_addr" in changed, changed)
check("  ... the broker port that was there stays", cfg["mqtt"]["value"]["port"] == 1884, cfg["mqtt"])
check("  ... wifi, lora and sn stay", all(k in cfg for k in ("sn", "wifi", "lora")), list(cfg))
check("  ... http_address.txt is host:port without a newline", not sa.HTTP_ADDR_PATH.read_text().endswith("\n"))
check("nothing differs afterwards, so nothing is written again", sa.write_server(LOCAL, 8080) == [])

setup(addr="mqtt.lfibot.com")
sa.write_server(LOCAL, 80)
check("the stock name is replaced by the server's IP",
      json.loads(sa.JSON_PATH.read_text())["mqtt"]["value"]["addr"] == LOCAL)

sa.JSON_PATH.write_text("{broken")
sa.HTTP_ADDR_PATH.write_text(CLOUD + ":80")
changed = sa.write_server(LOCAL, 80)
check("an unreadable json_config.json is left alone, the others are still written",
      sa.JSON_PATH.read_text() == "{broken" and sa.HTTP_ADDR_PATH.read_text() == LOCAL + ":80"
      and "mqtt_addr" not in changed, (sa.JSON_PATH.read_text(), changed))

# ── --once ───────────────────────────────────────────────────────────────────
setup(addr=LOCAL, http=CLOUD + ":80", server_ip=LOCAL)
sa.find_server = lambda state: None
check("--once with no OpenNova server: exit 1, nothing written",
      sa.main(["x", "--once"]) == 1 and sa.HTTP_ADDR_PATH.read_text() == CLOUD + ":80")


# ── answers_as_opennova, for real ────────────────────────────────────────────
class Health(http.server.BaseHTTPRequestHandler):
    body = b'{"server":"running","mqtt":"running"}'

    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(Health.body)

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), Health)
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
check("answers_as_opennova: OpenNova's health answer", sa.answers_as_opennova("127.0.0.1", port) is True)
Health.body = b"<html>404 Not Found</html>"
check("answers_as_opennova: some other web server", sa.answers_as_opennova("127.0.0.1", port) is False)
srv.shutdown()
srv.server_close()
check("accepts_connect: a closed port", sa.accepts_connect("127.0.0.1", port, timeout=0.5) is False)

print(f"\n{sum(checks)}/{len(checks)} checks ok")
raise SystemExit(0 if all(checks) else 1)
