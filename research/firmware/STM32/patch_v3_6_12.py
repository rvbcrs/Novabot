#!/usr/bin/env python3
"""
Create v3.6.12 STM32 firmware: NOP motor-blocking calls, keep display indicator

FULL ANALYSIS of check_pin_lock() @ 0x08027880 (file offset 0x17880):

  The function has two main paths:
  1. lock_state == 0 (normal): battery voltage check + counter logic
  2. lock_state != 0 (PIN failure): state machine (1→2→3→0)

  Path 1 (counter > 200, every ~20 seconds when voltage >= 19V):
    0x178AE: counter = 0                     (reset counter)
    0x178BA: BL display_lock(GPIOA, 2, 1)    → GPIO PA1 HIGH (display indicator)
    0x178C0: BL set_error_byte(2)            → writes error_byte to RAM 0x20000774
    0x178C8: BL function3(7, 0)              → sets incident flag 7 (64-bit flags)
    0x178CC: B end_section

  Path 2 state 1 (entered by external trigger only, not by counter):
    0x178DC: BL display_lock(GPIOA, 2, 0)    → GPIO PA1 update
    0x178E4: STRB error_byte = 2             → direct write to 0x20000774
    ... timer logic ...

  end_section (ALWAYS reached — critical for battery monitoring):
    0x17974: BL get_battery_voltage()
    0x17984: if voltage < 15V → clear lock_state, counter, GPIO, error_byte
    0x179A8: BL get_battery_func2()
    ... buzzer/alarm logic ...

  FUNCTION ANALYSIS:
    display_lock() @ 0x0801516C = 5 instructions, just GPIO BSRR write (PA1 set/reset)
    set_error_byte() @ 0x08027A2C = 3 instructions, just STRB R0 to error_byte addr
    function3() @ 0x0804AEE4 = incident flag setter (bit 7 of 64-bit flags)
    battery_voltage() @ 0x8030024 = pure ADC read, returns float in S0
    battery_func2() @ 0x803010C = pure ADC read (different channel), returns float

  MOTOR BLOCKING CHAIN:
    set_error_byte(2) → error_byte = 2 → CMD 0x20 reports 2 →
    chassis_control_node reads → sets error_no_pin_code = true →
    CChassisControl blocks motor commands

    function3(7, 0) → sets incident flag → ChassisIncident topic →
    may cause additional blocking in chassis_control_node

  WHY v3.6.10 DIDN'T FIX MOTORS:
    v3.6.10 NOP'd only the STRB at 0x178E4 (state 1 error_byte write).
    But the BL set_error_byte(2) at 0x178C0 (state 0 lock trigger) was
    NOT NOP'd. So error_byte was still set to 2 every ~20 seconds.
    The v3.6.10 test showing error_no_pin_code=False was likely done
    within the first 20 seconds before the counter reached 200.

  WHY v3.6.11 FIXED MOTORS BUT "BROKE CHARGING":
    v3.6.11 changed CMP threshold to 255. Counter wraps at 255→0, so
    the lock logic NEVER fires. No error_byte, no incident flag, no GPIO.
    Motors work perfectly. But the display no longer shows the PIN lock
    indicator (GPIO PA1 never set), which the user interpreted as
    "charging broken" — the missing display message. Actual charging
    is likely fine (battery was at 99-100%, 0mA current = normal for full).

FIX (v3.6.12):
    NOP the motor-blocking calls but KEEP the display GPIO toggle:
    1. KEEP CMP R1, #200 at 0x178AA (original threshold, lock logic fires)
    2. KEEP BL display_lock at 0x178BA (GPIO PA1 indicator stays visible!)
    3. NOP  BL set_error_byte(2) at 0x178C0 (4 bytes → 2x NOP)
    4. NOP  BL function3(7,0) at 0x178C8 (4 bytes → 2x NOP)
    5. NOP  STRB at 0x178E4 (2 bytes → 1x NOP, same as v3.6.10)

    Counter > 200 path now does:
      - Reset counter to 0      ✓ (original behavior)
      - Set GPIO PA1 HIGH       ✓ (display indicator shows!)
      - set_error_byte(2)       ✗ NOP'd (no motor block)
      - function3(7,0)          ✗ NOP'd (no incident flag)
      - Branch to end_section   ✓ (battery monitoring intact)

    Expected result:
      - Motors: WORK (error_byte always 0 → error_no_pin_code never set)
      - Display: shows PIN indicator (GPIO PA1 toggles every ~20s)
      - Charging: WORKS (end_section battery checks intact)
      - User sees "message on screen" again

Input:  v3.6.7 (with PIN verify/clear patches)
Output: v3.6.12 (+ motor-blocking NOP patches)
"""
import struct
import os
import sys

