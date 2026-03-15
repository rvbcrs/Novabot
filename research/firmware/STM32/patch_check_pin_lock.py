#!/usr/bin/env python3
"""
Create v3.6.8 STM32 firmware: NOP check_pin_lock() at boot

v3.6.7 has our PIN verify/clear patch, but check_pin_lock() still
sets error_byte=0x02 within ~20s of boot. CChassisControl reads this
BEFORE any PIN action can be sent → error_no_pin_code → frozen mode.

This patch adds: BX LR at the entry of check_pin_lock() (0x17880),
making it return immediately. error_byte is NEVER set → no PIN error.

Input:  v3.6.7 (with type=2/3 PIN patch)
Output: v3.6.8 (+ check_pin_lock NOP)
"""
import struct
import sys

CHECK_PIN_LOCK_OFFSET = 0x17880  # check_pin_lock() entry point
VERSION_OFFSET = 0x4763A         # version byte (0x07 → 0x08)
CRC_RANGE = 0x6BA40              # bytes covered by CRC
CRC_OFFSET = 0x6BA40             # where CRC is stored

BX_LR = bytes([0x70, 0x47])     # Thumb BX LR = return immediately
EXPECTED_PUSH = bytes([0x10, 0xB5])  # PUSH {R4, LR} = original


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


src = '/tmp/v3_6_7.bin'
dst = '/tmp/novabot_stm32f407_v3_6_8_NewMotor25082301.bin'

with open(src, 'rb') as f:
    fw = bytearray(f.read())
print(f"Read {len(fw)} bytes from v3.6.7")

# Verify current bytes
current = bytes(fw[CHECK_PIN_LOCK_OFFSET:CHECK_PIN_LOCK_OFFSET+2])
if current != EXPECTED_PUSH:
    print(f"ERROR: Expected PUSH {{R4,LR}} (10B5) at 0x{CHECK_PIN_LOCK_OFFSET:X}, got {current.hex()}")
    sys.exit(1)
print(f"check_pin_lock() at 0x{CHECK_PIN_LOCK_OFFSET:X}: {current.hex()} (PUSH {{R4,LR}}) → 7047 (BX LR)")

# Verify version is 0x07
ver = fw[VERSION_OFFSET]
if ver != 0x07:
    print(f"WARNING: Version byte is 0x{ver:02X}, expected 0x07 (v3.6.7)")
print(f"Version: v3.6.{ver} → v3.6.8")

# Apply patches
fw[CHECK_PIN_LOCK_OFFSET:CHECK_PIN_LOCK_OFFSET+2] = BX_LR
fw[VERSION_OFFSET] = 0x08

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
print(f"Saved: {dst} ({len(fw)} bytes)")
print(f"\nv3.6.8: check_pin_lock() = NOP + v3.6.7 PIN verify/clear patch")
print("Result: error_byte NEVER set → no error_no_pin_code → odom publishes")
