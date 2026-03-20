#!/usr/bin/env python3
"""
Create v3.6.11 STM32 firmware: Disable lock trigger entirely

PROBLEM:
  v3.6.10 NOP'd the error_byte write, fixing error_no_pin_code.
  But check_pin_lock() STILL runs the lock logic when counter > 200:
  - Calls display lock screen function (sets STM32 internal lock state)
  - Sets state=1 (triggers state machine cycle: 1→2→3→0→1...)
  - These side effects block motor commands at the STM32 level

  CChassisControl receives cmd_vel and calls setSpeed, but STM32
  ignores the motor commands because the lock display/state is active.

FIX:
  Change the counter comparison threshold from 200 (0xC8) to 255 (0xFF).
  Since the counter is a byte (LDRB), it wraps at 255→0 and can never
  exceed 255. So the lock logic is NEVER triggered.

  File offset 0x178aa: change byte 0xC8 → 0xFF
  This changes: CMP R1, #200 → CMP R1, #255
  The BLE at 0x178ac then ALWAYS branches (skip lock logic)

  Combined with v3.6.10's error_byte STRB NOP (dead code now):
  - Battery voltage check still runs (charging detection intact)
  - Counter increments (harmless, wraps at 255)
  - Lock logic NEVER entered (no display, no state change, no error_byte)
  - Motors enabled, charging works

Input:  v3.6.10 (with error_byte STRB NOP)
Output: v3.6.11 (+ lock trigger threshold 200→255)
"""
import struct
import os

CMP_OFFSET = 0x178aa      # CMP R1, #immediate — the counter threshold byte
VERSION_OFFSET = 0x4763a   # version byte
CRC_RANGE = 0x6ba40
CRC_OFFSET = 0x6ba40

EXPECTED_CMP_BYTE = 0xC8   # current: CMP R1, #200
NEW_CMP_BYTE = 0xFF        # new: CMP R1, #255


def stm32_hw_crc32(data, length):
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


script_dir = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(script_dir, "novabot_stm32f407_v3_6_10_NewMotor25082301.bin")
dst = os.path.join(script_dir, "novabot_stm32f407_v3_6_11_NewMotor25082301.bin")

with open(src, 'rb') as f:
    fw = bytearray(f.read())
print(f"Read {len(fw)} bytes from v3.6.10")

# Verify CMP byte
current = fw[CMP_OFFSET]
if current != EXPECTED_CMP_BYTE:
    if current == NEW_CMP_BYTE:
        print("Already patched!")
        exit(0)
    print(f"ERROR: Expected 0x{EXPECTED_CMP_BYTE:02X} at 0x{CMP_OFFSET:X}, got 0x{current:02X}")
    exit(1)

# Verify context: STRB before, BLE after
ctx_before = fw[CMP_OFFSET-2:CMP_OFFSET]  # STRB R0, [R2, #0]
ctx_after = fw[CMP_OFFSET+2:CMP_OFFSET+4]  # BLE
print(f"Context: {ctx_before.hex()} [C8] 29 {ctx_after.hex()}")
print(f"  STRB={ctx_before.hex()} CMP_imm=0x{current:02X} CMP_opcode=0x29 BLE={ctx_after.hex()}")

# Verify STRB NOP from v3.6.10 is present
nop_at = 0x178e4
if fw[nop_at:nop_at+2] != bytes([0x00, 0xBF]):
    print(f"WARNING: Expected NOP at 0x{nop_at:X}, got {fw[nop_at:nop_at+2].hex()}")

# Verify version
ver = fw[VERSION_OFFSET]
print(f"Version: v3.6.{ver}")

# Apply patch
fw[CMP_OFFSET] = NEW_CMP_BYTE
fw[VERSION_OFFSET] = 0x0B  # v3.6.11
print(f"\nPatch: CMP R1, #0xC8 → CMP R1, #0xFF at 0x{CMP_OFFSET:X}")
print(f"Version: v3.6.{ver} → v3.6.11")

# Recompute CRC
new_crc = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
struct.pack_into('<I', fw, CRC_OFFSET, new_crc)

# Verify CRC
v = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
s = struct.unpack('<I', fw[CRC_OFFSET:CRC_OFFSET+4])[0]
assert v == s, f"CRC verify failed"
print(f"CRC updated: 0x{new_crc:08X}")

with open(dst, 'wb') as f:
    f.write(fw)
print(f"Saved: {os.path.basename(dst)} ({len(fw)} bytes)")

print(f"""
{'='*60}
v3.6.11: DISABLE LOCK TRIGGER (counter threshold 200→255)
{'='*60}
Changes from v3.6.7 base:
  0x178aa: CMP R1, #200 → CMP R1, #255  (lock never triggers)
  0x178e4: STRB NOP                      (error_byte never written)

check_pin_lock() behavior:
  ✓ Battery voltage check runs (charging detection)
  ✓ Counter increments (wraps at 255, harmless)
  ✗ Lock logic NEVER entered (counter never > 255)
  ✗ Display lock screen NEVER called
  ✗ State machine NEVER activated (stays at state=0)
  ✗ error_byte NEVER written (both NOP'd and unreachable)

Expected result:
  - error_no_pin_code: False (no error_byte set)
  - Motors: enabled (no STM32 lock state)
  - Charging: works (battery voltage check intact)
  - PIN screen: still shows at boot (counter < 255 for ~25s)
    but lock logic/motor block never triggers
{'='*60}
""")
