#!/usr/bin/env python3
"""Een upgrade mag de seam-fix van een bestaande maaier niet uitzetten.

De daemon in de repo is opt-in en staat standaard UIT. De variant die op
LFIN2231000633 draait is ouder dan de schakelaar in de app en staat altijd aan;
die maaier heeft dus geen seam_fix.json. Zonder migratie zet een release zijn
seam-fix uit, blijft de bezette streep die de firmware binnen het gazon tekent
staan, en antwoordt nav2 op elk doel met "GridBased_AStar failed to generate a
valid path" tot de maaier terugrijdt naar het dock. Live gebeurd 2026-06-22.

Run: python3 research/__tests__/test_seam_fix_migration.py
"""
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "..", "build_custom_firmware.sh")
DAEMON = os.path.join(HERE, "..", "seam_fix_daemon.py")

ALTIJD_AAN = '''#!/usr/bin/env python3
"""De oude variant: geen schakelaar, seam-fix loopt altijd."""
def fix_one(base):
    pass
def main():
    while True:
        fix_one("/userdata/lfi/maps/home0")
'''

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" | {detail}" if detail else ""))


def preinst_script():
    src = open(BUILD).read()
    m = re.search(r"cat > \"\$WORK_DIR/DEBIAN/preinst\" << 'PREINST'\n(.*?)\nPREINST\n", src, re.S)
    assert m, "preinst niet gevonden in build_custom_firmware.sh"
    return m.group(1)


def draai(root, oude_daemon: str | None, bestaande_cfg: str | None):
    """Draai het preinst-script tegen een nagebootste maaier."""
    script = preinst_script()
    # De paden in het script zijn absoluut; hier onder een tijdelijke root zetten.
    script = script.replace("/userdata/lfi", f"{root}/userdata/lfi")
    script = script.replace("/root/novabot/scripts", f"{root}/root/novabot/scripts")
    os.makedirs(f"{root}/root/novabot/scripts", exist_ok=True)
    if oude_daemon is not None:
        open(f"{root}/root/novabot/scripts/seam_fix_daemon.py", "w").write(oude_daemon)
    if bestaande_cfg is not None:
        os.makedirs(f"{root}/userdata/lfi", exist_ok=True)
        open(f"{root}/userdata/lfi/seam_fix.json", "w").write(bestaande_cfg)
    r = subprocess.run(["sh", "-c", script], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    cfg = f"{root}/userdata/lfi/seam_fix.json"
    return (open(cfg).read() if os.path.exists(cfg) else None), r.stdout


def test_always_on_mower_keeps_its_seam_fix():
    with tempfile.TemporaryDirectory() as root:
        cfg, out = draai(root, ALTIJD_AAN, None)
        check("altijd-aan maaier krijgt een config", cfg is not None)
        check("en die staat aan", bool(cfg) and '"enabled": true' in cfg, (cfg or "").strip())
        check("en zegt wat hij deed", "overgenomen" in out, out.strip())


def test_a_fresh_mower_stays_default_off():
    """Een maaier zonder seam-fix daemon hoort niets te krijgen: de schakelaar
    staat standaard uit en dat blijft zo."""
    with tempfile.TemporaryDirectory() as root:
        cfg, _ = draai(root, None, None)
        check("verse maaier krijgt geen config", cfg is None)


def test_an_existing_choice_is_never_overwritten():
    with tempfile.TemporaryDirectory() as root:
        cfg, _ = draai(root, ALTIJD_AAN, '{"enabled": false, "edge_margin_cm": 5}')
        check("bestaande keuze blijft staan",
              cfg is not None and '"enabled": false' in cfg, (cfg or "").strip())


def test_a_mower_already_on_the_opt_in_daemon_is_left_alone():
    """Draait de opt-in versie al, dan is de schakelaar al in gebruik en mag de
    upgrade er niet alsnog een aan-stand in schrijven."""
    with tempfile.TemporaryDirectory() as root:
        cfg, _ = draai(root, open(DAEMON).read(), None)
        check("opt-in maaier krijgt geen config", cfg is None)


def test_the_repo_daemon_really_is_the_opt_in_one():
    """De migratie herkent de oude variant aan het ontbreken van _read_config.
    Hernoemen we die functie ooit, dan valt deze test om in plaats van de
    migratie stilletjes op iedereen te vuren."""
    src = open(DAEMON).read()
    check("repo-daemon heeft _read_config", "_read_config" in src)
    check("en is opt-in met standaard uit",
          'c.get("enabled", False)' in src)


def main():
    test_always_on_mower_keeps_its_seam_fix()
    test_a_fresh_mower_stays_default_off()
    test_an_existing_choice_is_never_overwritten()
    test_a_mower_already_on_the_opt_in_daemon_is_left_alone()
    test_the_repo_daemon_really_is_the_opt_in_one()
    print(f"\n{sum(checks)}/{len(checks)} checks ok")
    return 0 if all(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
