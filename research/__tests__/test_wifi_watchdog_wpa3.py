"""GH #185: wifi_watchdog.sh turns a WPA3 (sae) WiFi profile into wpa-psk once.

Runs the block from the builder's heredoc against a fake nmcli that records
its calls. Run: python3 research/__tests__/test_wifi_watchdog_wpa3.py
"""
import os
import pathlib
import subprocess
import tempfile

BUILDER = pathlib.Path(__file__).resolve().parents[1] / "build_custom_firmware.sh"

FAKE_NMCLI = """#!/bin/bash
echo "$*" >> "$CALLS"
case "$*" in
  "-t -f UUID,TYPE connection show") printf 'aaa:802-11-wireless\\nbbb:802-3-ethernet\\nccc:802-11-wireless\\n' ;;
  "-g 802-11-wireless-security.key-mgmt connection show aaa") echo sae ;;
  "-g 802-11-wireless-security.key-mgmt connection show ccc") echo wpa-psk ;;
esac
"""


def watchdog_block() -> str:
    text = BUILDER.read_text()
    start = text.index("        # WPA3 (GH #185)")
    end = text.index("        done\n", start) + len("        done\n")
    return text[start:end]


def test_sae_profile_becomes_wpa_psk():
    with tempfile.TemporaryDirectory() as d:
        nmcli = pathlib.Path(d, "nmcli")
        nmcli.write_text(FAKE_NMCLI)
        nmcli.chmod(0o755)
        calls = pathlib.Path(d, "calls")
        env = dict(os.environ, PATH=f"{d}:{os.environ['PATH']}", CALLS=str(calls))
        script = f'LOG="{d}/log"\n' + watchdog_block()
        subprocess.run(["bash", "-c", script], env=env, check=True)
        got = calls.read_text().splitlines()
    assert "connection modify aaa 802-11-wireless-security.key-mgmt wpa-psk" in got
    assert "connection up aaa" in got
    # The WPA2 profile and the ethernet profile are left alone.
    assert not any(c.startswith(("connection modify ccc", "connection up ccc", "connection modify bbb")) for c in got)
    assert not any("connection show bbb" in c for c in got)


if __name__ == "__main__":
    test_sae_profile_becomes_wpa_psk()
    print("ok")
