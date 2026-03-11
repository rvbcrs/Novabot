#!/usr/bin/env python3
"""
STM32 Firmware Patcher: Add type=2 remote PIN verify & unlock

Patches the CMD 0x23 PIN handler to support a new type=2 command that:
1. Receives 4 PIN digits via serial from ARM
2. Compares them against the stored PIN
3. If correct: switches to home screen (unlocks) + sends success response
4. If wrong: sends failure response

Trampoline: 4 bytes at 0x46138 (replaces CMP R0,#1 + BNE exit)
Patch code: 96 bytes at 0x6BA44 (post-CRC padding area)
CRC: Recomputed at 0x6BA40

Usage: python3 patch_pin_unlock.py
"""

import struct
import sys
import os

# === CONSTANTS ===
FLASH_BASE = 0x08010000
CRC_RANGE = 0x6BA40       # bytes covered by CRC check
CRC_OFFSET = 0x6BA40      # where CRC value is stored (4 bytes)
PATCH_OFFSET = 0x4E448    # where patch code goes (2460-byte zero area within CRC range)
TRAMPOLINE_OFFSET = 0x46138  # where we redirect the branch
EXPECTED_SIZE = 444144     # original firmware size

# Function flash addresses (file_offset + FLASH_BASE)
ADDR_GET_STORED_PIN = 0x08050C54   # file 0x40C54
ADDR_SCREEN_SWITCH  = 0x080509BC   # file 0x409BC
ADDR_SEND_RESPONSE  = 0x080215CA   # file 0x115CA
ADDR_TYPE1_HANDLER  = 0x0805613C   # file 0x4613C (original type=1 code)
ADDR_EXIT_DISPATCH  = 0x0805614E   # file 0x4614E (original exit)

# Expected original bytes at trampoline: CMP R0,#1 (2801) + BNE +0x10 (D108)
EXPECTED_ORIGINAL = bytes([0x01, 0x28, 0x08, 0xD1])


def file_to_flash(offset):
    return FLASH_BASE + offset


def encode_branch(source_file_offset, target_flash_addr, link=False):
    """Encode Thumb-2 B.W or BL instruction (4 bytes)."""
    source_flash = file_to_flash(source_file_offset)
    offset = target_flash_addr - (source_flash + 4)
    if not (-(1 << 24) <= offset < (1 << 24)):
        raise ValueError(f"Branch out of range: {offset:#x}")
    if offset % 2 != 0:
        raise ValueError(f"Branch target not halfword aligned: {offset:#x}")

    # 25-bit signed offset encoding
    if offset < 0:
        ob = offset & 0x01FFFFFF
    else:
        ob = offset

    S     = (ob >> 24) & 1
    I1    = (ob >> 23) & 1
    I2    = (ob >> 22) & 1
    imm10 = (ob >> 12) & 0x3FF
    imm11 = (ob >>  1) & 0x7FF
    J1    = (~(I1 ^ S)) & 1
    J2    = (~(I2 ^ S)) & 1

    hw1 = 0xF000 | (S << 10) | imm10
    # B.W (T4): 10 J1 1 J2 imm11 → bit14=0, bit12=1 → base 0x9000
    # BL  (T1): 11 J1 1 J2 imm11 → bit14=1, bit12=1 → base 0xD000
    hw2 = (0xD000 if link else 0x9000) | (J1 << 13) | (J2 << 11) | imm11
    return struct.pack('<HH', hw1, hw2)


def t16(value):
    """Pack a 16-bit Thumb instruction."""
    return struct.pack('<H', value)


