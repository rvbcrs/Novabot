# Remote PIN unlock research (WORK IN PROGRESS — no working unlock yet)

> Community research notes from a Novabot owner running OpenNova. Shared as
> **work in progress**, not a finished solution. Two firmware attempts were
> flashed and live-tested: v3.6.99 verifies the PIN correctly but **does not clear
> the lock**; v3.6.100 clears the gate bit but **the lock FSM re-asserts it**, so
> the mower stays locked. **There is no patch that unlocks a real lock yet.** The
> genuinely reusable, already-confirmed finding is **how the MCU flasher works**
> (bottom section) — that part stands on its own.
>
> **Firmware flashing is risky.** Everything below touches the motor-controller
> MCU. Read it end to end, keep a verified backup of the stock binary, and do
> not flash anything you have not CRC-checked. You are responsible for your own
> device.

## The problem

The Novabot has an anti-theft PIN. It is **not** handled by the Linux computer —
it lives in the **STM32 motor-controller (chassis) MCU**. After a full power-off
the mower comes up locked and asks for the PIN (error `151`). Normally you type
it on the physical screen.

If you are away from home, there is no supported way to clear that lock
remotely. We confirmed why, by static analysis of the **stock** chassis firmware
(disassembly only, nothing flashed):

- The serial command for the PIN is `CMD 0x23`, with a `type` byte:
  - `type=0` → **get** the stored PIN (returns it).
  - `type=1` → **set / change** the PIN (validates 4 ASCII digits, overwrites,
    returns `0`; idempotent if the value is unchanged).
  - **any other `type` (including `type=2`) → not handled**; it falls through.
- No `type` on the stock firmware ever **clears the lock**: get and set never
  touch the lock state. On stock, the lock is cleared **only** by typing the PIN
  on the physical screen.
- There is **no attempt counter / lockout** on the remote PIN path, so repeated
  remote attempts do not brick anything.

The ROS2 action the app uses, `/chassis_pin_code_set`
(`novabot_msgs/action/ChassisPinCodeSet`, goal `uint8 type` + `string code`,
result `uint8 status`), just forwards that same `CMD 0x23`. So end-to-end it can
**read** (`type=0`) and **change** (`type=1`) the PIN remotely, but it **cannot
unlock**, because the stock MCU ignores `type=2`.

This also explains an easy misread: the app sends `type=2` to verify/unlock, and
on stock firmware that always comes back as a failure — not because the PIN is
wrong, but because `type=2` is unimplemented.

> Note: `report_exception_state.no_set_pin_code` is **not** the lock flag. It is
> a separate flag ("no PIN configured"). The real lock is the `no_pin_code` bit
> (bit 16, `0x10000`) of the error bitmask held in RAM at `0x200002E0`. The MCU
> serialises it to the host via `get_error_mask` (`0x08030314`, which `ldm`s the
> raw mask), and the Linux side turns that bit into error `151`. This is
> **RAM-only**: at boot the MCU sets the bit from EEPROM register `0x75` (`== '9'`),
> and the firmware never writes EEPROM `0x75` (it stays a factory byte), so there
> is **no** RTC/backup-domain persistence of the lock. Stock clears the bit only
> through the physical-screen path; the remote channel has to clear it explicitly.

## Attempted fix: an "honest verify" patch (`type=2`)

We built a patch to the STM32 app that implements a `type=2` verify:

- `type=2` + **correct** PIN → compares the 4 digits byte by byte against the
  stored PIN; on a match it clears some display/error state and returns
  `status 0`.
- `type=2` + **wrong** PIN → returns `status 3`.

This is deliberately different from older "pinunlock" patches (v3.6.6 / v3.6.7),
which returned success for *any* value, and from v3.6.8, which was pulled because
it **broke charging** via a write to a mode byte (`0x2000150C`) that also affects
blade calibration. The honest-verify patch compares the PIN for real and does
**not** write that mode byte.

## ⚠️ v3.6.99 result: verify works, unlock does NOT (verified live 2026-11-22)

