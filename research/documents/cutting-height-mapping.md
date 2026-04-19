# Cutting Height — MQTT `cutterhigh` → Physical Blade Height

**Status:** Verified live on LFIN1231000211 (2026-04-19).
**Scope:** Applies to Novabot mowers running `mqtt_node` v6.0.x and custom-17..custom-21 (the observed custom variants of Ramon + Alain).

This document exists because we got the mapping wrong **multiple times** during debugging and spent hours chasing the wrong theory. The table and flow below are the **only** truth — always cross-check any code change against the `ros2_log` evidence listed at the bottom.

---

## 1. The formula

```
physical_blade_height_mm = (mqtt_cutterhigh + 2) * 10
mqtt_cutterhigh          = (user_cm − 2)             // clamp 0..7
```

`cutterhigh` is a **zero-indexed 0..7 enum**, NOT millimetres, NOT the display cm.

### Authoritative table

| User picks (cm) | MQTT `cutterhigh` | `coverage_planner` "Setting blade height to" | chassis `set_blade_height_cb` | `BLADE_HEIGHT_GET` |
|----------------:|------------------:|---------------------------------------------:|------------------------------:|-------------------:|
| 2 | 0 | 20 | 7 | 20 mm |
| 3 | 1 | 30 | 6 | 30 mm |
| **4** | **2** | **40** | **5** | **40 mm** ← verified |
| 5 | 3 | 50 | 4 | 50 mm |
| 6 | 4 | 60 | 3 | 60 mm |
| 7 | 5 | 70 | 2 | 70 mm |
| 8 | 6 | 80 | 1 | 80 mm |
| 9 | 7 | 90 | 0 | 90 mm |

Out-of-range values (e.g. 40, 50) are silently rejected by the firmware. The blade stays at its previous position and the mower will drive around without actually cutting grass (the cut motor spins freely at ~5 mA = no load). This is what fooled us several times.

---

## 2. End-to-end flow

```
App (user picks 4 cm)
   │
   │ wireHeight = cm − 2 = 2
   ▼
Server encrypts + publishes to Dart/Send_mqtt/<SN>
   {"start_navigation":{"mapName":"test","cutterhigh":2,"area":1,"cmd_num":…}}
   │
   ▼
mqtt_node on mower  → logs: cmd_msgrcv_pipe_read {... "cutterhigh":2 ...}
   │
   │ calls decision_msgs/srv/StartCoverageTask
   │   with height_list=[2]
   ▼
robot_decision       → logs: "Start task ... height: 40"       ← 40 = (2+2)*10
   │
   │ calls coverage_planner/srv/SetBladeHeight(blade_height=40)
   ▼
coverage_planner     → logs: "Setting blade height to : 40"
   │
   │ calls chassis set_blade_height service with an *inverted* index: 7 − (mm/10−1) ... actually index = (90 − mm)/10
   ▼
chassis_control      → logs: "set_blade_height_cb 5"            ← 5 = (90−40)/10
                      → drives lifting motor
                      → logs: "BLADE_HEIGHT_GET = 40 mm"        ← actual sensor readback
```

Three different numbers refer to the same setting — **always check which layer you're reading**:
- **MQTT wire** `cutterhigh`: 0..7 (enum)
- **coverage_planner "Setting blade height to"**: mm (20..90)
- **chassis `set_blade_height_cb`**: inverted index (0 = 90 mm UP, 7 = 20 mm DOWN)
- **chassis `BLADE_HEIGHT_GET`**: mm, physical readback — this is the ONLY value that proves what the blade actually did

---

## 3. Live evidence

All captured on LFIN1231000211, 2026-04-19, from `/root/novabot/data/ros2_log/`:

### Novabot-app reference capture (verifying mapping)

