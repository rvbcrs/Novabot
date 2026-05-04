# Multi-Map Active-Slot Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift the firmware's effective 3-map limit by adding a `swap_active_map` flow that copies the right per-slot `mapN.{yaml,pgm,png}` over the active `map.*` slot + reloads the nav stack before every `start_navigation`. Server stays stateless; mower-side handler does the disk swap + ROS `LoadMap` call.

**Architecture:** Mower's `extended_commands.py` gains a new handler. Server gets one new endpoint (`POST /api/dashboard/maps/:sn/active-slot`) that publishes `{swap_active_map:{slot:N}}` and awaits the ack. App + dashboard call this before any `start_navigation` whose canonical slot ≠ the cached active slot. ScheduleRunner does the same server-side. After a successful swap, `start_navigation` runs with `area: 0` because the loaded `map.yaml` IS the requested map.

**Tech Stack:** TypeScript ESM (server + app), Python 3 (mower extended_commands), ROS 2 Galactic (`/map_server/load_map` service), MQTT extended-response RPC pattern (`publishToExtended` + `onExtendedResponse`).

---

## File Structure

**Create:**
- `server/src/__tests__/routes/dashboardActiveSlot.test.ts` — endpoint tests

**Modify:**
- `research/extended_commands.py` — add `handle_swap_active_map` + COMMANDS registration + `_coverage_is_active` reuse
- `server/src/routes/dashboard.ts` — add POST/GET `/maps/:sn/active-slot`
- `server/src/services/scheduleRunner.ts` — call swap before `triggerSchedule`
- `app/src/services/api.ts` — add `setActiveMapSlot(sn, slot)`
- `app/src/components/StartMowSheet.tsx` — call swap before single-map dispatch + multi-map enqueue
- `app/src/context/MowQueueContext.tsx` — call swap before each per-map start
- `dashboard/src/components/dashboard/MowerControls.tsx` — call swap from dashboard start button (optional, mirrors app)

**Out of scope:**
- App's BLE mapping screen (`MappingScreen.tsx`) does NOT change in this plan. The current cap of 3 maps in mapping is a separate UI fix; today's plan only enables MOWING on slots 3+ that already exist on the mower (e.g. user manually mapped via stock Novabot app + somehow got past UI cap, or will benefit once we lift that cap separately).

---

## Task 1: Mower handler — `handle_swap_active_map`

**Files:**
- Modify: `research/extended_commands.py` — add handler function + register in `COMMANDS`

- [ ] **Step 1: Locate the COMMANDS dict + `_coverage_is_active` helper**

Run: `grep -n "^COMMANDS\|_coverage_is_active\|def handle_sync_map" research/extended_commands.py`

Expected output includes the `COMMANDS = {` line and the existing `_coverage_is_active` function (used by handle_sync_map). Both must already exist — no new helpers needed.

- [ ] **Step 2: Add the handler implementation**

Append this function to `research/extended_commands.py` immediately after the existing `_restart_auto_recharge_server` definition (search for that name; new function goes right after it):

```python
def handle_swap_active_map(params, respond):
    """Copy mapN.{yaml,pgm,png} over the active map.{yaml,pgm,png} slot
    and reload the nav stack via /map_server/load_map. Lifts the stock
    firmware's effective 3-map limit (see docs/superpowers/specs/
    2026-05-04-multi-map-swap-active-slot.md).

    Result codes:
      0 = success
      1 = bad request (negative/missing slot) or copy failure
      2 = requested slot was never mapped on this mower
      3 = coverage is active — refuse mid-task
      4 = files copied but LoadMap ROS call failed
    """
    import os
    import shutil
    import subprocess

    slot_raw = params.get("slot", -1)
    try:
        slot = int(slot_raw)
    except (TypeError, ValueError):
        respond("swap_active_map_respond",
                {"result": 1, "error": f"slot must be integer, got {slot_raw!r}"})
        return
    if slot < 0:
        respond("swap_active_map_respond",
                {"result": 1, "error": "slot must be non-negative"})
        return

    home = "/userdata/lfi/maps/home0"
    src_yaml = f"{home}/map{slot}.yaml"
    src_pgm = f"{home}/map{slot}.pgm"
    src_png = f"{home}/map{slot}.png"

    if not (os.path.exists(src_yaml) and os.path.exists(src_pgm)):
        respond("swap_active_map_respond", {
            "result": 2,
            "error": f"map{slot} not mapped on this mower (yaml/pgm missing)",
            "slot": slot,
        })
        return

    if _coverage_is_active():
        respond("swap_active_map_respond", {
            "result": 3,
            "error": "coverage active, swap refused — stop the running task first",
            "slot": slot,
        })
        return

    try:
        for src, dst_name in (
            (src_yaml, "map.yaml"),
            (src_pgm, "map.pgm"),
            (src_png, "map.png"),
        ):
            if not os.path.exists(src):
                continue  # png is optional; yaml/pgm checked above
            tmp = f"{home}/{dst_name}.tmp"
            shutil.copy2(src, tmp)
            os.replace(tmp, f"{home}/{dst_name}")
    except Exception as e:
        respond("swap_active_map_respond", {
            "result": 1,
            "error": f"copy failed: {e}",
            "slot": slot,
        })
        return

    cmd = (
        ". /opt/ros/galactic/setup.bash && "
        ". /root/novabot/install/setup.bash && "
        "export ROS_LOCALHOST_ONLY=1 && "
        "ros2 service call /map_server/load_map nav2_msgs/srv/LoadMap "
        f'"{{map_url: \\"{home}/map.yaml\\"}}"'
    )
    try:
        rc = subprocess.run(
            ["bash", "-lc", cmd],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        respond("swap_active_map_respond", {
            "result": 4,
            "error": "LoadMap ros2 service call timed out (15s)",
            "slot": slot,
        })
        return

    if rc.returncode != 0:
        respond("swap_active_map_respond", {
            "result": 4,
            "error": "LoadMap call failed",
            "load_rc": rc.returncode,
            "load_stderr": rc.stderr[-200:] if rc.stderr else None,
            "slot": slot,
        })
        return

    respond("swap_active_map_respond", {"result": 0, "slot": slot})
```

