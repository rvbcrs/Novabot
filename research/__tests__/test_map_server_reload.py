#!/usr/bin/env python3
"""map_server leest map.pgm alleen bij het opstarten, dus iemand moet hem porren.

Dit is de oorzaak waar map6 vijftien pogingen op stukliep. Gemeten op
LFIN2230700238 (2026-09-14, 17:03):

    map.pgm op schijf   (3.18, 4.23) over 0,55 m in elke richting vrij
    /map van map_server (3.18, 4.23) waarde 0 = vrij  (na een load_map)
    global costmap      (3.18, 4.23) cost 254 = lethal
    nav2                "Look like goal is occupied by obstacle" -> GOAL_COLLIDED

Het verschil was leeftijd, niet inhoud: de navigator draaide sinds 15:43, de
kaart was om 16:58 opengezet, en map_server had nooit opnieuw gelezen.

Run: python3 research/__tests__/test_map_server_reload.py
"""
import os
import sys
import time
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RESEARCH = os.path.dirname(HERE)

checks = []


def check(name, ok, detail=""):
    checks.append(ok)
    print(f"{'ok  ' if ok else 'FAIL'} {name}" + (f" | {detail}" if detail else ""))


# ---------------------------------------------------------------- reload gate

def load_daemon(calls):
    """seam_fix_daemon importeren met subprocess.run afgevangen."""
    import importlib.util
    import subprocess

    spec = importlib.util.spec_from_file_location(
        "seam_fix_daemon_under_test", os.path.join(RESEARCH, "seam_fix_daemon.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    class _Res:
        returncode = 0
        stdout = b"reload_nav_map: result=0\n"

    def fake_run(cmd, **kw):
        calls.append(cmd)
        return _Res()

    mod.subprocess = type("S", (), {"run": staticmethod(fake_run), "PIPE": subprocess.PIPE,
                                    "STDOUT": subprocess.STDOUT})
    return mod


def test_reload_fires_once_per_change():
    calls = []
    mod = load_daemon(calls)
    with tempfile.TemporaryDirectory() as base:
        mod.NAV_MAP_BASE = base
        pgm = os.path.join(base, "map.pgm")
        open(os.path.join(base, "map.yaml"), "w").write("image: map.pgm\n")
        open(pgm, "w").write("x")

        check("nieuwe kaart -> reload", mod.reload_nav_map(base) is True,
              f"{len(calls)} aanroep(en)")
        mod.reload_nav_map(base)
        mod.reload_nav_map(base)
        check("ongewijzigde kaart -> geen reload", len(calls) == 1,
              f"{len(calls)} aanroep(en) na drie rondes")

        os.utime(pgm, (time.time() + 10, time.time() + 10))
        mod.reload_nav_map(base)
        check("herschreven kaart -> weer een reload", len(calls) == 2,
              f"{len(calls)} aanroep(en)")

        check("roept map.yaml aan, niet map.pgm",
              calls[-1][-1].endswith("map.yaml"), calls[-1][-1])


def test_reload_survives_a_dead_map_server():
    """Geen map_server (tijdens mapping, tijdens een herstart) mag de daemon
    niet stilzetten: de obstakel- en kanaalinvarianten moeten blijven lopen."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "seam_fix_daemon_dead", os.path.join(RESEARCH, "seam_fix_daemon.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    def boom(cmd, **kw):
        raise OSError("map_server niet bereikbaar")

    mod.subprocess = type("S", (), {"run": staticmethod(boom), "PIPE": 1, "STDOUT": 2})
    with tempfile.TemporaryDirectory() as base:
        mod.NAV_MAP_BASE = base
        open(os.path.join(base, "map.yaml"), "w").write("image: map.pgm\n")
        open(os.path.join(base, "map.pgm"), "w").write("x")
        try:
            r = mod.reload_nav_map(base)
            check("dode map_server werpt niet door", r is False)
        except Exception as e:
            check("dode map_server werpt niet door", False, str(e))


def test_a_backup_map_never_reaches_map_server():
    """MAPS_GLOB matcht home0.bak.*, en een reload daarmee laadt een oude kaart
    in de draaiende navigatie. Live gebeurd: map_server stond na één ronde op
    home0.pre_map5_bak_1789115596."""
    calls = []
    mod = load_daemon(calls)
    with tempfile.TemporaryDirectory() as root:
        backup = os.path.join(root, "home0.bak.1782244327")
        os.makedirs(backup)
        open(os.path.join(backup, "map.yaml"), "w").write("image: map.pgm\n")
        open(os.path.join(backup, "map.pgm"), "w").write("x")
        check("backup-kaart wordt niet geladen",
              mod.reload_nav_map(backup) is False and not calls,
              f"{len(calls)} aanroep(en)")

        actief = os.path.join(root, "home0")
        os.makedirs(actief)
        open(os.path.join(actief, "map.yaml"), "w").write("image: map.pgm\n")
        open(os.path.join(actief, "map.pgm"), "w").write("x")
        mod.NAV_MAP_BASE = actief
        check("de actieve kaart wel", mod.reload_nav_map(actief) is True
              and len(calls) == 1, f"{len(calls)} aanroep(en)")


def test_missing_yaml_is_not_a_reload():
    calls = []
    mod = load_daemon(calls)
    with tempfile.TemporaryDirectory() as base:
        mod.NAV_MAP_BASE = base
        open(os.path.join(base, "map.pgm"), "w").write("x")
        check("geen map.yaml -> geen reload",
              mod.reload_nav_map(base) is False and not calls)


# ------------------------------------------------------- de kaart-check zelf

class _FakeGrid:
    """Een 10x10 kaart met resolutie 1 m, oorsprong (0,0)."""

    class _Info:
        resolution = 1.0
        width = 10
        height = 10

        class _Origin:
            class _Pos:
                x = 0.0
                y = 0.0
            position = _Pos()
        origin = _Origin()

    def __init__(self, occupied=()):
        self.info = self._Info()
        self.data = [0] * 100
        for (cx, cy) in occupied:
            self.data[cy * 10 + cx] = 100


def map_blocked(grid, pts):
    """Zelfde rekenwerk als Driver.map_blocked, los van rclpy."""
    res = grid.info.resolution
    ox = grid.info.origin.position.x
    oy = grid.info.origin.position.y
    w, h = grid.info.width, grid.info.height
    bad = []
    for (x, y) in pts:
        cx, cy = int((x - ox) / res), int((y - oy) / res)
        if not (0 <= cx < w and 0 <= cy < h):
            bad.append(((x, y), "buiten de kaart"))
        elif grid.data[cy * w + cx] != 0:
            bad.append(((x, y), "waarde %d" % grid.data[cy * w + cx]))
    return bad


def test_map_blocked_finds_the_occupied_cell():
    grid = _FakeGrid(occupied=[(3, 4)])
    check("vrij punt is vrij", map_blocked(grid, [(1.5, 1.5)]) == [])
    bad = map_blocked(grid, [(3.5, 4.5)])
    check("bezet punt wordt gevonden", len(bad) == 1 and "100" in bad[0][1],
          str(bad))
    bad = map_blocked(grid, [(99.0, 99.0)])
    check("punt buiten de kaart wordt gevonden",
          len(bad) == 1 and bad[0][1] == "buiten de kaart", str(bad))


def test_the_disk_and_the_planner_can_disagree():
    """De kern van de fout: op schijf vrij is geen bewijs dat de planner het
    vrij vindt. Alleen wat er op /map staat telt."""
    op_schijf_vrij = True
    planner = _FakeGrid(occupied=[(3, 4)])         # map_server heeft nog de oude
    bad = map_blocked(planner, [(3.18, 4.23)])
    check("schijf vrij maar planner bezet wordt opgemerkt",
          op_schijf_vrij and len(bad) == 1,
          "precies de situatie van 17:03 op .244")


def test_the_reload_script_ships_with_the_firmware():
    """De daemon roept reload_nav_map.py aan bij elke kaartwijziging. Zit het
    niet in het pakket, dan wijst die aanroep naar een bestand dat er niet is en
    plant nav2 stil door op de kaart van het opstarten."""
    build = open(os.path.join(RESEARCH, "build_custom_firmware.sh")).read()
    check("buildscript kopieert reload_nav_map.py",
          'cp "$RELOAD_SRC" "$NOVABOT_ROOT/scripts/reload_nav_map.py"' in build)
    check("en maakt hem uitvoerbaar",
          'chmod +x "$NOVABOT_ROOT/scripts/reload_nav_map.py"' in build)


def main():
    test_the_reload_script_ships_with_the_firmware()
    test_reload_fires_once_per_change()
    test_reload_survives_a_dead_map_server()
    test_a_backup_map_never_reaches_map_server()
    test_missing_yaml_is_not_a_reload()
    test_map_blocked_finds_the_occupied_cell()
    test_the_disk_and_the_planner_can_disagree()
    print(f"\n{sum(checks)}/{len(checks)} checks ok")
    return 0 if all(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
