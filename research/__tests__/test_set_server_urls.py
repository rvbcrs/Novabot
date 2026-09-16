#!/usr/bin/env python3
"""set_server_urls.sh mag nooit een adres schrijven dat mqtt_node niet kan gebruiken.

Live 2026-09-16 op LFIN1231000009: server in Docker bridge, opennova.local
resolvet niet op de maaier, script schreef toch `opennova.local:8080`
(hostname onoplosbaar EN fallback-poort van Ramons eigen setup). Stock
mqtt_node POST't daar zijn netcheck heen, faalt, en blijft voor altijd in
MQTT_EVENT_INIT_NET_ERROR: maaier nooit online, versie stale in het dashboard.

Regels:
  - resolvet opennova.local niet, schrijf het IP (DNS-omleiding app.lfibot.com
    of last-known server_ip.txt), nooit de hostname
  - fallback-poort is 80 (Docker default), nooit 8080

Run: python3 research/__tests__/test_set_server_urls.py
"""
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
    # unescaped build-time vars
    body = body.replace("${SERVER_HOST}", "novabot.local").replace("${SERVER_HTTP_PORT}", "80").replace("${MQTT_PORT}", "1883")
    # escaped runtime vars: heredoc without quotes → \$ wordt $
    body = body.replace("\\$", "$")
    return body


def run(resolves, dns_ip, last_known, ports_open):
    """Draai het script met een nep-getent en nep-probe. Geeft (http_address, log)."""
    tmp = tempfile.mkdtemp()
    root = os.path.join(tmp, "userdata")
    os.makedirs(os.path.join(root, "lfi"))
    os.makedirs(os.path.join(root, "ota"))
    body = extract_script().replace("/userdata", root)
    # geen mDNS SRV, geen ip/nmcli/avahi rommel
    body = body.replace("SRV_PORT=\"$(discover_port)\"", "SRV_PORT=\"\"")
    body = body.replace("ip addr show wlan0 2>/dev/null | grep -q 'inet '", "true")
    body = re.sub(r"^ip .*$", "true", body, flags=re.M)
    body = re.sub(r"^\s*(pkill|kill) .*$", "true", body, flags=re.M)
    body = re.sub(r"^avahi-set-host-name .*$", "true", body, flags=re.M)
    body = re.sub(r"^hostnamectl .*$", "true", body, flags=re.M)
    body = re.sub(r"^systemctl .*$", "true", body, flags=re.M)
    # probe_http → open-ports lijst
    body = re.sub(r"probe_http\(\) \{.*?\nPROBE_EOF\n\}", 'probe_http() { case " $PROBE_OPEN " in *" $1:$2 "*) return 0;; esac; return 1; }', body, flags=re.S)
    if last_known:
        open(os.path.join(root, "lfi", "server_ip.txt"), "w").write(last_known)
    bindir = os.path.join(tmp, "bin")
    os.makedirs(bindir)
    with open(os.path.join(bindir, "getent"), "w") as f:
        f.write("#!/bin/bash\n")
        f.write('[ "$2" = opennova.local ] && { %s; }\n' % ("echo '%s opennova.local'; exit 0" % resolves if resolves else "exit 2"))
        f.write('[ "$2" = app.lfibot.com ] && { %s; }\n' % ("echo '%s app.lfibot.com'; exit 0" % dns_ip if dns_ip else "exit 2"))
        f.write("exit 2\n")
    os.chmod(os.path.join(bindir, "getent"), 0o755)
    script = os.path.join(tmp, "s.sh")
    open(script, "w").write(body)
    env = dict(os.environ, PATH=bindir + ":" + os.environ["PATH"], PROBE_OPEN=" ".join(ports_open))
    subprocess.run(["bash", script], env=env, cwd=tmp, capture_output=True, timeout=60)
    addr = open(os.path.join(root, "lfi", "http_address.txt")).read()
    log = open(os.path.join(root, "ota", "custom_firmware.log")).read()
    return addr, log


src = open(BUILD).read()
check("default SERVER_HTTP_PORT is 80, niet 8080", re.search(r'^SERVER_HTTP_PORT="80"', src, re.M) is not None)

# 1. Aaron: bridge-Docker, DNS-omleiding werkt, server op 80
addr, log = run(resolves=None, dns_ip="192.168.1.100", last_known=None, ports_open=["192.168.1.100:80"])
check("mDNS dood + DNS-omleiding → IP:80", addr == "192.168.1.100:80")
check("  ... en dat staat in het log", "lost niet op" in log)

# 2. mDNS dood, geen DNS-omleiding, wel last-known
addr, _ = run(resolves=None, dns_ip=None, last_known="192.168.1.50\n", ports_open=["192.168.1.50:80"])
check("mDNS dood + last-known → last-known IP:80", addr == "192.168.1.50:80")

# 3. mDNS dood, niets bekend, geen poort bereikbaar → fallback 80, nooit 8080
addr, _ = run(resolves=None, dns_ip=None, last_known=None, ports_open=[])
check("niets bekend → fallback poort 80", addr.endswith(":80") and ":8080" not in addr)

# 4. mDNS werkt: hostname blijft (server kan van IP wisselen)
addr, _ = run(resolves="192.168.0.222", dns_ip="192.168.0.222", last_known=None, ports_open=["opennova.local:80"])
check("mDNS ok → hostname:80", addr == "opennova.local:80")

# 5. mDNS werkt, Ramon-setup op 8080: probe vindt 8080 als 80 dicht is
addr, _ = run(resolves="192.168.0.247", dns_ip=None, last_known=None, ports_open=["opennova.local:8080"])
check("mDNS ok, alleen 8080 open → hostname:8080", addr == "opennova.local:8080")

failed = [n for n, ok in checks if not ok]
print("\n%d/%d ok" % (len(checks) - len(failed), len(checks)))
sys.exit(1 if failed else 0)
