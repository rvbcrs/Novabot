# Multi-map mowing: how `area` (`map_ids`) is decoded into multiple maps

**Status:** FIRMWARE-PROVEN (decompile + objdump, 2026-06-19). Confidence: HIGH.

## TL;DR

The Novabot firmware **natively supports mowing multiple maps from a single
`start_navigation` command**, by interpreting the integer `area` field as a
**decimal place-value code**, not a single-value lookup:

- position 0 (units digit, ×1)   = `map0`
- position 1 (tens digit, ×10)    = `map1`
- position 2 (hundreds digit, ×100) = `map2`  ← **100, NOT 200**
- combos: `11` = map0+map1, `101` = map0+map2, `111` = map0+map1+map2

For each **non-zero decimal digit position N**, the firmware adds `mapN` to a
coverage task queue and mows them back-to-back. It only docks **after the last
map** — no docking between zones. This is a downstream feature of the
`robot_decision` binary; `mqtt_node` passes `area` through verbatim.

> The mechanism is **decimal positional**, not literally a base-2 bitmask. It
> behaves like the user's "bitmask" description (each position selects a map),
> but the per-digit value can be >1 — only digit==0 means "skip this map".

## Pipeline

```
app/server  --MQTT start_navigation {area:N}-->  mqtt_node
mqtt_node    : area -> StartCoverageTask_Request.map_ids (uint32), request_type=11
             : ONE call to /robot_decision/start_cov_task  (no decode here)
robot_decision::handleStartCoverageTask : map_ids -> member +0xd64
robot_decision::coverRequestDataInit    : DECODE map_ids digit-by-digit -> vector<CovTaskInfo>
robot_decision::generateCoverPathDeal   : per map -> coverage_planner CoveragePathsByFile
robot_decision::coverFinishedDeal       : map FINISHED -> index++ -> coverStartDeal (next map)
                                          : after last map -> "Finished all task" -> rechargeDeal
```

## Evidence

### 1. mqtt_node does NOT decode — passes `area` verbatim
`research/ghidra_output/mqtt_node_decompiled.c`, `api_start_navigation` (0x2f2170, line 347625):

- L347740-347742: `operator[](...,"area"); asInt(); printf("area =%d")` — single int read
- L347749: `*(undefined4 *)(this + 0x14) = uVar10;` — area written directly into
  `StartCoverageTask_Request` field at +0x14 (= `map_ids`, uint32). No `%10`, no
  `/10`, no loop, no compare vs 1/10/100/11/111.
- L347738: `this[0x11] = 0xb` → `request_type = 11` (= "普通启动 / normal mqtt/app start")
- L347862-347869: exactly ONE `async_send_request` to `/robot_decision/start_cov_task`.

So the multi-map logic is NOT in mqtt_node.

### 2. StartCoverageTask schema
`research/ros2_msg_definitions/decision_msgs/srv/StartCoverageTask.srv`:
```
uint8  cov_mode          # 0 NORMAL, 1 SPECIFIED_AREA, 2 BOUNDARY_COV
uint8  request_type      # 11 normal mqtt/app start ...
uint32 map_ids           # 割草地图_id，当map_id大于0时优先使用这个，兼容旧的格式接口
string[] map_names       # 指定地图
geometry_msgs/Point[] polygon_area
uint8[]  blade_heights
...
```
`map_ids` comment = "mowing map id; when map_id>0 use this preferentially;
**compatible with the OLD format interface**" → it is a legacy encoded scalar.

### 3. robot_decision binary
`research/firmware/mower_firmware_v6.0.2/install/compound_decision/lib/compound_decision/robot_decision`
ARM64 ELF, NOT stripped, 6.3 MB. Identical symbol addresses in the 6.0.3 build.
Source path baked in: `/root/novabot/src/decision/compound_decision/src/main.cpp`.

