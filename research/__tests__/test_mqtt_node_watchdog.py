#!/usr/bin/env python3
"""Een mqtt_node die draait maar nooit verbindt hoort herstart te worden.

Live op LFIN1231000009 (2026-09-14): één mqtt_node, zeventien uur oud, geen
enkele verbinding, onafgebroken MQTT_EVENT_INIT_NET_ERROR. Op datzelfde moment
lukte een verbinding vanaf die maaier naar die broker in 0,05 s. Hij was bij het
opstarten blijven hangen en kwam daar niet zelf uit.

De maaier meldde zich wel online, want extended_commands.py heeft een eigen
MQTT-client. De gebruiker zag een maaier die er was en toch niet op de kaart
stond. Elke waakhond keek langs dit geval heen: de monitor telde alleen dubbele
processen.

Run: python3 research/__tests__/test_mqtt_node_watchdog.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(os.path.dirname(HERE), "build_custom_firmware.sh")

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" | {detail}" if detail else ""))


def monitor_source():
    src = open(BUILD).read()
    m = re.search(r"cat > \"\$NOVABOT_ROOT/scripts/mqtt_node_monitor\.sh\" << 'MQTTMON'\n(.*?)\nMQTTMON\n",
                  src, re.S)
    assert m, "mqtt_node_monitor niet gevonden"
    return m.group(1)


def main():
    src = monitor_source()

    check("herkent een proces zonder verbinding", "mqtt_connected" in src)
    check("kijkt naar een ESTABLISHED socket op 1883",
          "ESTAB" in src and "1883" in src)
    check("en koppelt die aan mqtt_node zelf, niet aan zomaar een proces",
          "grep -q mqtt_node" in src,
          "anders telt de python-client van extended_commands mee, en die "
          "verbindt juist wel")

    # Geduld bij het opstarten: een verse mqtt_node heeft even nodig.
    m = re.search(r"STALE_CHECKS=(\d+)", src)
    check("wacht eerst af", m is not None and int(m.group(1)) >= 6,
          f"{int(m.group(1)) * 10}s geduld" if m else "")

    # Geen herstartlus wanneer de server echt weg is.
    b = re.search(r"RESTART_BACKOFF_S=(\d+)", src)
    check("herstart hoogstens af en toe", b is not None and int(b.group(1)) >= 300,
          f"minimaal {int(b.group(1))}s tussen herstarts" if b else "")

    check("de teller reset zodra er wél verbinding is", "no_conn=0" in src)
    check("het oude gedrag blijft: dubbele processen opruimen",
          "killed duplicate PID" in src)

    # Dit is de belofte aan Ramon: de zelfontdekking blijft ongemoeid.
    check("raakt de configuratie niet aan",
          "json_config" not in src and "server_ip.txt" not in src,
          "het vinden van een server blijft het werk van opennova_discovery.py")
    check("schrijft wat hij deed in het log", 'LOG"' in src)

    print(f"\n{sum(checks)}/{len(checks)} checks ok")
    return 0 if all(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
