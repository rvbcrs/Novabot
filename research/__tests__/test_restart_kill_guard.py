#!/usr/bin/env python3
"""Guard rail for _restart_novabot_mapping() in research/extended_commands.py.

Every process pattern that restart uses also appears in the command line of the
shell that runs it, because the same shell relaunches those nodes further down.
So `pkill -f <pattern>`, and any bare loop over `pgrep -f <pattern>`, finds that
shell and kills it halfway: the node dies, the relaunch never happens, and the
mower answers error 140 on the next map change. That happened twice on
2026-09-12 before the self-guard went in, hours apart, each time in a different
form. This check keeps the guard in place.

Run: python3 research/__tests__/test_restart_kill_guard.py
"""
import importlib.util
import inspect
import os
import re

spec = importlib.util.spec_from_file_location(
    "ec", os.path.join(os.path.dirname(__file__), "..", "extended_commands.py"))
ec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ec)

SOURCE = inspect.getsource(ec._restart_novabot_mapping)
# Comments explain the trap and mention pkill by name; only the code matters.
CODE = "\n".join(l for l in SOURCE.splitlines() if not l.lstrip().startswith("#"))


def test_no_pkill_anywhere():
    # pkill -f self-matches; pkill -x misses the truncated 15-char comm.
    assert "pkill" not in CODE, "pkill cannot target these nodes safely"


def test_kills_go_through_the_guarded_helper():
    # One helper, and it skips this shell and its parent.
    assert re.search(r'k\(\)\s*\{', CODE), "the guarded kill helper is gone"
    assert '[ "$p" = "$$" ]' in CODE, "self-pid guard is gone"
    assert '[ "$p" = "$PPID" ]' in CODE, "parent-pid guard is gone"


def test_no_kill_outside_the_helper():
    # Any `kill` call in the command string must be the one inside k().
    kills = [l for l in CODE.splitlines() if re.search(r'\bkill\b', l)]
    assert kills, "no kill at all — the restart would not replace anything"
    for line in kills:
        assert '"$p" = "$$"' in line, f"unguarded kill: {line.strip()}"


def test_binaries_are_killed_by_path_not_by_name():
    # comm is capped at 15 chars, so "coverage_planner_server" never matches -x.
    assert "lib/coverage_planner/coverage_planner_server" in CODE
    assert "lib/novabot_mapping/novabot_mapping" in CODE


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all restart-guard checks passed")