- [ ] **Step 3: Register the handler in `COMMANDS`**

Find the `COMMANDS = {` block (search for `"sync_map":` since `sync_map` is a sibling we already register). Add a new line in the dict:

```python
    "swap_active_map": lambda p, r: handle_swap_active_map(p, r),
```

Place it alphabetically near `sync_map`. Match the existing trailing-comma style.

- [ ] **Step 4: Sanity-check Python parses**

Run: `python3 -c "import ast; ast.parse(open('research/extended_commands.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add research/extended_commands.py
git commit -m "feat(firmware): swap_active_map handler for multi-map (>3 work maps) support"
```

---

## Task 2: Server endpoint + idempotency cache

**Files:**
- Modify: `server/src/routes/dashboard.ts` — add POST `/maps/:sn/active-slot` + GET helper
- Test: `server/src/__tests__/routes/dashboardActiveSlot.test.ts` (new)

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/routes/dashboardActiveSlot.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

vi.mock('../../mqtt/broker.js', () => ({
  isDeviceOnline: vi.fn().mockReturnValue(true),
  writeRawPublish: vi.fn().mockReturnValue(false),
  getBrokerDiagnostics: vi.fn().mockReturnValue({}),
  startMqttBroker: vi.fn(),
  banishSn: vi.fn(),
  unbanSn: vi.fn(),
  listBannedSns: vi.fn().mockReturnValue([]),
}));

vi.mock('../../dashboard/socketHandler.js', () => ({
  getRecentLogs: vi.fn().mockReturnValue([]),
  forwardToDashboard: vi.fn(),
  onLogEntry: vi.fn(),
  emitMapsChanged: vi.fn(),
  emitDeviceOnline: vi.fn(),
  emitDeviceOffline: vi.fn(),
  emitTrailClear: vi.fn(),
  emitCoveredLanes: vi.fn(),
  setDemoModeChecker: vi.fn(),
  setOutlineEmitter: vi.fn(),
  initBleLogger: vi.fn(),
  sendBleLogHistory: vi.fn(),
  pushMqttLog: vi.fn(),
  emitOtaEvent: vi.fn(),
  emitPinEvent: vi.fn(),
  emitExtendedEvent: vi.fn(),
  emitCommandRespond: vi.fn(),
  emitScheduleEvent: vi.fn(),
}));

vi.mock('../../mqtt/mapSync.js', async () => {
  const actual = await vi.importActual<typeof import('../../mqtt/mapSync.js')>(
    '../../mqtt/mapSync.js',
  );
  return {
    ...actual,
    publishToExtended: vi.fn(),
    onExtendedResponse: vi.fn(),
    offExtendedResponse: vi.fn(),
    publishToDevice: vi.fn(),
    publishRawToDevice: vi.fn(),
  };
});

vi.mock('../../mqtt/sensorData.js', () => ({
  deviceCache: new Map<string, Map<string, string>>(),
  getAllDeviceSnapshots: vi.fn().mockReturnValue([]),
  getDeviceSnapshot: vi.fn(),
  SENSORS: [],
  getGpsTrail: vi.fn().mockReturnValue([]),
  clearGpsTrail: vi.fn(),
  getLocalTrail: vi.fn().mockReturnValue([]),
  clearLocalTrail: vi.fn(),
  translateValue: vi.fn((_k: string, v: string) => v),
  markPinVerified: vi.fn(),
  getDockPose: vi.fn().mockReturnValue(null),
}));

import { dashboardRouter } from '../../routes/dashboard.js';
import { isDeviceOnline } from '../../mqtt/broker.js';
import * as mapSync from '../../mqtt/mapSync.js';
import { deviceCache } from '../../mqtt/sensorData.js';

