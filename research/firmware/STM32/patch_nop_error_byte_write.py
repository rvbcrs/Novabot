#!/usr/bin/env python3
"""
Create v3.6.10 STM32 firmware: NOP the error_byte write in check_pin_lock()

PROBLEM:
  v3.6.7 has our PIN verify/clear patch, but check_pin_lock() still writes
  error_byte=0x02 at boot (~20s). chassis_control_node reads CMD 0x20 with
  error_byte=2 → sets error_no_pin_code flag → CChassisControl blocks motors.

  PIN verify (type=2) clears the flag via set_pincode_flag(false), BUT a stale
  CMD 0x20 response in the serial buffer re-sets error_no_pin_code immediately.
  Since the flag is ONLY cleared by set_pincode_flag(false), it stays set forever.

v3.6.8 FIX (FAILED):
  NOP'd entire check_pin_lock() with BX LR at entry → error_byte never set
  BUT also killed the battery voltage check side effect → charging broken
  (battery_state stayed DISCHARGE)

v3.6.10 FIX (SURGICAL):
  NOP only the STRB instruction at 0x178e4 that writes 0x02 to error_byte.
  The rest of check_pin_lock() runs normally:
  - Battery voltage check (charging detection) still works
  - State machine still runs
  - Counter still increments
  - But error_byte is NEVER written → CMD 0x20 reports 0 → no error_no_pin_code

  3 instructions at the write site:
    0x178e0: 02 20    MOVS R0, #0x02    (load error code into R0)
    0x178e2: 46 49    LDR  R1, [PC, #x]  (load error_byte address into R1)
    0x178e4: 08 70    STRB R0, [R1, #0]  (WRITE error_byte = 0x02) ← NOP THIS

  Only the STRB has side effects. MOVS and LDR are harmless.
  Replacing STRB with NOP (00 BF) is safe.

Input:  v3.6.7 (with type=2/3 PIN patch)
Output: v3.6.10 (+ error_byte write NOP)
"""
import struct
import sys
import os

ERROR_BYTE_WRITE_OFFSET = 0x178e4  # STRB R0, [R1, #0] that writes error_byte
VERSION_OFFSET = 0x4763A           # version byte
CRC_RANGE = 0x6BA40                # bytes covered by CRC
CRC_OFFSET = 0x6BA40               # where CRC is stored

THUMB_NOP = bytes([0x00, 0xBF])    # Thumb NOP
EXPECTED_STRB = bytes([0x08, 0x70])  # STRB R0, [R1, #0]


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


script_dir = os.path.dirname(os.path.abspath(__file__))
src = os.path.join(script_dir, "novabot_stm32f407_v3_6_7_NewMotor25082301_pin_unlock.bin")
dst = os.path.join(script_dir, "novabot_stm32f407_v3_6_10_NewMotor25082301.bin")

with open(src, 'rb') as f:
    fw = bytearray(f.read())
print(f"Read {len(fw)} bytes from v3.6.7")

# Verify this is the v3.6.7 binary (not v3.6.0 or v3.6.8)
ver = fw[VERSION_OFFSET]
if ver != 0x07:
    print(f"WARNING: Version byte is 0x{ver:02X}, expected 0x07 (v3.6.7)")

# Verify context: MOVS R0, #2 before the STRB
context_before = bytes(fw[ERROR_BYTE_WRITE_OFFSET-4:ERROR_BYTE_WRITE_OFFSET])
print(f"Context before STRB: {context_before.hex()} (expect: 0220 4649 = MOVS R0,#2 + LDR R1,...)")
if context_before != bytes([0x02, 0x20, 0x46, 0x49]):
    print("ERROR: Unexpected context bytes — wrong binary or already patched?")
    sys.exit(1)

# Verify the STRB instruction
current = bytes(fw[ERROR_BYTE_WRITE_OFFSET:ERROR_BYTE_WRITE_OFFSET+2])
if current != EXPECTED_STRB:
    if current == THUMB_NOP:
        print(f"Already patched! STRB at 0x{ERROR_BYTE_WRITE_OFFSET:X} is already NOP")
        sys.exit(0)
    print(f"ERROR: Expected STRB (0870) at 0x{ERROR_BYTE_WRITE_OFFSET:X}, got {current.hex()}")
    sys.exit(1)
print(f"check_pin_lock() STRB at 0x{ERROR_BYTE_WRITE_OFFSET:X}: {current.hex()} (STRB R0,[R1,#0]) → 00BF (NOP)")

# Also verify check_pin_lock() entry is NOT NOP'd (not v3.6.8)
entry = bytes(fw[0x17880:0x17882])
if entry == bytes([0x70, 0x47]):
    print("ERROR: check_pin_lock() entry is BX LR (v3.6.8) — use v3.6.7 as input!")
    sys.exit(1)
print(f"check_pin_lock() entry at 0x17880: {entry.hex()} (PUSH — function intact, good)")

# Apply patch: NOP the STRB
fw[ERROR_BYTE_WRITE_OFFSET:ERROR_BYTE_WRITE_OFFSET+2] = THUMB_NOP

# Update version byte: v3.6.7 → v3.6.10
fw[VERSION_OFFSET] = 0x0A
print(f"Version: v3.6.{ver} → v3.6.10")

# Recompute CRC
new_crc = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
struct.pack_into('<I', fw, CRC_OFFSET, new_crc)
print(f"CRC updated: 0x{new_crc:08X}")

# Verify CRC
v = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
s = struct.unpack('<I', fw[CRC_OFFSET:CRC_OFFSET+4])[0]
assert v == s, f"CRC verify failed: {v:#x} != {s:#x}"

with open(dst, 'wb') as f:
    f.write(fw)
print(f"Saved: {os.path.basename(dst)} ({len(fw)} bytes)")

print(f"""
{'='*60}
PATCH SUMMARY (v3.6.10 — SURGICAL error_byte NOP)
{'='*60}
Base:   v3.6.7 (has type=2/3 PIN verify/clear patches)
Change: NOP STRB at file 0x{ERROR_BYTE_WRITE_OFFSET:05X}
        Was: 08 70 (STRB R0, [R1, #0] — writes error_byte=0x02)
        Now: 00 BF (NOP — error_byte never written)

check_pin_lock() STILL RUNS:
  ✓ Battery voltage check (charging detection)
  ✓ State machine logic
  ✓ Counter increments
  ✗ error_byte write (NOP'd)

Result:
  - error_byte always 0 → CMD 0x20 reports 0
  - chassis_control_node never sets error_no_pin_code
  - CChassisControl allows motor commands
  - Charging detection still works (battery voltage check intact)
{'='*60}
""")