# === PATCH LOCATIONS ===
# State 0 lock logic (counter > 200 path):
SET_ERROR_BL_OFFSET = 0x178C0   # BL set_error_byte(2) — 4 bytes
FUNCTION3_BL_OFFSET = 0x178C8   # BL function3(7,0) — 4 bytes
# State 1 handler:
ERROR_STRB_OFFSET   = 0x178E4   # STRB R0, [R1] (error_byte = 2) — 2 bytes

# Verification offsets:
CMP_THRESHOLD_OFFSET = 0x178AA  # CMP R1, #0xC8 — must be 0xC8 (200)
DISPLAY_BL_OFFSET    = 0x178BA  # BL display_lock — must NOT be NOP'd

VERSION_OFFSET = 0x4763A        # version byte
CRC_RANGE = 0x6BA40             # bytes covered by CRC
CRC_OFFSET = 0x6BA40            # where CRC is stored

THUMB_NOP = bytes([0x00, 0xBF])     # 16-bit Thumb NOP
THUMB_NOP2 = bytes([0x00, 0xBF, 0x00, 0xBF])  # 2x NOP for 32-bit instruction replacement

# Expected bytes at patch locations (v3.6.7):
EXPECTED_SET_ERROR_BL = bytes([0x00, 0xF0, 0xB4, 0xF8])   # BL +offset to set_error_byte
EXPECTED_FUNCTION3_BL = bytes([0x23, 0xF0, 0x0C, 0xFB])   # BL +offset to function3
EXPECTED_ERROR_STRB   = bytes([0x08, 0x70])                 # STRB R0, [R1, #0]
EXPECTED_CMP_BYTE     = 0xC8                                # CMP R1, #200