def build_patch():
    """Build the 96-byte type=2 verify & unlock patch code."""
    code = bytearray()

    # Helper encoders for 16-bit Thumb instructions
    def CMP_imm(rn, imm8):   return t16(0x2800 | (rn << 8) | imm8)
    def BEQ(imm8):           return t16(0xD000 | imm8)
    def BNE(imm8):           return t16(0xD100 | imm8)
    def MOVS(rd, imm8):      return t16(0x2000 | (rd << 8) | imm8)
    def STR_SP(rt, imm4):    return t16(0x9000 | (rt << 8) | imm4)  # imm = offset/4
    def ADD_SP(rd, imm4):    return t16(0xA800 | (rd << 8) | imm4)  # imm = offset/4
    def LDRB(rt, rn, imm5):  return t16(0x7800 | (imm5 << 6) | (rn << 3) | rt)
    def CMP_reg(rn, rm):     return t16(0x4280 | (rm << 3) | rn)
    def ADDS_i3(rd, rn, i3): return t16(0x1C00 | (i3 << 6) | (rn << 3) | rd)
    def BL(src_off, tgt):    return encode_branch(src_off, tgt, link=True)
    def BW(src_off, tgt):    return encode_branch(src_off, tgt, link=False)

    P = PATCH_OFFSET  # base file offset for BL/BW calculations

    # --- offset 0: Check type ---
    code += CMP_imm(0, 1)          # [0]  CMP R0, #1
    code += BEQ(0x29)              # [2]  BEQ type1_return (offset 88)
    code += CMP_imm(0, 2)          # [4]  CMP R0, #2
    code += BNE(0x29)              # [6]  BNE exit_return (offset 92)

    # --- offset 8: Get stored PIN into SP+0x10 ---
    code += MOVS(0, 0)             # [8]  MOVS R0, #0
    code += STR_SP(0, 4)           # [10] STR R0, [SP, #0x10]
    code += ADD_SP(0, 4)           # [12] ADD R0, SP, #0x10
    code += BL(P+14, ADDR_GET_STORED_PIN)  # [14] BL get_stored_pin

    # --- offset 18: Compare digit 0 ---
    code += LDRB(0, 4, 2)         # [18] LDRB R0, [R4, #2]
    code += ADD_SP(1, 4)          # [20] ADD R1, SP, #0x10
    code += LDRB(1, 1, 0)         # [22] LDRB R1, [R1, #0]
    code += CMP_reg(0, 1)         # [24] CMP R0, R1
    code += BNE(0x17)              # [26] BNE wrong (offset 76)

    # --- offset 28: Compare digit 1 ---
    code += LDRB(0, 4, 3)         # [28] LDRB R0, [R4, #3]
    code += ADD_SP(1, 4)          # [30] ADD R1, SP, #0x10
    code += LDRB(1, 1, 1)         # [32] LDRB R1, [R1, #1]
    code += CMP_reg(0, 1)         # [34] CMP R0, R1
    code += BNE(0x12)              # [36] BNE wrong (offset 76)

    # --- offset 38: Compare digit 2 ---
    code += LDRB(0, 4, 4)         # [38] LDRB R0, [R4, #4]
    code += ADD_SP(1, 4)          # [40] ADD R1, SP, #0x10
    code += LDRB(1, 1, 2)         # [42] LDRB R1, [R1, #2]
    code += CMP_reg(0, 1)         # [44] CMP R0, R1
    code += BNE(0x0D)              # [46] BNE wrong (offset 76)

    # --- offset 48: Compare digit 3 ---
    code += LDRB(0, 4, 5)         # [48] LDRB R0, [R4, #5]
    code += ADD_SP(1, 4)          # [50] ADD R1, SP, #0x10
    code += LDRB(1, 1, 3)         # [52] LDRB R1, [R1, #3]
    code += CMP_reg(0, 1)         # [54] CMP R0, R1
    code += BNE(0x08)              # [56] BNE wrong (offset 76)

    # --- offset 58: PIN correct — unlock screen ---
    code += MOVS(0, 0x0C)         # [58] MOVS R0, #0x0C (home screen)
    code += BL(P+60, ADDR_SCREEN_SWITCH)   # [60] BL screen_switch

    # --- offset 64: Send success response (result=2) ---
    code += ADDS_i3(1, 4, 2)      # [64] ADDS R1, R4, #2 (digit pointer)
    code += MOVS(0, 2)            # [66] MOVS R0, #2 (verify success)
    code += BL(P+68, ADDR_SEND_RESPONSE)   # [68] BL send_response
    code += BW(P+72, ADDR_EXIT_DISPATCH)   # [72] B.W exit

    # --- wrong: offset 76 — PIN mismatch ---
    code += ADDS_i3(1, 4, 2)      # [76] ADDS R1, R4, #2
    code += MOVS(0, 3)            # [78] MOVS R0, #3 (verify failure)
    code += BL(P+80, ADDR_SEND_RESPONSE)   # [80] BL send_response
    code += BW(P+84, ADDR_EXIT_DISPATCH)   # [84] B.W exit

    # --- type1_return: offset 88 ---
    code += BW(P+88, ADDR_TYPE1_HANDLER)   # [88] B.W original type=1

    # --- exit_return: offset 92 ---
    code += BW(P+92, ADDR_EXIT_DISPATCH)   # [92] B.W original exit

    assert len(code) == 96, f"Patch is {len(code)} bytes, expected 96"
    return bytes(code)


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