Key strings (all present in the binary):
- `"Map ids %u"`  (VA 0x2710a0)
- `"Request map id:  %d"`  (VA 0x270730)
- `"Finished all task, request map num: %d  total area: %.1f"`  (VA 0x274850)
- `"Map number is different from blade height size"`  (VA 0x270e20)
- `"map"`  (VA 0x272500) — base prefix
- `"%u"`  (VA 0x2710a8) — digit-index format

### 4. handleStartCoverageTask (0x69a78) — stash only
`objdump -d` of robot_decision:
- 0x69c1c: copies `map_names` -> member +0xd68
- 0x69c34/0x69c38: `ldr w2,[x21,#0x4]; str w2,[x19,#0xd64]` → request `map_ids` -> member **+0xd64**
- 0x69c50: copies `blade_heights` -> member +0xd98
- 0x69c3c/0x69c48/0x69c54: `vector::operator=` for map_names/polygon_area/blade_heights
- NO arithmetic (no udiv/msub/mul, no cmp #0xa). Just stores fields.

### 5. coverRequestDataInit (0x848e8) — THE DECODER (decimal digits)
Branch selecting decode mode (0x84a34):
```
84a34: ldr w0,[x21,#0xd64]   ; map_ids
84a48: cbz w2,0x84b44        ; if map_ids==0  -> use explicit map_names[] path
84a4c: cmp x0,x1 / b.ne ...  ; else if map_names non-empty -> use that
                              ; else -> digit-extraction loop
```
Digit loop (counter w19 = position, bound `cmp w19,#0x1e` = up to 30):
- 0x84e74/0x84e7c: `adrp x24,0x271000; add x24,#0xa8` → x24 = "%u"
- 0x84e78/0x84e80: `adrp x25,0x272000; add x25,#0x500` → x25 = "map"
- 0x84e98-0x84ea4: `__to_xstring(...,"%u",w19)` → render position as string
- 0x84eb0/0x84ebc: `_M_replace(...,"map",3)` → build name = `"map"+pos` = map0/map1/map2…
- 0x84e54/0x84e68: `access(path)` → check map file exists
- 0x84f10/0x84f18: `string::find(...)` → membership test; if found jump to 0x85100
- **0x85100-0x8514c: DIGIT EXTRACTION**
  ```
  85100: scvtf d1,w19          ; (double)position
  85104: fmov  d0,#10.0
  85108: bl    pow             ; placevalue = pow(10, position) = 1,10,100,...
  85128: fcvtzu w1,d0          ; w1 = placevalue
  85134: udiv  w2,w2,w1        ; value / placevalue
  85138: umull x0,w2,0xcccccccd
  8513c: lsr   x0,x0,#35       ; /10
  85140: add   w0,w0,w0,lsl#2  ; *5
  85144: sub   w0,w2,w0,lsl#1  ; w0 = (value/placevalue) % 10  = DIGIT at position N
  85148: mul   w0,w0,w1        ; digit * placevalue
  ```
- 0x84f44: `CovTaskInfo::CovTaskInfo(...)`; 0x850ec: `vector<CovTaskInfo>::_M_realloc_insert`
  → append a task entry per selected map.
- 0x84f20: `add w19,w19,#0x1` → next position.

`fmov #10.0` + `pow` proves **base-10 positional**, not base-2. Each decimal
position is one map; `% 10 == 0` means that map is not requested.

### 6. generateCoverPathDeal (0x83260) — SAME digit decode, per map
Independent second occurrence (counter w22 = position):
```
833b8: scvtf d1,w22
833bc: fmov  d0,#10.0
833c0: bl    pow                ; placevalue 1/10/100
833c8: ldr   w0,[x23,#0xdc0]    ; map_ids-derived value
833d8: udiv  w0,w0,w21          ; value/placevalue
833dc-833ec: *0xcccccccd, lsr#35, *5
833f0: subs  w19,w0,w19,lsl#1   ; digit = (value/placevalue) % 10
833f4: b.eq  0x8364c            ; digit==0 -> SKIP this map, next position
833f8: ... use "map"+pos ...    ; else process map
```
Then 0x835a8: `coverage_planner::srv::CoveragePathsByFile::async_send_request`
(plans coverage for that map from its file).

### 7. coverFinishedDeal (0x92878) — advance to next map, dock only at end
- 0x92bc8: `add w20,w20,#0x1` — increment current-map index on FINISHED
- 0x92bec: `bl 0x91a28 <coverStartDeal>` — start NEXT map's coverage (no dock call here)
- 0x92d10: `bl rechargeDeal` — only in the all-done branch (after "Finished all
  task, request map num: %d"). → **no docking between zones**, dock after last map.

### 8. handleGenerateCoverPath (0x68430) — 0xdc0 source
0x685bc/0x685c4: `ldr w3,[x0]; str w3,[x19,#0xdc0]` — reads first field of
`GenerateCoveragePath_Request` (= `uint32 map_ids`) into member +0xdc0. Same
decimal decode applies.

## map2 = 100 (not 200)

The decode is `pow(10, position)`. map2 is position index 2 → placevalue 100.
Docs that say `area:200 = map2` are WRONG per firmware; **map2 = 100**.
(`docs/reference/MOWING-FLOW.md:63,142` claim 200 — should be corrected.)
Encoding table (firmware-derived):
| area | maps mowed |
|------|------------|
| 1    | map0 |
| 10   | map1 |
| 100  | map2 |
| 11   | map0 + map1 |
| 101  | map0 + map2 |
| 110  | map1 + map2 |
| 111  | map0 + map1 + map2 (all, no dock between) |

## Caveats / unverified
- The per-position digit is generally 1 for our use (mapN present once). The
  loop multiplies `digit * placevalue`; non-1 digits are not exercised by the
  app and their exact accumulation semantics beyond "non-zero = include map"
  were not traced to completion.
- Map inclusion also gates on `access()` file-existence + `string::find()`
  membership; a requested map whose file is missing is skipped.
- Whether the app/server currently EMIT combined values (11/111) is a separate
  question (client-side), not covered here — the firmware ACCEPTS them.


## 6. HARD CAP: `map_ids > 60000` → "vision_test" (found 2026-09-08, GH #114)

Right before the digit loop, `coverRequestDataInit` rejects large codes:

```
84d2c: ldr  w2, [sp,#0x80]      ; map_ids
84d30: mov  w0, #0xea60         ; 60000
84d34: cmp  w2, #0xff  / cset w1, eq     ; map_ids == 255
84d3c: cmp  w2, w0     / cset w0, hi     ; map_ids > 60000 (unsigned)
84d4c: cbnz w0, 0x85354
...
85368: adrp x1, 0x26c000 ; add x1, #0xf80   ; "vision_test"
8537c: string::assign(task.name, "vision_test")
```

So the decimal area code only reaches **map0..map4** (11111 max). `map5` = 100000 takes the
`vision_test` branch: coverage_planner logs `Make plan by file: vision_test 1 90`, finds no
boundary and robot_decision reports **error 125**. Field confirmation (Petrov-IV, #114): with all
`map0..map9.{yaml,pgm}` present, map0-4 mow and map5-9 fail; a BLE-mapped map4 works and a
BLE-mapped map5 fails. Stock and custom firmware alike (robot_decision is untouched by our builds).

### The `map_names` path has no such cap (untested live)
When `map_ids == 0`, the request's `map_names[]` are used (0x84b44): requires
`map_names.size() == blade_heights.size()` (else "Map number is different from blade height
size" → error 118); each name is checked with `access(name)` and, failing that,
`access(<maps_dir> + "/" + name)` (0x851a8); then the loop at 0x84e74 maps the name to a slot by
`find("mapN")` for N = 0..29 and synthesizes the per-task id `10^N`. Our earlier attempt
(`_cov_task_yaml` comment) failed with 118 because it sent `"map5"` with no extension, which does
not exist as a file; `"map5.yaml"` (or the absolute yaml path) should pass the `access()` check.
Only reachable through the ROS service (custom firmware); stock `mqtt_node` `start_navigation`
exposes `area` only.
