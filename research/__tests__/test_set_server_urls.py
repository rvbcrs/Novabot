#!/usr/bin/env python3
"""set_server_urls.sh leaves every server address to server_address.py (GH #170).

It used to decide the addresses itself: with opennova.local not resolving it
wrote the unchecked app.lfibot.com answer into http_address.txt, which without
a DNS redirect is the cloud (47.253.145.99:80 live on LFIN2231000451) while the
broker was the local server. Now one rule (server_address.py) finds the server
and writes all three addresses; this script runs it once at boot and after
sync_map, and keeps only its json_config.json safety: backups, the tz default
and restoring lost sections.

Run: python3 research/__tests__/test_set_server_urls.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "build_custom_firmware.sh")

checks = []


def check(name, ok):
    checks.append((name, ok))
    print(("ok   " if ok else "FAIL ") + name)


def extract_script():
    src = open(BUILD).read()
    m = re.search(r'cat > "\$NOVABOT_ROOT/scripts/set_server_urls.sh" << URLSCRIPT\n(.*?)\nURLSCRIPT\n', src, re.S)
    body = m.group(1)
    body = body.replace("${SERVER_HOST}", "novabot.local").replace("${SERVER_HTTP_PORT}", "80").replace("${MQTT_PORT}", "1883")
    return body.replace("\\$", "$")


def run(cfg=None, backup=None):
    """Run the script with a stub server_address.py. Returns (json_config or None, log, stub calls)."""
    tmp = tempfile.mkdtemp()
    root = os.path.join(tmp, "userdata")
    os.makedirs(os.path.join(root, "lfi"))
    os.makedirs(os.path.join(root, "ota"))
    calls = os.path.join(tmp, "calls")
    stub = os.path.join(tmp, "server_address.py")
    with open(stub, "w") as f:
        f.write("import sys\nopen(%r, 'a').write(' '.join(sys.argv[1:]) + '\\n')\nprint('server 192.168.178.228 (http 80, mqtt 1883): unchanged')\n" % calls)
    body = extract_script().replace("/userdata", root).replace("/root/novabot/scripts/server_address.py", stub)
    body = body.replace("ip addr show wlan0 2>/dev/null | grep -q 'inet '", "true")
    body = re.sub(r"^ip .*$", "true", body, flags=re.M)
    body = re.sub(r"^\s*(pkill|kill|systemctl|hostname) .*$", "true", body, flags=re.M)
    cfg_path = os.path.join(root, "lfi", "json_config.json")
    if cfg is not None:
        json.dump(cfg, open(cfg_path, "w"))
    if backup is not None:
        json.dump(backup, open(cfg_path + ".bak", "w"))
    script = os.path.join(tmp, "s.sh")
    open(script, "w").write(body)
    subprocess.run(["bash", script], cwd=tmp, capture_output=True, timeout=60)
    out = json.load(open(cfg_path)) if os.path.exists(cfg_path) else None
    log = open(os.path.join(root, "ota", "custom_firmware.log")).read()
    return out, log, open(calls).read().split("\n")[:-1] if os.path.exists(calls) else []


CFG = {"sn": {"set": 1, "value": {"code": "LFIN2231000451"}},
       "wifi": {"set": 1, "value": {"ssid": "home"}},
       "lora": {"set": 1, "value": {"addr": 718, "channel": 17}},
       "mqtt": {"set": 1, "value": {"addr": "192.168.0.50", "port": 1884}}}

body = extract_script()
check("the script no longer resolves names itself (the unchecked app.lfibot.com answer, GH #170)",
      "getent hosts" not in body)
check("  ... nor writes http_address.txt or server_ip.txt itself",
      "HTTP_ADDR_FILE" not in body and "LAST_KNOWN_FILE" not in body)

cfg, log, calls = run(cfg=dict(CFG))
check("server_address.py --once runs exactly once", calls == ["--once"])
check("  ... and its answer is in the log", "server 192.168.178.228" in log)
check("the broker is left to server_address.py (the script does not touch it)",
      cfg["mqtt"]["value"] == {"addr": "192.168.0.50", "port": 1884})
check("wifi, lora and sn stay", all(k in cfg for k in ("sn", "wifi", "lora")))
check("the tz default is filled in", cfg.get("config", {}).get("value", {}).get("tz") == "Europe/Amsterdam")

# Fewer than two of sn/wifi/lora left: the rolling backup is not refreshed
# from it, and the lost sections come back from .bak.
lost = {k: v for k, v in CFG.items() if k not in ("wifi", "lora")}
cfg, log, _ = run(cfg=lost, backup=dict(CFG))
check("sections lost from json_config.json come back from the backup", "wifi" in cfg and "lora" in cfg)

cfg, log, calls = run(cfg=None)
check("no json_config.json at all: nothing is invented, server_address.py still runs",
      cfg is None and calls == ["--once"])

failed = [n for n, ok in checks if not ok]
print("\n%d/%d ok" % (len(checks) - len(failed), len(checks)))
sys.exit(1 if failed else 0)