def verify_capstone(code, flash_addr):
    """Optional: disassemble with capstone for verification."""
    try:
        import capstone
        md = capstone.Cs(capstone.CS_ARCH_ARM, capstone.CS_MODE_THUMB)
        print("\n  Capstone disassembly:")
        for insn in md.disasm(code, flash_addr):
            print(f"    0x{insn.address:08x}: {insn.mnemonic:8s} {insn.op_str}")
        return True
    except ImportError:
        print("  (capstone not available, skipping disassembly verification)")
        return False


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(script_dir, "novabot_stm32f407_v3_6_0_NewMotor25082301.bin")
    dst = os.path.join(script_dir, "novabot_stm32f407_v3_6_0_NewMotor25082301_pin_unlock.bin")

    # 1. Read firmware
    with open(src, 'rb') as f:
        fw = bytearray(f.read())
    print(f"Read {len(fw)} bytes from {os.path.basename(src)}")
    if len(fw) != EXPECTED_SIZE:
        print(f"WARNING: Expected {EXPECTED_SIZE} bytes, got {len(fw)}")

    # 2. Verify original CRC
    orig_crc = struct.unpack('<I', fw[CRC_OFFSET:CRC_OFFSET+4])[0]
    calc_crc = stm32_hw_crc32(bytes(fw), CRC_RANGE)
    print(f"Original CRC: stored=0x{orig_crc:08X} calculated=0x{calc_crc:08X}", end=" ")
    if orig_crc != calc_crc:
        print("MISMATCH - aborting")
        sys.exit(1)
    print("OK")

    # 3. Verify trampoline location
    orig_bytes = bytes(fw[TRAMPOLINE_OFFSET:TRAMPOLINE_OFFSET+4])
    if orig_bytes != EXPECTED_ORIGINAL:
        print(f"ERROR: Trampoline bytes mismatch: {orig_bytes.hex()} != {EXPECTED_ORIGINAL.hex()}")
        sys.exit(1)
    print(f"Trampoline at 0x{TRAMPOLINE_OFFSET:X}: {orig_bytes.hex()} (CMP R0,#1 + BNE) OK")

    # 4. Verify patch area is clean
    patch_area = fw[PATCH_OFFSET:PATCH_OFFSET+96]
    nonzero = sum(1 for b in patch_area if b != 0x00 and b != 0xFF)
    if nonzero > 0:
        print(f"WARNING: Patch area has {nonzero} non-zero/FF bytes")
    else:
        print(f"Patch area at 0x{PATCH_OFFSET:X}: clean")

    # 5. Build patch code
    patch_code = build_patch()
    print(f"\nPatch code ({len(patch_code)} bytes): {patch_code.hex()}")
    verify_capstone(patch_code, file_to_flash(PATCH_OFFSET))

    # 6. Build trampoline
    trampoline = encode_branch(TRAMPOLINE_OFFSET, file_to_flash(PATCH_OFFSET), link=False)
    print(f"\nTrampoline B.W ({trampoline.hex()}): "
          f"0x{file_to_flash(TRAMPOLINE_OFFSET):08X} -> 0x{file_to_flash(PATCH_OFFSET):08X}")
    verify_capstone(trampoline, file_to_flash(TRAMPOLINE_OFFSET))

    # 7. Apply patches
    fw[TRAMPOLINE_OFFSET:TRAMPOLINE_OFFSET+4] = trampoline
    fw[PATCH_OFFSET:PATCH_OFFSET+96] = patch_code

    # 8. Recompute CRC
    new_crc = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
    struct.pack_into('<I', fw, CRC_OFFSET, new_crc)
    print(f"\nCRC updated: 0x{orig_crc:08X} -> 0x{new_crc:08X}")

    # 9. Verify new CRC
    v = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
    s = struct.unpack('<I', fw[CRC_OFFSET:CRC_OFFSET+4])[0]
    assert v == s, f"CRC verify failed: {v:#x} != {s:#x}"

    # 10. Save
    with open(dst, 'wb') as f:
        f.write(fw)
    print(f"\nSaved: {os.path.basename(dst)} ({len(fw)} bytes)")

    # Summary
    print(f"""
{'='*60}
PATCH SUMMARY
{'='*60}
Trampoline : 4 bytes at file 0x{TRAMPOLINE_OFFSET:05X} (flash 0x{file_to_flash(TRAMPOLINE_OFFSET):08X})
Patch code : {len(patch_code)} bytes at file 0x{PATCH_OFFSET:05X} (flash 0x{file_to_flash(PATCH_OFFSET):08X})
CRC        : Updated at file 0x{CRC_OFFSET:05X}

TYPE 2 PROTOCOL (verify & unlock):
  Send:     [02 02] [07 FF] [08] [23 02 d0 d1 d2 d3 CC] [03 03]
  Success:  [02 02] [07 FF] [08] [23 02 d0 d1 d2 d3 CC] [03 03]
  Failure:  [02 02] [07 FF] [08] [23 03 d0 d1 d2 d3 CC] [03 03]
  (d0-d3 = ASCII PIN digits, CC = CRC-8)
{'='*60}""")


if __name__ == '__main__':
    main()