Flashed as v3.6.99 and tested on a mower that was **genuinely locked**
(`error_status 151`, real anti-theft lock after a power-off):

- `type=2` + correct PIN → the action returns `status 0` / `{ok:true}`.
- **But the mower stays locked at `151`.** The remote call reports success and
  the lock does not clear.

Cause, from disassembly: the real lock gate is the `no_pin_code` bit (bit 16,
`0x10000`) of the error bitmask in RAM at `0x200002E0`. The injected `type=2`
handler writes UI/state RAM (`0x368` / `0x4CE` / `0x774` / `0x775` / `0x77C`)
**but never clears that bit**, so the honest comparison is correct but the unlock
side-effect is incomplete: it clears display/error scratch state, not the gate
that keeps the mower at `151`.

> Correction (confirmed by disassembly scan): the lock is **RAM-only** — there is
> no persistent flag in the backup/RTC domain (`0x40023800`) involved, contrary to
> an earlier guess. Clearing bit 16 of the `0x200002E0` mask is all that is needed.
> Scan evidence: `clr_incident(16)` is never called anywhere in stock and
> `reset_total` has no callers, i.e. stock only clears bit 16 via the screen path.

## Attempt 2: v3.6.100 — live-tested, INSUFFICIENT (FSM re-asserts the lock)

A follow-up patch tried to clear the gate on a verified PIN:

- Base = v3.6.99 (same redirect + honest `type=2` verify).
- On the **correct-PIN** path, the exit at `0x0805E4C8` jumps to a small stub in
  free flash (`0x0805E4E0`): `movs r0,#0x10; movs r1,#0; bl clr_incident
  (0x08027A94); b.w <exit>`, which clears bit 16 (`error_set_flag 0x14000 →
  0x4000`).
- **Wrong PIN** path untouched (`status 3`). It does **not** touch EEPROM `0x75`.
- Version byte `0x64` (= 100); CRC recalculated and consistent.

**Live test (2026-11-22): FAILED.** The chip was flashed and confirmed running
v3.6.100 (`chassis_board_version 3 6 100`), but the mower **stays locked**: MQTT
reports `error_status 151` every frame. `type=2` + correct PIN returns `status 0`
and `clr_incident(0x10)` does drop bit 16 — **once** — but the lock FSM
(`0x08030B00`, RAM counter `0x200000AC`) **re-asserts `set_incident(16)` every
~10 iterations**. Clearing the bit in the verify handler is not enough; the FSM
keeps the lock up as long as its gate still reads "locked".

Root cause so far (read-only disasm):

- **Gate A** (`0x08019704`) reads EEPROM reg `0x75` (factory byte `'9'`, never
  written). This is **not** the live lock — do not touch it.
- The **post-power-off lock lives in gate B** (~`0x08019744`), which reads EEPROM
  reg `0x1f`. The exact variable that the **physical-screen** PIN flips to
  "unlocked" is **not yet pinpointed** — that is the missing piece for a possible
  `v3.6.101`.

**Status: still not solved.** v3.6.99 verifies but does not clear; v3.6.100 clears
the bit but the FSM re-locks. No patch unlocks a real lock yet. The physical
screen remains the only *proven* way to clear a real lock.

## How the MCU flasher actually works (confirmed, reusable)

This is the part that is **solid and useful regardless of the PIN question**: you
do **not** need the OTA service to flash the chassis MCU. The OTA service
(`/ota_upgrade_srv`, `platform_msgs/srv/OtaUpgradeSys`) is for the **OS**
(curl / `.deb` / MD5). The **MCU** flasher is in `chassis_control_node`, class
`CChassisMcuUpdata::check_mcu_version_and_updata()`, and it runs **at node
startup**:

1. `scanFiles()` lists the `.bin` files in
   `.../install/chassis_control/share/chassis_control/MCU_BIN/` whose name starts
   with `novabot_stm32f407` and ends in `.bin`.
2. It parses the version from the **file name** (three base-10 `strtol` over the
   `vX_Y_Z` tokens) and compares it to the version the MCU reports over serial.
