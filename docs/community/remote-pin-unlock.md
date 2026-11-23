# Remote PIN unlock — WORKING (v3.6.101, live-tested twice)

> Community research notes from a Novabot owner running OpenNova.
> **Status: solved.** A patched chassis MCU firmware (**v3.6.101**) unlocks a real
> anti-theft PIN lock remotely, with the correct PIN only, and with no side
> effects seen. Live-tested on a genuinely locked mower on **2026-11-22** and again
> after a deliberate power-off on **2026-11-23** (unlocked ~9 s after boot; the mower
> then docked, charged and mowed normally). The anti-theft is preserved: a wrong
> PIN is rejected (`status 3`) and the lock comes back on every boot.
> The history below (v3.6.99 / v3.6.100) explains the two wrong turns on the way.
>
> 🇦🇷 **Resumen en español al final del documento.**
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
> (`0x10000`) of `error_set_flag` (a `u32` at `0x20001A18`), which the MCU
> serialises to the host via `get_error_mask` (`0x08030314`); the Linux side turns
> it into error `151`. It is a plain error bit, **not** a `lock_state` and **not**
> stored in EEPROM — nothing re-asserts it at runtime; it only comes back on the
> next boot (that is where the anti-theft lives).
>
> The firmware tracks errors as numbered **incidents**. The PIN lock is
> **incident 13 (`0xd`)**: at boot `set_incident(0xd)` (`0x08045952`) raises the
> `0x10000` bit. **Do not confuse it with incident 16 (`0x10`), which is an IMU
> error** — the chip talks I2C to the IMU at `0x68` (reg `0x75` = `WHO_AM_I`, reg
> `0x1f` = accel/gyro data); incident 16 has nothing to do with the PIN. Stock
> clears incident 13 only through the physical-screen path; the remote channel has
> to clear it explicitly.

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

Cause, from disassembly: the real lock is the `no_pin_code` bit (`0x10000`) of
`error_set_flag`, raised by incident 13 (`0xd`). The injected `type=2` handler
writes UI/state RAM (`0x368` / `0x4CE` / `0x774` / `0x775` / `0x77C`) **but never
clears that incident**, so the honest comparison is correct but the unlock
side-effect is incomplete: it clears display/error scratch state, not the bit that
keeps the mower at `151`.

## Attempt 2: v3.6.100 — live-tested, FAILED (cleared the wrong incident)

A follow-up patch tried to clear the incident on a verified PIN, but targeted the
**wrong incident number**:

- Base = v3.6.99 (same redirect + honest `type=2` verify).
- On the **correct-PIN** path, the exit at `0x0805E4C8` jumps to a small stub in
  free flash (`0x0805E4E0`): `movs r0,#0x10; movs r1,#0; bl clr_incident
  (0x08027A94)`, intending to clear the lock.
- Version byte `0x64` (= 100); CRC recalculated and consistent.

**Live test (2026-11-22): FAILED.** The chip ran v3.6.100 but the mower stayed at
`151`. Root cause: `0x10` is **incident 16 (the IMU error), not the PIN lock**.
Worse, `clr_incident`'s switch has **no case for `0x10`**, so the stub only touched
the 64-bit incident mask and **never cleared the `0x10000` bit in `error_set_flag`**
— the lock was never even addressed.

## Attempt 3: v3.6.101 — correct incident (`0xd`) — ✅ WORKS

The fix is to clear **incident 13 (`0xd`)** instead of 16:

- Identical to v3.6.100 except one instruction: `movs r0,#0xd` instead of
  `movs r0,#0x10`.
- `clr_incident`'s **case `0xd`** (`0x08027B9C`) does `[0xa] bic #1`, i.e. it turns
  off the `0x10000` bit of `error_set_flag` — exactly undoing the boot's
  `set_incident(0xd)` (`0x08045952`).
- Version byte `0x65` (= 101); CRC recalculated and verified.

**Live test 1 (2026-11-22 19:39):** mower genuinely locked at `151` →
`type=2` + correct PIN → `status 0`, `error_set_flag` dropped the `0x10000` bit,
MQTT `error_status` went `151 → 0`.

**Live test 2 (2026-11-23 12:42), from a cold boot:** owner powered the mower off and
on with the button. Chassis log: `chassis_board_version: 3 6 101`, then
`error_set_flag = 65536` + `error_no_pin_code` at 12:42:20 (locked, as designed).
An automatic watcher sent the verify at 12:42:31 → `CMD_PIN_CODE_SET done` →
`error_set_flag = 0` the same millisecond, `Goal succeeded`, MQTT `151 → 0`. The
mower was then sent to the dock (`go_to_charge`), charged, and started a normal
coverage run (`Work:MOVING`, error 0). No charging, blade or IMU side effects.

## How to use it (once v3.6.101 is on the chip)

1. On the mower, with the ROS 2 environment loaded
   (`source /opt/ros/galactic/setup.bash`, `source /root/novabot/install/setup.bash`,
   `ROS_LOCALHOST_ONLY=1`, `RMW_IMPLEMENTATION=rmw_cyclonedds_cpp`,
   `ip link set lo multicast on`), send the action
   `/chassis_pin_code_set` (`novabot_msgs/action/ChassisPinCodeSet`) with
   **`type: 2`** and `code: "<PIN>"`. From Python (`rclpy.action.ActionClient`)
   pass the PIN over **stdin**, never as a command-line argument.
