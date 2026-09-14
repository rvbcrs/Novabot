#!/usr/bin/env python3
"""Alles wat op de maaier draait moet ook in het pakket zitten.

Elk bestand dat met de hand op een maaier is neergezet en niet in
build_custom_firmware.sh staat, verdwijnt bij de volgende flash. Dat is niet
theoretisch: reload_nav_map.py ontbrak, en een firmware daaruit had een daemon
geïnstalleerd die een niet-bestaand script aanriep, waarna nav2 stilletjes weer
op de kaart van het opstarten zou plannen.

Run: python3 research/__tests__/test_firmware_packaging.py
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)
BUILD = os.path.join(RESEARCH, "build_custom_firmware.sh")

# Wat er op LFIN2230700238 in /root/novabot/scripts staat en van ons is.
# obdCheck.py staat er ook maar is stock (2023, wordt nergens gestart).
ONZE_SCRIPTS = [
    "auto_map_node.py", "camera_stream.py", "extended_commands.py",
    "lawn_edge_relay.py", "led_bridge.py", "mow_zone_drive.py",
    "opennova_discovery.py", "pin_verify_ros2.py", "reload_nav_map.py",
    "seam_fix_daemon.py", "terrain_scan.py", "unicom_mirror.py",
    "start_ext.sh",
]

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" | {detail}" if detail else ""))


def main():
    build = open(BUILD).read()

    for f in ONZE_SCRIPTS:
        bestaat = os.path.exists(os.path.join(RESEARCH, f))
        verpakt = f in build
        check(f"{f}", bestaat and verpakt,
              ("" if bestaat else "niet in research/ ")
              + ("" if verpakt else "niet in het buildscript"))

    # De mempool-ladder is de wijziging die het zwaarst weegt: zonder nieuwe
    # firmware heeft alleen de maaier waar hij met de hand op staat hem.
    m = re.search(r'cat > "\$SHM_TOML" << \'SHMEOF\'\n(.*?)\nSHMEOF\n', build, re.S)
    check("buildscript schrijft de mempool-config", m is not None)
    if m:
        sizes = [int(x) for x in re.findall(r"size\s*=\s*(\d+)", m.group(1))]
        check("met een pool klein genoeg voor een tf-transform",
              bool(sizes) and min(sizes) <= 128, f"kleinste {min(sizes) if sizes else '?'}")

    # De migratiehaken.
    check("preinst zit in het pakket", 'DEBIAN/preinst' in build)
    check("postinst zit in het pakket", 'DEBIAN/postinst' in build)
    check("postinst legt /root/start_ext.sh aan", 'LINK=/root/start_ext.sh' in build)

    print(f"\n{sum(checks)}/{len(checks)} checks ok")
    return 0 if all(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