const SN = 'LFIN1231000211';

const app = express();
app.use(express.json());
app.use('/api/dashboard', dashboardRouter);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isDeviceOnline).mockReturnValue(true);
  vi.mocked(mapSync.offExtendedResponse).mockImplementation(() => {});
  deviceCache.clear();
});

function ackWith(respond: Record<string, unknown>) {
  vi.mocked(mapSync.onExtendedResponse).mockImplementation((_sn, handler) => {
    queueMicrotask(() => handler({ swap_active_map_respond: respond } as any));
  });
}

describe('POST /api/dashboard/maps/:sn/active-slot', () => {
  it('publishes swap_active_map and returns 200 on result:0', async () => {
    ackWith({ result: 0, slot: 3 });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 3 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, slot: 3 });
    expect(mapSync.publishToExtended).toHaveBeenCalledWith(
      SN,
      expect.objectContaining({ swap_active_map: { slot: 3 } }),
    );
    expect(deviceCache.get(SN)?.get('active_map_slot')).toBe('3');
  });

  it('idempotent: 2nd POST same slot is cached, no MQTT', async () => {
    if (!deviceCache.has(SN)) deviceCache.set(SN, new Map());
    deviceCache.get(SN)!.set('active_map_slot', '2');

    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, slot: 2, cached: true });
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('rejects negative slot with 400 and no MQTT', async () => {
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: -1 });
    expect(r.status).toBe(400);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('rejects non-integer slot with 400', async () => {
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 'two' });
    expect(r.status).toBe(400);
    expect(mapSync.publishToExtended).not.toHaveBeenCalled();
  });

  it('returns 404 when mower offline', async () => {
    vi.mocked(isDeviceOnline).mockReturnValue(false);
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 0 });
    expect(r.status).toBe(404);
  });

  it('translates mower result:2 (slot not mapped) to 400 with helpful error', async () => {
    ackWith({ result: 2, error: 'map5 not mapped on this mower (yaml/pgm missing)', slot: 5 });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 5 });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(String(r.body.error)).toContain('map first via the app');
    expect(deviceCache.get(SN)?.has('active_map_slot')).toBe(false);
  });

  it('translates mower result:3 (coverage active) to 409', async () => {
    ackWith({ result: 3, error: 'coverage active, swap refused' });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 1 });
    expect(r.status).toBe(409);
    expect(String(r.body.error)).toContain('stop mowing first');
  });

  it('translates mower result:4 (LoadMap fail) to 500', async () => {
    ackWith({ result: 4, error: 'LoadMap call failed', load_rc: 1 });
    const r = await request(app)
      .post(`/api/dashboard/maps/${SN}/active-slot`)
      .send({ slot: 1 });
    expect(r.status).toBe(500);
  });
});

