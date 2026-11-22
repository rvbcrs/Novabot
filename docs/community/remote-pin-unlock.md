# Remote PIN unlock while keeping the anti-theft lock (STM32 "honest verify")

> Community note contributed by a Novabot owner running OpenNova on their own
> network. Shared so the project and other owners can benefit, and as an offer
> for the maintainer to fold any of it into the project if useful.
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
  touch `LOCK_STATE`, the error byte, or the `no_pin_code` bit. On stock, the
  lock is cleared **only** by typing the PIN on the physical screen.
- There is **no attempt counter / lockout** on the remote PIN path, so repeated
  remote attempts do not brick anything (the fear of a lockout was unfounded for
  this path).

The ROS2 action the app uses, `/chassis_pin_code_set`
(`novabot_msgs/action/ChassisPinCodeSet`, goal `uint8 type` + `string code`,
result `uint8 status`), just forwards that same `CMD 0x23`. So end-to-end it can
**read** (`type=0`) and **change** (`type=1`) the PIN remotely, but it **cannot
unlock**, because the stock MCU ignores `type=2`.

This also explains an easy misread: the app sends `type=2` to verify/unlock, and
on stock firmware that always comes back as a failure — not because the PIN is
wrong, but because `type=2` is unimplemented.

> Note: `report_exception_state.no_set_pin_code` is **not** the lock flag. It is
> a separate flag ("no PIN configured"). The real lock state is in the chassis
> node's `error_set_flag` (observed `81920` = locked / asking for PIN, `16384` =
> unlocked, charging in base only).

## The fix: an "honest verify" patch (`type=2`)

We built a surgical patch to the STM32 app that implements a **real** `type=2`
verify, without weakening the anti-theft behaviour:

- `type=2` + **correct** PIN → compares the 4 digits byte by byte against the
  stored PIN; on a match it clears the display error flag, the incident byte and
  the error byte, sets `LOCK_STATE = 0xFF`, resets `LOCK_COUNTER = 0`, and
  returns `status 0` (really unlocks).
- `type=2` + **wrong** PIN → returns `status 3` (rejected, nothing cleared).
- The anti-theft lock is preserved: `LOCK_STATE` lives in RAM, so after a real
  power-off the mower asks for the PIN again. The patch does **not** disable the
  lock, it only adds a remote, PIN-checked way to clear the current session.

### Why this is different from older "pinunlock" patches

Earlier community patches (v3.6.6 / v3.6.7 "pinunlock") effectively **lied**:
the `/chassis_pin_code_set` action returned success for *any* value without
actually opening the lock, and one of them (v3.6.8) was pulled because it
**broke charging**. The root cause of the breakage was a write to a mode byte
(`0x2000150C`) that also affects blade calibration.

The "honest verify" patch is built from the v3.6.6 base (which already compares
the PIN for real) **minus** that `0x2000150C` write, and with no `type=3`
backdoor. Verified by disassembly:

- the dispatcher handles only `type=1` and `type=2`;
- it compares the four ASCII digits honestly and returns `status 0` only on a
  real match;
- on a match it touches only the lock/error state, never the mode byte.

A full static review confirmed the re-lock after power is decided solely by
`check_pin_lock` (condition `lock_state==0 && V ≥ 19.0 V && counter > 200`), and
that `LOCK_STATE` is written in only two places in the whole firmware
(`check_pin_lock` and the serial handler). Setting it to `0xFF` is therefore at
least as safe as the screen path (the screen does not set `lock_state` at all),
with the anti-theft intact.

## How the MCU flasher actually works (the useful part for everyone)

This was the biggest discovery, and it is independent of the patch: **you do not
need the OTA service to flash the chassis MCU.** The OTA service
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

## Flashing procedure (over Wi-Fi / SSH, mower in the base, battery full)

1. **Pre-flight**: verify the patch CRC at offset `0x6BA40` and the version byte
   at `0x4763A` match the file name.
2. `scp` the patch into `MCU_BIN/` and verify its md5 on the mower.
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

## Dry-run we recommend before the real thing

Before flashing anything meaningful, we did a harmless round-trip to prove the
mechanism on our own unit: flash an identical-content binary under a different
version name up and then back down (e.g. `3.6.0 → 3.6.1 → 3.6.0`), with the
mower in the base and charging, triggered only by `kill`-ing the node. It
confirmed the respawn-driven flasher works and recovers, without opening the
mower or power-cycling it. After each flash the MCU raises `no_pin_code` +
`charge_stop`, so the PIN has to be entered once afterwards.

## Status / credit

Tested on a Novabot `LFIN…` (serial truncated) with the OpenNova stack. The
honest-verify patch was validated live: `type=2` + correct PIN → `status 0`;
`type=2` + wrong PIN → `status 3`; `type=0` read → `status 0`. The underlying
flasher mechanism is the reusable finding here, independent of the PIN work.

If any of this is useful to the project, we are happy to help shape it into
whatever form the maintainer prefers.