def stm32_hw_crc32(data, length):
    """Emulate STM32 hardware CRC-32 (poly 0x04C11DB7, REV byte-swap)."""
    crc = 0xFFFFFFFF
    for i in range(0, length, 4):
        word = struct.unpack('<I', data[i:i+4])[0]
        word = (((word >> 24) & 0xFF) |
                ((word >>  8) & 0xFF00) |
                ((word <<  8) & 0xFF0000) |
                ((word << 24) & 0xFF000000))
        crc ^= word
        for _ in range(32):
            if crc & 0x80000000:
                crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF
            else:
                crc = (crc << 1) & 0xFFFFFFFF
    return crc


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(script_dir, "novabot_stm32f407_v3_6_7_NewMotor25082301_pin_unlock.bin")
    dst = os.path.join(script_dir, "novabot_stm32f407_v3_6_12_NewMotor25082301.bin")

    # Read firmware
    with open(src, 'rb') as f:
        fw = bytearray(f.read())
    print(f"Read {len(fw)} bytes from v3.6.7")

    # Verify version
    ver = fw[VERSION_OFFSET]
    if ver != 0x07:
        print(f"WARNING: Version byte is 0x{ver:02X}, expected 0x07 (v3.6.7)")

    # Verify check_pin_lock() entry is intact (not v3.6.8 BX LR)
    entry = bytes(fw[0x17880:0x17882])
    if entry == bytes([0x70, 0x47]):
        print("ERROR: check_pin_lock() entry is BX LR (v3.6.8 style) — use v3.6.7!")
        sys.exit(1)
    print(f"check_pin_lock() entry: {entry.hex()} (PUSH — function intact)")

    # Verify CMP threshold is still 200 (0xC8) — not already patched to 255
    cmp_byte = fw[CMP_THRESHOLD_OFFSET]
    if cmp_byte != EXPECTED_CMP_BYTE:
        if cmp_byte == 0xFF:
            print(f"WARNING: CMP threshold is 0xFF (v3.6.11 style). v3.6.12 keeps it at 0xC8.")
        else:
            print(f"WARNING: CMP threshold is 0x{cmp_byte:02X}, expected 0x{EXPECTED_CMP_BYTE:02X}")
    else:
        print(f"CMP threshold at 0x{CMP_THRESHOLD_OFFSET:X}: 0x{cmp_byte:02X} (200) — keeping as-is")

    # Verify BL set_error_byte at 0x178C0
    current_set_error = bytes(fw[SET_ERROR_BL_OFFSET:SET_ERROR_BL_OFFSET+4])
    if current_set_error == THUMB_NOP2:
        print(f"BL set_error_byte at 0x{SET_ERROR_BL_OFFSET:X}: already NOP'd")
    elif current_set_error != EXPECTED_SET_ERROR_BL:
        print(f"WARNING: BL set_error_byte at 0x{SET_ERROR_BL_OFFSET:X}: {current_set_error.hex()}")
        print(f"  Expected: {EXPECTED_SET_ERROR_BL.hex()}")
    else:
        print(f"BL set_error_byte at 0x{SET_ERROR_BL_OFFSET:X}: {current_set_error.hex()} → NOP NOP")

    # Verify BL function3 at 0x178C8
    current_func3 = bytes(fw[FUNCTION3_BL_OFFSET:FUNCTION3_BL_OFFSET+4])
    if current_func3 == THUMB_NOP2:
        print(f"BL function3 at 0x{FUNCTION3_BL_OFFSET:X}: already NOP'd")
    elif current_func3 != EXPECTED_FUNCTION3_BL:
        print(f"WARNING: BL function3 at 0x{FUNCTION3_BL_OFFSET:X}: {current_func3.hex()}")
        print(f"  Expected: {EXPECTED_FUNCTION3_BL.hex()}")
    else:
        print(f"BL function3 at 0x{FUNCTION3_BL_OFFSET:X}: {current_func3.hex()} → NOP NOP")

    # Verify STRB at 0x178E4
    current_strb = bytes(fw[ERROR_STRB_OFFSET:ERROR_STRB_OFFSET+2])
    if current_strb == THUMB_NOP:
        print(f"STRB at 0x{ERROR_STRB_OFFSET:X}: already NOP'd (from v3.6.10)")
    elif current_strb != EXPECTED_ERROR_STRB:
        print(f"WARNING: STRB at 0x{ERROR_STRB_OFFSET:X}: {current_strb.hex()}")
    else:
        print(f"STRB at 0x{ERROR_STRB_OFFSET:X}: {current_strb.hex()} → NOP")

    # Verify BL display_lock at 0x178BA is NOT being modified
    display_bl = bytes(fw[DISPLAY_BL_OFFSET:DISPLAY_BL_OFFSET+4])
    print(f"BL display_lock at 0x{DISPLAY_BL_OFFSET:X}: {display_bl.hex()} — KEEPING (GPIO indicator)")

    # Context dump for safety
    print(f"\nContext (0x178B8-0x178D0):")
    for i in range(0x178B8, 0x178D0, 4):
        b = fw[i:i+4].hex()
        marker = ''
        if i == 0x178BA: marker = ' ← display_lock (KEEP)'
        elif i == 0x178BE: marker = ' ← MOVS R0,#2 (harmless)'
        elif i == 0x178C0: marker = ' ← set_error_byte (NOP THIS)'
        elif i == 0x178C4: marker = ' ← MOVS R0,#7 (harmless after NOP)'
        elif i == 0x178C8: marker = ' ← function3 (NOP THIS)'
        elif i == 0x178CC: marker = ' ← B end_section'
        print(f"  {i:05X}: {b}{marker}")

    # === APPLY PATCHES ===
    print("\n--- Applying patches ---")

    # Patch 1: NOP BL set_error_byte(2) at 0x178C0 (4 bytes)
    fw[SET_ERROR_BL_OFFSET:SET_ERROR_BL_OFFSET+4] = THUMB_NOP2
    print(f"  0x{SET_ERROR_BL_OFFSET:X}: BL set_error_byte → NOP NOP")

    # Patch 2: NOP BL function3(7,0) at 0x178C8 (4 bytes)
    fw[FUNCTION3_BL_OFFSET:FUNCTION3_BL_OFFSET+4] = THUMB_NOP2
    print(f"  0x{FUNCTION3_BL_OFFSET:X}: BL function3 → NOP NOP")

    # Patch 3: NOP STRB error_byte at 0x178E4 (2 bytes)
    fw[ERROR_STRB_OFFSET:ERROR_STRB_OFFSET+2] = THUMB_NOP
    print(f"  0x{ERROR_STRB_OFFSET:X}: STRB error_byte → NOP")

    # Update version: v3.6.12
    fw[VERSION_OFFSET] = 0x0C
    print(f"  Version: v3.6.{ver} → v3.6.12")

    # Recompute CRC
    new_crc = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
    struct.pack_into('<I', fw, CRC_OFFSET, new_crc)
    print(f"  CRC: 0x{new_crc:08X}")

    # Verify CRC
    v = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
    s = struct.unpack('<I', fw[CRC_OFFSET:CRC_OFFSET+4])[0]
    assert v == s, f"CRC verify failed: {v:#x} != {s:#x}"

    # Save
    with open(dst, 'wb') as f:
        f.write(fw)
    print(f"\nSaved: {os.path.basename(dst)} ({len(fw)} bytes)")

    # Verify the patched result
    print(f"\nVerification (patched bytes):")
    for offset, name, size in [
        (SET_ERROR_BL_OFFSET, "set_error_byte BL", 4),
        (FUNCTION3_BL_OFFSET, "function3 BL", 4),
        (ERROR_STRB_OFFSET, "error_byte STRB", 2),
        (DISPLAY_BL_OFFSET, "display_lock BL", 4),
        (CMP_THRESHOLD_OFFSET, "CMP threshold", 1),
    ]:
        b = fw[offset:offset+size].hex()
        print(f"  0x{offset:X} ({name}): {b}")

    print(f"""
{'='*60}
v3.6.12: NOP MOTOR-BLOCKING CALLS, KEEP DISPLAY INDICATOR
{'='*60}
Base: v3.6.7 (PIN verify/clear patches intact)

Patches applied:
  0x{SET_ERROR_BL_OFFSET:X}: BL set_error_byte(2) → NOP NOP  (no error_byte write)
  0x{FUNCTION3_BL_OFFSET:X}: BL function3(7,0)    → NOP NOP  (no incident flag)
  0x{ERROR_STRB_OFFSET:X}: STRB error_byte       → NOP      (state 1 write, safety)

Kept intact:
  0x{DISPLAY_BL_OFFSET:X}: BL display_lock        → KEPT     (GPIO PA1 indicator!)
  0x{CMP_THRESHOLD_OFFSET:X}: CMP R1, #200          → KEPT     (lock logic fires normally)
  end_section: battery voltage checks             → KEPT     (charging detection)

check_pin_lock() behavior with v3.6.12:
  ✓ Battery voltage check runs (end_section intact)
  ✓ Counter increments + resets at >200 (normal cycling)
  ✓ GPIO PA1 toggles (display indicator shows message!)
  ✗ error_byte NEVER written (both write locations NOP'd)
  ✗ incident flag NEVER set (function3 call NOP'd)
  ✓ Low voltage handler (V<15V) clears state (safety intact)
  ✓ Buzzer/alarm logic runs (post_check intact)

Expected result:
  - error_no_pin_code: False (no error_byte ever set)
  - Motors: WORK (chassis_control never blocks)
  - Display: shows indicator (GPIO PA1 high every ~20s)
  - Charging: WORKS (battery monitoring intact)
{'='*60}
""")


if __name__ == '__main__':
    main()