describe('GET /api/dashboard/maps/:sn/active-slot', () => {
  it('returns the cached slot or null', async () => {
    let r = await request(app).get(`/api/dashboard/maps/${SN}/active-slot`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ slot: null });

    if (!deviceCache.has(SN)) deviceCache.set(SN, new Map());
    deviceCache.get(SN)!.set('active_map_slot', '4');
    r = await request(app).get(`/api/dashboard/maps/${SN}/active-slot`);
    expect(r.body).toEqual({ slot: 4 });
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `cd server && npx vitest run src/__tests__/routes/dashboardActiveSlot.test.ts`
Expected: all 9 cases FAIL — endpoints not registered.

- [ ] **Step 3: Add the endpoints**

In `server/src/routes/dashboard.ts`, append (locate the existing `dashboardRouter.get('/rain-sessions/:sn', ...)` block and insert these new routes immediately after it for visibility):

```ts
// ─────────────────────────────────────────────────────────────────────────────
// Active map slot — multi-map support (>3 work maps).
// Spec: docs/superpowers/specs/2026-05-04-multi-map-swap-active-slot.md
//
// POST /api/dashboard/maps/:sn/active-slot { slot: number }
//   Tells the mower to copy mapN.{yaml,pgm,png} over the active map.* slot
//   and reload the nav stack. Idempotent — second call with the same slot
//   is satisfied from the deviceCache.
//
// GET /api/dashboard/maps/:sn/active-slot
//   Returns the cached active slot (or null when never set).
// ─────────────────────────────────────────────────────────────────────────────

dashboardRouter.post('/maps/:sn/active-slot', async (req: Request, res: Response) => {
  const { sn } = req.params;
  const slotRaw = (req.body as { slot?: unknown }).slot;
  if (typeof slotRaw !== 'number' || !Number.isInteger(slotRaw) || slotRaw < 0) {
    res.status(400).json({ ok: false, error: 'slot must be a non-negative integer' });
    return;
  }
  const slot = slotRaw;

  if (!isDeviceOnline(sn)) {
    res.status(404).json({ ok: false, error: 'Device is offline' });
    return;
  }

  // Idempotency: if cache says we're already on this slot, skip MQTT.
  const cached = deviceCache.get(sn)?.get('active_map_slot');
  if (cached === String(slot)) {
    res.json({ ok: true, slot, cached: true });
    return;
  }

  const { publishToExtended, onExtendedResponse, offExtendedResponse } =
    await import('../mqtt/mapSync.js');

  type Result = { ok: boolean; respond?: Record<string, unknown>; timeout?: boolean };
  const result = await new Promise<Result>(resolve => {
    let settled = false;
    const handler = (data: Record<string, unknown>) => {
      const r = data.swap_active_map_respond as Record<string, unknown> | undefined;
      if (!r || settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: r.result === 0, respond: r });
    };
    onExtendedResponse(sn, handler);
    publishToExtended(sn, { swap_active_map: { slot } });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      offExtendedResponse(sn, handler);
      resolve({ ok: false, timeout: true });
    }, 15000);
  });

  if (result.timeout) {
    res.status(504).json({ ok: false, error: 'mower did not ack within 15s', slot });
    return;
  }
  if (result.ok) {
    if (!deviceCache.has(sn)) deviceCache.set(sn, new Map());
    deviceCache.get(sn)!.set('active_map_slot', String(slot));
    forwardToDashboard(sn, new Map([['active_map_slot', String(slot)]]));
    res.json({ ok: true, slot, respond: result.respond });
    return;
  }

  // Translate mower error codes to HTTP statuses.
  const code = (result.respond?.result as number | undefined) ?? -1;
  const mowerErr = String(result.respond?.error ?? 'swap failed');
  if (code === 2) {
    res.status(400).json({
      ok: false,
      error: `${mowerErr} — map first via the app`,
      respond: result.respond,
    });
  } else if (code === 3) {
    res.status(409).json({
      ok: false,
      error: `${mowerErr} — stop mowing first`,
      respond: result.respond,
    });
  } else if (code === 4) {
    res.status(500).json({ ok: false, error: mowerErr, respond: result.respond });
  } else {
    res.status(400).json({ ok: false, error: mowerErr, respond: result.respond });
  }
});

dashboardRouter.get('/maps/:sn/active-slot', (req: Request, res: Response) => {
  const cached = deviceCache.get(req.params.sn)?.get('active_map_slot');
  res.json({ slot: cached != null ? parseInt(cached, 10) : null });
});
```

- [ ] **Step 4: Run tests to confirm pass**

Run: `cd server && npx vitest run src/__tests__/routes/dashboardActiveSlot.test.ts`
Expected: 9/9 PASS.

- [ ] **Step 5: Run full server suite — no regressions**

Run: `cd server && npx vitest run`
Expected: all tests pass, totals approximately 295/295 (eight added).

- [ ] **Step 6: TS + lint checks**

Run: `cd server && npx tsc --noEmit && npx eslint src/routes/dashboard.ts`
Expected: no output (clean).

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/dashboard.ts server/src/__tests__/routes/dashboardActiveSlot.test.ts
git commit -m "feat(server): /maps/:sn/active-slot endpoint with idempotent swap_active_map RPC"
```

---

## Task 3: ScheduleRunner pre-swap

**Files:**
- Modify: `server/src/services/scheduleRunner.ts` — call swap before `startMowing` in `triggerSchedule`

- [ ] **Step 1: Inspect the current trigger code**

Run: `grep -n "function triggerSchedule\|startMowing(" server/src/services/scheduleRunner.ts`

Expected: shows `triggerSchedule(row: ScheduleRow)` and a call to `startMowing({sn, ...})` inside it. The swap call must go just BEFORE that `startMowing` invocation.

- [ ] **Step 2: Add a helper that resolves `slot` from the schedule's mapId**

Add this near the top of `server/src/services/scheduleRunner.ts` (after the existing imports — keep imports ordered):

```ts
/** Resolve the firmware slot index from the schedule's stored mapId.
 *  Reads canonical_name on the maps row and parses the trailing
 *  digits ("map7_work" -> 7). Returns null when the row is missing or
 *  the canonical_name doesn't match. */
function resolveSlotForSchedule(row: ScheduleRow): number | null {
  if (!row.map_id) return null;
  const mapRow = mapRepo.findById(row.map_id);
  const canonical = mapRow?.canonical_name ?? '';
  const m = canonical.match(/^map(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
```

- [ ] **Step 3: Insert the swap call inside `triggerSchedule`**

Modify `triggerSchedule` so the very first thing it does (before computing `effectiveDirection`) is:

```ts
function triggerSchedule(row: ScheduleRow) {
  // Multi-map support: ensure the mower has the right slot loaded into
  // its active map.yaml before kicking off the mow. Skips when the
  // schedule is bound to a slot we can't resolve (legacy rows). Spec:
  // docs/superpowers/specs/2026-05-04-multi-map-swap-active-slot.md
  const slot = resolveSlotForSchedule(row);
  if (slot != null) {
    void (async () => {
      try {
        const { publishToExtended, onExtendedResponse, offExtendedResponse } =
          await import('../mqtt/mapSync.js');
        await new Promise<void>(resolve => {
          let settled = false;
          const handler = (data: Record<string, unknown>) => {
            if (!data.swap_active_map_respond || settled) return;
            settled = true;
            offExtendedResponse(row.mower_sn, handler);
            resolve();
          };
          onExtendedResponse(row.mower_sn, handler);
          publishToExtended(row.mower_sn, { swap_active_map: { slot } });
          setTimeout(() => {
            if (settled) return;
            settled = true;
            offExtendedResponse(row.mower_sn, handler);
            resolve();  // never block the mow on swap timeout
          }, 15000);
        });
      } catch (err) {
        console.error(`[ScheduleRunner] swap_active_map failed for ${row.mower_sn} slot=${slot}:`, err);
      }
      runStartMowing(row);
    })();
    return;
  }
  runStartMowing(row);
}

function runStartMowing(row: ScheduleRow) {
  // Bereken effectieve richting (met alternerende rotatie)
  let effectiveDirection = row.path_direction;
  if (row.alternate_direction === 1) {
    const count = messageRepo.countWorkRecordsBySchedule(row.schedule_id);
    effectiveDirection = (row.path_direction + count * (row.alternate_step ?? 90)) % 360;
  }

  // Start maaien via centrale mowingService
  const result = startMowing({
    sn: row.mower_sn,
    cuttingHeight: row.cutting_height ?? 5,
    pathDirection: effectiveDirection,
    area: 1,
  });
  console.log(`[ScheduleRunner] ${row.schedule_id}: ${result.ok ? 'started' : 'FAILED: ' + result.error} (height=${row.cutting_height}, dir=${effectiveDirection})`);

  // Update last_triggered_at
  scheduleRepo.updateLastTriggered(row.schedule_id);

  emitScheduleEvent('weather:started', {
    scheduleId: row.schedule_id,
    mowerSn: row.mower_sn,
    effectiveDirection,
  });
}
```

> **Note:** the existing body of `triggerSchedule` is moved verbatim into `runStartMowing`. Make sure to delete the old body — the `function triggerSchedule(row)` block now ONLY does the swap-then-`runStartMowing` orchestration above.

- [ ] **Step 4: Verify TS clean**

Run: `cd server && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Run full server suite**

Run: `cd server && npx vitest run`
Expected: all tests pass (no scheduleRunner test exists for swap path; existing UTC-guard test must still pass).

- [ ] **Step 6: Commit**

```bash
git add server/src/services/scheduleRunner.ts
git commit -m "feat(server): scheduleRunner pre-swaps active map slot before triggerSchedule"
```

---

## Task 4: App API client method

**Files:**
- Modify: `app/src/services/api.ts` — add `setActiveMapSlot` + `getActiveMapSlot`

- [ ] **Step 1: Locate insertion point**

Run: `grep -n "async setRainIgnoreSession\b" app/src/services/api.ts`

Expected: returns the line number where `setRainIgnoreSession` is defined (a recently-added similar method). Add the new methods right after that one.

- [ ] **Step 2: Add the methods**

Insert immediately after the closing `}` of `setRainIgnoreSession`:

```ts
  async setActiveMapSlot(sn: string, slot: number): Promise<{ ok: boolean; slot: number; cached?: boolean; error?: string }> {
    return this.request<{ ok: boolean; slot: number; cached?: boolean; error?: string }>(
      'POST',
      `/api/dashboard/maps/${encodeURIComponent(sn)}/active-slot`,
      { body: { slot } },
    );
  }

  async getActiveMapSlot(sn: string): Promise<{ slot: number | null }> {
    return this.request<{ slot: number | null }>(
      'GET',
      `/api/dashboard/maps/${encodeURIComponent(sn)}/active-slot`,
    );
  }
```

- [ ] **Step 3: TS check**

Run: `cd app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add app/src/services/api.ts
git commit -m "feat(app): api.setActiveMapSlot + getActiveMapSlot client methods"
```

---

## Task 5: StartMowSheet pre-swap

**Files:**
- Modify: `app/src/components/StartMowSheet.tsx` — call `setActiveMapSlot` before `start_navigation`

- [ ] **Step 1: Find the canonical-slot derivation already in place**

Run: `grep -n "canonicalIdx\|setActiveMapSlot\|orderedMapIds\[0\]" app/src/components/StartMowSheet.tsx`

Expected: shows the `canonicalIdx` computation block you added earlier (around line 304) and the `start_navigation` dispatch around line 311. The new swap call goes between them.

- [ ] **Step 2: Insert swap call before `start_navigation`**

Edit the single-map dispatch path. Replace this existing block (verify exact lines via grep first — they may have moved):

```ts
      // Single-map path (legacy, identical to pre-multi-select behaviour).
      // Issue #14 / #18: derive the firmware `area` enum from the canonical
      // slot identifier (map0/map1/map2) so the user's selection lines up
      // with the mower's internal index. Sorting by updated_at + using array
      // index produced "select front, mow trampo" because the alphabetical
      // app order didn't match the firmware's creation order.
      const selectedMap = maps.find(m => m.mapId === orderedMapIds[0]) ?? maps[0];
      const canonicalIdx = (() => {
        const m = (selectedMap?.canonicalName ?? '').match(/^map(\d+)/);
        return m ? parseInt(m[1], 10) : null;
      })();
      const fallbackIdx = maps.findIndex(m => m.mapId === orderedMapIds[0]);
      const mapIdx = canonicalIdx ?? (fallbackIdx >= 0 ? fallbackIdx : 0);
      // Firmware `area` enum: map0=1, map1=10, map2=200. Confirmed in
      // docs/reference/MOWING-FLOW.md. Three slots only (firmware limit).
      const areaParam = mapIdx === 0 ? 1 : mapIdx === 1 ? 10 : 200;
```

with:

```ts
      // Single-map path. Use canonicalName for the firmware slot index so
      // we always dispatch the map the user actually picked (not the array
      // position). Issue #14 / #18.
      const selectedMap = maps.find(m => m.mapId === orderedMapIds[0]) ?? maps[0];
      const canonicalIdx = (() => {
        const m = (selectedMap?.canonicalName ?? '').match(/^map(\d+)/);
        return m ? parseInt(m[1], 10) : null;
      })();
      const fallbackIdx = maps.findIndex(m => m.mapId === orderedMapIds[0]);
      const mapIdx = canonicalIdx ?? (fallbackIdx >= 0 ? fallbackIdx : 0);

      // Multi-map support (spec 2026-05-04): ask the server to swap the
      // mower's active map.yaml to the selected slot before dispatching
      // start_navigation. After a successful swap, area is irrelevant —
      // the loaded map.yaml IS the requested map. We send area=0 to avoid
      // the legacy 1/10/200 enum.
      try {
        await api.setActiveMapSlot(sn, mapIdx);
      } catch (e) {
        console.log('[StartMow] setActiveMapSlot failed:', e);
        // surface to user so they don't think the mow started silently
        const msg = e instanceof Error ? e.message : 'swap failed';
        Alert.alert(t('startMowFailed') || 'Could not start', msg);
        return;
      }
      const areaParam = 0;
```

- [ ] **Step 3: Same change for the multi-map enqueue path**

Find the `if (orderedMapIds.length > 1) {` block above it (search around line 286). Inside that block, BEFORE `await enqueue({...})`, add a swap call for the FIRST map only — the queue handles subsequent swaps in Task 6:

```ts
      if (orderedMapIds.length > 1) {
        // Multi-map: hand off to the queue. Pre-swap the first map so the
        // initial start_navigation lands on the right slot. The queue
        // performs additional swaps before each subsequent dispatch.
        const firstMap = maps.find(m => m.mapId === orderedMapIds[0]) ?? maps[0];
        const firstSlot = (() => {
          const m = (firstMap?.canonicalName ?? '').match(/^map(\d+)/);
          return m ? parseInt(m[1], 10) : 0;
        })();
        try {
          await api.setActiveMapSlot(sn, firstSlot);
        } catch (e) {
          console.log('[StartMow] setActiveMapSlot failed (queue head):', e);
          const msg = e instanceof Error ? e.message : 'swap failed';
          Alert.alert(t('startMowFailed') || 'Could not start', msg);
          return;
        }
        await api.clearTrail(sn).catch(() => {});
        await enqueue({
          sn,
          mapIds: orderedMapIds,
          cuttingHeight,
          pathDirection,
        });
        console.log(`[StartMow] enqueued ${orderedMapIds.length} maps:`, orderedMapIds.join(','));
        onStarted({ cuttingHeight: wireHeight, pathDirection });
        onClose();
        return;
      }
```

- [ ] **Step 4: TS check**

Run: `cd app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add app/src/components/StartMowSheet.tsx
git commit -m "feat(app): StartMowSheet pre-swaps active map slot before start_navigation"
```

---

## Task 6: MowQueueContext pre-swap per dispatch

**Files:**
- Modify: `app/src/context/MowQueueContext.tsx` — call swap before each per-map start

- [ ] **Step 1: Locate the dispatch site**

Run: `grep -n "areaParamFromIdx\|sendCommand.*start_navigation\|head\.mapIdx" app/src/context/MowQueueContext.tsx`

Expected: shows the place in `MowQueueProvider` where each queued map dispatches `start_navigation`. The swap call goes immediately before that `sendCommand`.

- [ ] **Step 2: Insert swap call**

Find the dispatch block (around the line `console.log('[MowQueue] dispatch ${head.mapName} ...')`). Replace the dispatch block:

```ts
      console.log(`[MowQueue] dispatch ${head.mapName} (idx=${head.mapIdx}) cutterhigh=${wireHeight}`);
      const navResult = await api.sendCommand(state.sn, {
        start_navigation: {
          mapName: 'test',
          area: areaParamFromIdx(head.mapIdx),
          cutterhigh: wireHeight,
          cmd_num: Date.now() % 100000,
        },
      });
```

with:

```ts
      console.log(`[MowQueue] dispatch ${head.mapName} (idx=${head.mapIdx}) cutterhigh=${wireHeight}`);
      // Multi-map support (spec 2026-05-04): swap the active map slot
      // before each dispatch so the queue can mow ANY canonical slot,
      // not just map0/1/2. Treat swap failure as a fatal queue error
      // — better to abort cleanly than mow the wrong polygon.
      try {
        await api.setActiveMapSlot(state.sn, head.mapIdx);
      } catch (err) {
        console.warn(`[MowQueue] setActiveMapSlot failed for slot=${head.mapIdx}:`, err);
        return;
      }
      const navResult = await api.sendCommand(state.sn, {
        start_navigation: {
          mapName: 'test',
          area: 0,  // map.yaml swap above makes the legacy area enum irrelevant
          cutterhigh: wireHeight,
          cmd_num: Date.now() % 100000,
        },
      });
```

- [ ] **Step 3: TS check**

Run: `cd app && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add app/src/context/MowQueueContext.tsx
git commit -m "feat(app): MowQueueContext pre-swaps active map slot before each per-map dispatch"
```

---

## Task 7: Dashboard MowerControls pre-swap

**Files:**
- Modify: `dashboard/src/components/dashboard/MowerControls.tsx`

- [ ] **Step 1: Locate the start_navigation dispatch**

Run: `grep -n "start_navigation\|workMaps\.indexOf\|areaParam" dashboard/src/components/dashboard/MowerControls.tsx`

Expected: shows the existing `mapIdx` computation and the `sendCommand(sn, { start_navigation: ... })` block (around line 290).

- [ ] **Step 2: Replace the dispatch**

Replace this block:

```ts
        const cmdNum = nextCmdNum();
        const navPayload: Record<string, unknown> = {
          mapName: resolvedMapName,
          cutterhigh: wireHeight,
          area: areaParam,
          cmd_num: cmdNum,
        };
        const navResult = await sendCommand(sn, { start_navigation: navPayload });

        if (!navResult.ok) {
          // Fallback: old firmware protocol (matches app StartMowSheet.tsx line 317)
          await sendCommand(sn, {
            start_run: { mapName: null, area: areaParam, cutterhigh: wireHeight },
          });
        }
```

with:

```ts
        // Multi-map support (spec 2026-05-04): swap the active map slot
        // before dispatching so the dashboard can mow any work map, not
        // only the first 3 covered by the legacy area enum. Translate
        // mapIdx → slot via the same parse rule the app uses.
        try {
          await fetch(`${apiBase}/api/dashboard/maps/${encodeURIComponent(sn)}/active-slot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slot: mapIdx }),
          });
        } catch (err) {
          toast(`✗ ${t('controls.startMowing')}: swap failed (${String(err)})`, 'error');
          setBusy(false);
          return;
        }

        const cmdNum = nextCmdNum();
        const navPayload: Record<string, unknown> = {
          mapName: resolvedMapName,
          cutterhigh: wireHeight,
          area: 0,  // post-swap, map.yaml IS the requested map
          cmd_num: cmdNum,
        };
        const navResult = await sendCommand(sn, { start_navigation: navPayload });

        if (!navResult.ok) {
          // Fallback: old firmware protocol (matches app StartMowSheet.tsx line 317)
          await sendCommand(sn, {
            start_run: { mapName: null, area: 0, cutterhigh: wireHeight },
          });
        }
```

- [ ] **Step 3: Resolve `apiBase`**

If `apiBase` isn't already imported in scope, add it. Run: `grep -n "import.*api\b\|API_BASE\|getApiBase" dashboard/src/components/dashboard/MowerControls.tsx` to find the existing convention and use it. If the convention is to call a helper like `apiUrl(...)`, use that instead of building the URL inline.

- [ ] **Step 4: TS check**

Run: `cd dashboard && npx tsc --noEmit`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/components/dashboard/MowerControls.tsx
git commit -m "feat(dashboard): MowerControls pre-swaps active map slot before start"
```

---

## Task 8: Live deploy + acceptance test

**Files:**
- No new files — runbook + verification only.

- [ ] **Step 1: SCP the updated extended_commands.py to the test mower**

```bash
sshpass -p novabot scp \
  research/extended_commands.py \
  root@192.168.0.100:/root/novabot/scripts/extended_commands.py
```

- [ ] **Step 2: Restart the daemon**

```bash
sshpass -p novabot ssh root@192.168.0.100 \
  'pkill -9 -f "extended_commands.py"; sleep 2; \
   nohup python3 /root/novabot/scripts/extended_commands.py >> /tmp/extcmd_relaunch.log 2>&1 < /dev/null & \
   sleep 3; pgrep -af extended_commands'
```

Expected: a new PID appears.

- [ ] **Step 3: Build + push the server image**

Skip if not deploying to NAS — run from local dev container instead. To deploy:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  --builder multiplatform-builder \
  -t rvbcrs/opennova:latest --push --no-cache .
sshpass -p 'M@rleen146' ssh rvbcrs@192.168.0.247 \
  'echo "M@rleen146" | sudo -S docker pull rvbcrs/opennova:latest && \
   echo "M@rleen146" | sudo -S docker restart opennova'
```

- [ ] **Step 4: Verify the test mower has at least one slot beyond map0**

```bash
sshpass -p novabot ssh root@192.168.0.100 \
  'ls /userdata/lfi/maps/home0/map*.yaml /userdata/lfi/maps/home0/map*.pgm'
```

Expected: at minimum `map0.yaml/.pgm` and `map1.yaml/.pgm`. If only map0 exists, the acceptance test cannot proceed — first map a 2nd area through the Novabot stock app on the same mower (it caps at 3 in UI but our test only needs 2 slots). LOG which slots exist in the runbook before continuing.

- [ ] **Step 5: Trigger a swap from the server and verify**

Hit the new endpoint via curl (use the server's JWT — or temporarily disable auth for the test):

```bash
curl -sX POST http://192.168.0.247:8080/api/dashboard/maps/LFIN1231000211/active-slot \
  -H 'Content-Type: application/json' \
  -d '{"slot": 1}'
```

Expected JSON: `{"ok":true,"slot":1,"respond":{"result":0,"slot":1}}`.

Then confirm on the mower:

```bash
sshpass -p novabot ssh root@192.168.0.100 \
  'cmp /userdata/lfi/maps/home0/map.yaml /userdata/lfi/maps/home0/map1.yaml && \
   tail -10 /tmp/extcmd_relaunch.log | grep swap_active_map'
```

Expected: `cmp` returns 0 (files identical) and the log shows the handler fired.

- [ ] **Step 6: Start a real mow**

From the OpenNova app, select the 2nd work map and tap Start. Expected: mower drives the 2nd map's polygon (not map0). Verify by watching `cov_map_path` in the dashboard or by physical observation.

- [ ] **Step 7: Document the result**

Append a short note to `docs/runbooks/charger-anchor-restore-runbook.md` (or create a new runbook `docs/runbooks/multi-map-mowing.md`) describing the procedure operators use to confirm the swap is healthy. Keep it minimal — link to the spec for details.

```bash
git add docs/runbooks/
git commit -m "docs: runbook note for multi-map active-slot swap"
```

- [ ] **Step 8: Push the branch and open a PR**

```bash
git push -u origin feat/multi-map-swap
gh pr create --title "feat: support >3 work maps via active-slot swap" --body "$(cat <<'EOF'
## Summary
- New `swap_active_map` extended-command handler on the mower copies `mapN.{yaml,pgm,png}` over the active slot and reloads `map_server`.
- New server endpoint `POST /api/dashboard/maps/:sn/active-slot` orchestrates the swap with idempotency caching and proper error translation.
- App + dashboard + scheduleRunner pre-swap the active slot before every `start_navigation`, so any work map (canonical `mapN`) can be mowed regardless of the legacy 1/10/200 area enum.

Spec: `docs/superpowers/specs/2026-05-04-multi-map-swap-active-slot.md`

## Test plan
- [ ] `cd server && npx vitest run` passes (incl. 9 new active-slot tests)
- [ ] `cd app && npx tsc --noEmit` clean
- [ ] `cd dashboard && npx tsc --noEmit` clean
- [ ] Acceptance test on LFIN1231000211 — swap to slot 1 reflected in `cmp map.yaml map1.yaml` returning 0
- [ ] Real mow on slot 1 from the app drives the right polygon
EOF
)"
```

---

## Self-Review Notes

- Spec section 1 (Goal) covered by Task 1 (handler) + Task 2 (endpoint).
- Spec section 2 (mower handler result codes) — Task 1 implements, Task 2 tests cover translation.
- Spec section 3 (server orchestration + idempotency) — Task 2.
- Spec section 4 (app side) — Tasks 4, 5, 6.
- Spec section 5 (scheduleRunner) — Task 3.
- Spec section 6 (dashboard) — Task 7.
- Spec section 7 (acceptance / failure modes) — Task 8.
- Telemetry forwarding (`forwardToDashboard(sn, {active_map_slot})`) — Task 2 step 3.
- TODO from spec ("confirm firmware accepts mapName 'mapN' for N≥3") — out of plan scope by design; this plan implements the SWAP path which works once the slot files exist on disk. A separate plan must extend the BLE mapping screen.