2. Result `status 0` = accepted; `status 3` = wrong PIN (lock stays; there is no
   attempt counter, but do not loop on a rejected PIN).
3. **Verify the real lock, not the action result:** the last
   `error_set_flag = N` line in `chassis_control_node_*.log` must no longer have bit
   `0x10000` (`81920`/`65536` = locked, `16384`/`0` = unlocked). The log can lag a
   second or two — poll for up to ~10 s before concluding it is still locked.
   On the server side, MQTT `report_state_robot.error_status` leaves `151`.
4. **Mask the PIN in the logs afterwards.** `chassis_control_node` writes it in clear
   text twice: `send action_config_pin_code_set = NNNN` and
   `Goal succeeded ,PinCode_data = NNNN`. Overwrite only the digits in place (same
   length, no truncate) so you do not race the node that is still appending, e.g.
   regex `(?i)(pin_?code[a-z_]* ?[=:] ?"?)(\d{4,8})` → replace group 2 with `*`.

Gotchas we hit:

- The "Enter PIN" prompt on the **screen** can stay up after the unlock — that is
  just the keypad lock of the display. Trust `151` / bit `0x10000`, not the screen.
- `error_set_flag` bit `0x100000` (`1048576`) is **incident 44 = blade-height (lift)
  motor**, not the PIN.
- `report_exception_state.no_set_pin_code` is **not** the lock (see above).

Automating it (what we run): a small watcher follows the server's decrypted MQTT
stream; on `error_status 151/152` it runs the verify (PIN from an encrypted vault,
piped over stdin), waits for `151` to clear, sends `go_to_charge` if the mower is not
docked, and notifies the owner. A rejected PIN is never retried in the same episode.

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
- Incident analysis: **confirmed** — the PIN lock is **incident 13 (`0xd`)**, which
  raises the `0x10000` bit of `error_set_flag`; incident 16 (`0x10`) is a separate
  **IMU** error (I2C `0x68`, regs `0x75`/`0x1f`), unrelated to the PIN.
- Honest-verify `type=2` patch (v3.6.99): verified the PIN correctly but did not
  clear the lock (superseded).
- v3.6.100: cleared incident `0x10` (IMU) by mistake — failed (superseded).
- **v3.6.101: ✅ WORKS** — `clr_incident(0xd)` on a verified PIN. Live-tested
  2026-11-22 and 2026-11-23 (cold boot → unlocked in ~9 s → docked, charged, mowed).
  Wrong PIN → `status 3`, lock intact. Lock returns on every boot (anti-theft kept).

Happy to share the exact patch bytes/diff against stock v3.6.20 with the
maintainer if it is useful for the project.

## Resumen en español

**Se logró destrabar a distancia el PIN anti-robo, sin errores.** Después de un
apagado completo, el chip de motores (STM32) arranca trabado (error `151`) y el stock
solo se destraba tipeando el PIN en la pantalla física.

**Cómo se logró:**

1. **Encontrar el candado real.** Desensamblando el firmware stock v3.6.20 se vio que el
   candado es el **incidente 13 (`0xd`)**: al arrancar, `set_incident(0xd)` prende el bit
   `0x10000` (`no_pin_code`) del `error_set_flag`, y Linux lo traduce en el error `151`.
   El único que lo apagaba era el camino de la pantalla (`clr_incident(0xd)`).
2. **Agregar un "verify" honesto al chip.** El stock ignoraba el comando remoto
   `CMD 0x23 type=2`. El parche lo implementa: compara el PIN de verdad (correcto →
   `status 0`, incorrecto → `status 3`). No toca el byte de modo `0x2000150C` (el que
   rompía la carga en v3.6.8).
3. **Que el verify apague el candado correcto.** v3.6.100 llamaba por error al
   incidente 16 (la IMU). **v3.6.101** cambia una sola instrucción para llamar a
   `clr_incident(0xd)`: con el PIN correcto apaga el bit `0x10000` y el `151` se va.
4. **Grabarlo por Wi-Fi.** El flasheador del MCU está en `chassis_control_node`: se deja
   un único `.bin` (con CRC verificado) en `MCU_BIN/` y se reinicia el nodo; si la
   versión del nombre difiere de la que corre, la graba por IAP.
5. **Usarlo.** Action ROS 2 `/chassis_pin_code_set` con `type 2` y el PIN (por stdin,
   nunca en la línea de comandos). Se confirma mirando el `error_set_flag` real (sin el
   bit `0x10000`) y el `151` que desaparece en MQTT. Después se enmascara el PIN, que el
   nodo deja en claro en su log.

**Pruebas en vivo:** 22-11-2026 (trabado real → destrabado) y 23-11-2026 (apagado y
prendido a propósito → un vigía automático lo destrabó a los ~9 s → volvió a la base,
cargó y salió a cortar normal). El PIN equivocado se rechaza y el candado vuelve en cada
arranque: **el anti-robo queda intacto**.