3. Condition is **`if (name_version != running_version) → startMcuUpdata(path)`**
   — note it is `!=`, **not** `>`, so **downgrades work** too.
4. `startMcuUpdata`: `goto_IAP` → `iap_SendFileSize` → `iap_SendBlkData`
   (blocks) → `iap_SendCrcData`; the STM32 bootloader validates the embedded CRC.
5. The node has `respawn=True` (`novabot_chassis_start.launch.py`), so **killing
   the node's PID relaunches it in ~2 s** and re-triggers the check. No OTA, no
   special message — just leave the right `.bin` in `MCU_BIN/` and restart the
   node.

Binary layout we confirmed (STM32F407):

- The `.bin` is **app only**, from `0x08010000` (sectors 4–7). The bootloader
  (`0x08000000`–`0x0800BFFF`) is untouched by the app / IAP path.
- Embedded CRC is at **file offset `0x6BA40`**, stored big-endian, poly
  `0x04C11DB7`, init `0xFFFFFFFF`.
- Version bytes are at **file offset `0x47638`–`0x4763A`** and must match the
  name.
- The app verifies its own CRC at boot; if it is wrong it hangs and will not talk
  over USB, so **always CRC-check the `.bin` before copying it**.

### Flashing procedure (over Wi-Fi / SSH, mower in the base, battery full)

1. **Pre-flight**: verify the CRC at offset `0x6BA40` and the version byte at
   `0x4763A` match the file name.
2. `scp` the binary into `MCU_BIN/` and verify its md5 on the mower.
3. Leave **exactly one** `.bin` in `MCU_BIN/` (move the stock one out — avoids
   `readdir` ambiguity). Keep backups **outside** that folder.
4. `kill` the chassis node PID → `respawn` re-runs the check → detects
   `name != running` → flashes over IAP.
   - Caveat: `pgrep -f chassis_control_node` inside `ssh '…'` also matches your
     own shell; use `pgrep -f "[c]hassis_control_node --ros"` or `pidof`.
5. ~35 s later the log shows the new `chassis_board_version`. Because the running
   version now equals the file-name version, the next startup says "No upgrade
   required" — **no reflash loop**.

### Rollback

Put the **stock** binary back as the only `.bin` in `MCU_BIN/` and restart the
node. Keep a verified backup of the stock firmware off to the side first.

### Do NOT touch

- The GNSS/RTK module (`um960_upgrade`, Unicore UM960).
- The mode byte `0x2000150C` — writing it breaks blade calibration (this is what
  the pulled v3.6.8 did).

### Safe dry-run before anything real

To prove the flasher mechanism without risk, flash an identical-content binary
under a different version name up and back down (e.g. `3.6.0 → 3.6.1 → 3.6.0`),
mower in the base and charging, triggered only by `kill`-ing the node. It
confirms the respawn-driven flasher works and recovers, without opening the mower
or power-cycling it. After each flash the MCU raises `no_pin_code` +
`charge_stop`, so the PIN has to be entered once afterwards.

## Status / credit

- MCU flasher mechanism: **confirmed and reusable.**
- Gate analysis: **confirmed** — the reported lock is bit 16 (`0x10000`) of the RAM
  mask at `0x200002E0`, RAM-only, no RTC persistence; but a **lock FSM**
  (`0x08030B00`) re-asserts it from a gate that reads EEPROM reg `0x1f`.
- Honest-verify `type=2` patch (v3.6.99): **flashed + live-tested; returns status
  0/3 correctly; does NOT clear a real lock.**
- Clear-the-gate patch (v3.6.100): **flashed + live-tested; INSUFFICIENT** — clears
  bit 16 once, the FSM re-asserts it; mower stays at `151`.
- Open question for a possible v3.6.101: the exact variable the **physical-screen**
  PIN flips at EEPROM reg `0x1f` / gate B (~`0x08019744`) to make the FSM report
  "unlocked".

If any of this is useful, or someone knows which variable the screen path clears
to satisfy gate B, we would love to hear it.
