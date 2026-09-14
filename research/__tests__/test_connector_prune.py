#!/usr/bin/env python3
"""A channel the server no longer sends must disappear from the mower.

handle_write_map_files wipes csv_file/ and rewrites it, but kept every
`*_unicom.csv` the caller did not provide, as long as both zones it links still
existed. That was right in June 2026, when the server did not manage channels
and a bare wipe disconnected the zones ("the channels keep disappearing").

Since the canonical naming of September 2026 the server DOES manage them, and
the same rule turned into its opposite: a deleted channel was faithfully put
back on every sync, so removing one had no effect at all - not even with force
(live LFIN2230700238, 2026-09-14). A server that knows it ships the complete
set says so with prune_connectors; without the flag the old behaviour stands,
so an older server loses nothing.

Run: python3 research/__tests__/test_connector_prune.py
"""
import re

# De regel zoals hij in handle_write_map_files staat, nagebouwd zodat hij
# checkbaar is zonder de ROS-stack van de maaier.


def survives(fname, provided, prune_connectors):
    if prune_connectors:
        return False
    surviving = {m.group(1) for m in
                 (re.match(r"^map(\d+)_work\.csv$", k) for k in provided) if m}
    m = re.match(r"^map(\d+)to(?:map(\d+)|charge)", fname)
    if not m or m.group(1) not in surviving:
        return False
    return m.group(2) is None or m.group(2) in surviving


PROVIDED = {"map0_work.csv": "", "map1_work.csv": "", "map0tomap1_0_unicom.csv": ""}


def test_a_deleted_channel_is_gone_when_the_server_owns_the_set():
    assert survives("map1tomap0_0_unicom.csv", PROVIDED, prune_connectors=True) is False
    assert survives("map0tocharge_unicom.csv", PROVIDED, prune_connectors=True) is False


def test_without_the_flag_the_old_protection_still_holds():
    # Een oudere server stuurt de vlag niet en mag zijn kanalen niet kwijtraken.
    assert survives("map1tomap0_0_unicom.csv", PROVIDED, prune_connectors=False) is True
    assert survives("map0tocharge_unicom.csv", PROVIDED, prune_connectors=False) is True


def test_an_orphaned_connector_goes_either_way():
    # map9 bestaat niet meer: dan is het kanaal sowieso wees en mag het weg.
    assert survives("map9tomap0_0_unicom.csv", PROVIDED, prune_connectors=False) is False
    assert survives("map0tomap9_0_unicom.csv", PROVIDED, prune_connectors=False) is False


def test_the_handler_really_reads_the_flag():
    src = open(__file__.rsplit("/", 2)[0] + "/extended_commands.py").read()
    blok = src[src.index("def handle_write_map_files("):src.index("def handle_regenerate_per_map_files(")]
    assert 'params or {}).get("prune_connectors")' in blok, "vlag wordt niet gelezen"
    assert "if prune_connectors:\n                return False" in blok, \
        "vlag wordt gelezen maar niet toegepast in _connector_survives"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn(); print(f"ok  {name}")
    print("all connector-prune checks passed")