```
# mqtt_node_20260419_163617_821948.log @ 18:18:09
cmd_msgrcv_pipe_read {"start_navigation":{"mapName":"test","area":1,"cutterhigh":2,"cmd_num":205806121}}

# robot_decision_20260418_172654_3297.log @ 18:18:17
Start task:/userdata/lfi/maps/home0/map0.yaml  height: 40

# coverage_planner_server_20260418_172654_3281.log @ 18:18:30
Setting blade height to : 40

# chassis_control_node_20260418_172654_3271.log @ 18:18:30 / 18:18:42
set_blade_height_cb 5
BLADE_HEIGHT_GET = 40 mm
```

### OpenNova-app validation capture (fix proven)

```
# mqtt_node_20260419_182617_996814.log @ 18:28:09
cmd_msgrcv_pipe_read {"start_navigation":{"mapName":"test","cutterhigh":2,"area":1,"cmd_num":88167}}

# coverage_planner_server_20260418_172654_3281.log @ 18:28:30
Setting blade height to : 40

# chassis_control_node_20260418_172654_3271.log @ 18:28:30 / 18:28:42
set_blade_height_cb 5
BLADE_HEIGHT_GET = 40 mm   ✓ identical outcome to Novabot
```

Both the official Novabot app and the OpenNova app produce the exact same blade movement — 40 mm — when the user picks 4 cm. The formula is **empirically** verified from both sides.

---

## 4. Do / Don't

### Do
- Store the user's choice in UI as **cm (2..9)**.
- Convert **once**, at the edge, when serialising the MQTT payload: `cutterhigh = cm − 2`.
- Echo check: `sensors.target_height` in `report_state_robot` equals the accepted `cutterhigh` verbatim. To display cm: `target_height + 2`.
- If you have to verify physical behaviour: grep `BLADE_HEIGHT_GET` in `chassis_control_node_*.log`. That is the only ground truth.

### Don't
- **Don't** send mm values (40, 50, 90) in `cutterhigh`. They are silently rejected. The mower drives, the cut motor spins, no grass gets cut.
- **Don't** send the user's cm value directly (4). That maps to `physical_mm = (4+2)*10 = 60`, i.e. 6 cm — the user's grass stays too long and it's not obvious why.
- **Don't** use the chassis `set_blade_height_cb` index or the factory-test value (20/50/90) as the MQTT wire format. Those are internal.
- **Don't** trust a single MQTT log when `mqtt_node` has been restarting. It crashes/respawns regularly; check `readlink /proc/$(pgrep mqtt_node)/fd/*` to find the **current** log. During the debug session we wasted hours reading a stale log from a dead PID.
- **Don't** rely on `cov_ratio` / `work_status` growth as proof of cutting. The mower can happily report "COVERING" while the blade is at 90 mm and cuts nothing.

---

## 5. Failure modes we hit (and what they look like)

| Symptom | Wire value we sent | Physical blade | How to spot it |
|---|---|---|---|
| "Grass too long after mowing at 4 cm" | `cutterhigh:4` | 60 mm (user's 4 became 6) | `Setting blade height to : 60` in coverage log |
| "Blade doesn't cut at all, grass untouched" | `cutterhigh:40` (mm) | stays at 80–90 mm (rejected) | no `Setting blade height` event, only `cov_ratio` grows |
| "Blade is at 8 cm but I picked 4" | `cutterhigh:6` (cm+2) | 80 mm | `Setting blade height to : 80` |
| **Correct** | `cutterhigh:2` (cm−2) | **40 mm** | `Setting blade height to : 40` + `BLADE_HEIGHT_GET = 40 mm` |

---

## 6. Where the code lives

- App: [`app/src/components/StartMowSheet.tsx`](../../app/src/components/StartMowSheet.tsx) — state in cm (2..9), wire value `cm − 2` at publish time.
- Server: [`server/src/services/mowingService.ts`](../../server/src/services/mowingService.ts) — same formula, plus input-encoding detector so legacy callers (mm, cm+2, cm) all end up sending the correct wire value.
- HomeScreen display: [`app/src/screens/HomeScreen.tsx`](../../app/src/screens/HomeScreen.tsx) — pill + mismatch alert both use `target_height + 2` for cm.

Any future touch to cutting-height plumbing **must** reference this doc and the 2 captured log snippets above, or it gets rolled back.
