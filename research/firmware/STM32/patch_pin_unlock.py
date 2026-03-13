#!/usr/bin/env python3
"""
STM32 Firmware Patcher: Add type=2 remote PIN verify & type=3 clear error

Patches the CMD 0x23 PIN handler to support two new commands:

type=2 (verify & unlock):
1. Receives 4 ASCII PIN digits via serial from ARM
2. Compares them against the stored PIN (also ASCII, e.g. 0x33 0x30 0x35 0x33 = "3053")
3. If correct: clears ALL error state + permanently disables re-lock + sends status=0 (success)
4. If wrong: sends status=3 (failure)

type=3 (clear error — v3.6.7):
1. Clears ALL error state (same as type=2 success) WITHOUT PIN verification
2. Switches display to home screen
3. Sends status=0 (success)
Used by extended_commands.py to repeatedly force-clear the error display
after PIN verify, overcoming tilt/lift detection re-triggering.

SERIAL PROTOCOL (bewezen werkend 12 maart 2026):
  Frame format: [02 02] [07 FF] [LEN] [CMD PAYLOAD... CRC8] [03 03]
  LEN = len(CMD + payload + CRC8)
  CRC-8: poly=0x07, init=0x00 over CMD+payload bytes (NIET addr/len)
  CMD 0x23 type=0: query stored PIN → response bevat ASCII digits
  CMD 0x23 type=1: set PIN (ASCII digits)
  CMD 0x23 type=2: verify PIN (onze patch) → status=2 success, status=3 failure
  PIN digits MOETEN ASCII zijn (0x30-0x39), NIET raw (0x00-0x09)

ROOT CAUSE ANALYSE (12 maart 2026):
  CMD 0x20 data byte komt van RAM 0x20000774 ("error_byte").
  De functie check_pin_lock() op 0x08027880 zet deze byte op 0x02 (PIN locked)
  zodra de batterijspanning ≥ 19V is en een counter > 200 ticks bereikt.

  check_pin_lock() state machine (volledig gedisassembleerd):
    Literal pool: state @ 0x20000775, counter @ 0x2000077C, timer @ 0x20000778

    Entry: LDRB state → CBNZ state_machine (if state != 0 → skip lock logic)
    State 0: counter++ → if > 200 → set_error_byte(2) + display lock screen
    State 1: display func → state=2 → set timer (now + 1000)
    State 2: wait timer → set_error_byte(0) → state=3 → set timer (now + 5000)
    State 3: wait timer → STATE=0 (BACK TO LOCKING!)

  v3.6.4 BUG: state=1 triggered the unlock state machine, but it cycled
  back to state=0 after ~6 seconds, then counter > 200 → re-locked.
  0x2000150C (lock_enable) is NOT read by check_pin_lock() at all —
  it's not in the literal pool.

  v3.6.5 FIX: state=0xFF instead of 1. The state machine only handles
  1, 2, 3 — with 0xFF it enters the state machine (cbnz succeeds) but
  NO handler matches, so it exits doing nothing. Permanently, until:
  - Voltage drops < 15V (battery removed → state cleared to 0, correct)
  - Reboot (firmware init resets RAM → PIN required again, correct)

  v3.6.6 FIX: verify success sends status=0 instead of status=2.
  The ROS2 ChassisPinCodeSet action definition says status=0 = success.
  chassis_control_node checks this: if status != 0 → "Goal fail PinCode
  config fail" → set_pincode_flag(false) is NOT called → error_no_pin_code
  stays set → error_status=151 persists. With status=0, chassis_control_node
  accepts the verify → calls set_pincode_flag(false) → error_status clears.

Trampoline: 4 bytes at 0x46138 (replaces CMP R0,#1 + BNE exit)
Patch code: 162 bytes at 0x4E448 (zero area within CRC range)
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
VERSION_OFFSET = 0x4763A   # patch version byte (v3.6.X)
EXPECTED_SIZE = 444144     # original firmware size

# Function flash addresses (file_offset + FLASH_BASE)
ADDR_GET_STORED_PIN = 0x08050C54   # file 0x40C54
ADDR_SCREEN_SWITCH  = 0x080509BC   # file 0x409BC
ADDR_SEND_RESPONSE  = 0x080215CA   # file 0x115CA
ADDR_TYPE1_HANDLER  = 0x0805613C   # file 0x4613C (original type=1 code)
ADDR_EXIT_DISPATCH  = 0x0805614E   # file 0x4614E (original exit)

# RAM addresses — our patch must clear ALL of these after successful verify.
#
# v3.6.3 addresses (display/incident flags — necessary but NOT sufficient):
ERROR_FLAG_ADDR     = 0x20000368  # Controls display error state (screen 3 = PIN prompt)
INCIDENT_FLAG_ADDR  = 0x200004CE  # Controls serial incident report
#
# v3.6.4 addresses (ROOT CAUSE — the ACTUAL CMD 0x20 data source):
ERROR_BYTE_ADDR     = 0x20000774  # CMD 0x20 data byte (0=OK, 2=PIN locked)
#                                   get_error_byte() at 0x08027A20 reads this
#                                   set_error_byte() at 0x08027A2C writes this
LOCK_STATE_ADDR     = 0x20000775  # check_pin_lock state machine (0=monitoring, 1=unlock-start)
LOCK_COUNTER_ADDR   = 0x2000077C  # Tick counter for PIN lock (>200 → set error_byte=2)
LOCK_ENABLE_ADDR    = 0x2000150C  # Enable flag for periodic check_pin_lock (1=enabled, 0=disabled)

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


def t32_movw(rd, imm16):
    """Encode MOVW Rd, #imm16 (Thumb-2 T3, 4 bytes)."""
    imm4 = (imm16 >> 12) & 0xF
    i    = (imm16 >> 11) & 1
    imm3 = (imm16 >> 8) & 0x7
    imm8 = imm16 & 0xFF
    hw1 = 0xF240 | (i << 10) | imm4
    hw2 = (imm3 << 12) | (rd << 8) | imm8
    return struct.pack('<HH', hw1, hw2)


def t32_movt(rd, imm16):
    """Encode MOVT Rd, #imm16 (Thumb-2, 4 bytes)."""
    imm4 = (imm16 >> 12) & 0xF
    i    = (imm16 >> 11) & 1
    imm3 = (imm16 >> 8) & 0x7
    imm8 = imm16 & 0xFF
    hw1 = 0xF2C0 | (i << 10) | imm4
    hw2 = (imm3 << 12) | (rd << 8) | imm8
    return struct.pack('<HH', hw1, hw2)


def build_patch():
    """Build the 166-byte type=2/3 verify & unlock patch code (v3.6.7).

    v3.6.2: clears error_flag_byte at 0x20000368
    v3.6.3: ALSO clears incident_flag_byte at 0x200004CE
    v3.6.4: clears CMD 0x20 error byte (0x20000774), sets state=1
            BUG: state machine cycled back to 0 → re-locked after ~6s
    v3.6.5: ROOT CAUSE FIX — sets state=0xFF (not 0,1,2,3) so
            check_pin_lock() enters state machine but NO handler matches,
            making it permanently skip all lock logic until reboot.
    v3.6.6: verify success returns status=0 (was 2).
            ChassisPinCodeSet ROS action: 0=success, other=fail.
            chassis_control_node rejected status=2 → never cleared
            error_no_pin_code → error_status=151 persisted.
    v3.6.7: type=3 "clear error" command — clears ALL error state and
            switches to home screen WITHOUT requiring PIN verification.
            Used by extended_commands.py after PIN verify to force-clear
            the error display that persists due to tilt/lift detection
            re-triggering the error screen faster than the verify can clear it.
    """
    code = bytearray()

    # Helper encoders for 16-bit Thumb instructions
    def CMP_imm(rn, imm8):   return t16(0x2800 | (rn << 8) | imm8)
    def BEQ(imm8):           return t16(0xD000 | imm8)
    def BNE(imm8):           return t16(0xD100 | imm8)
    def MOVS(rd, imm8):      return t16(0x2000 | (rd << 8) | imm8)
    def STR_SP(rt, imm4):    return t16(0x9000 | (rt << 8) | imm4)  # imm = offset/4
    def ADD_SP(rd, imm4):    return t16(0xA800 | (rd << 8) | imm4)  # imm = offset/4
    def LDRB(rt, rn, imm5):  return t16(0x7800 | (imm5 << 6) | (rn << 3) | rt)
    def STRB(rt, rn, imm5):  return t16(0x7000 | (imm5 << 6) | (rn << 3) | rt)
    def CMP_reg(rn, rm):     return t16(0x4280 | (rm << 3) | rn)
    def ADDS_i3(rd, rn, i3): return t16(0x1C00 | (i3 << 6) | (rn << 3) | rd)
    def BL(src_off, tgt):    return encode_branch(src_off, tgt, link=True)
    def BW(src_off, tgt):    return encode_branch(src_off, tgt, link=False)

    P = PATCH_OFFSET  # base file offset for BL/BW calculations

    # === OFFSET MAP (v3.6.7) ===
    # [0-11]    type dispatch (type=1 → set, type=2 → verify, type=3 → clear error)
    # [12-21]   get stored PIN
    # [22-61]   compare 4 digits
    # [62-67]   screen_switch(0x0C)   ← type=3 jumps directly here
    # [68-89]   clear error_flag + incident_flag (v3.6.3)
    # [90-99]   clear error_byte at 0x20000774 (v3.6.4 ROOT CAUSE)
    # [100-111] set state=0xFF at 0x20000775
    # [112-123] clear counter at 0x2000077C
    # [124-133] disable periodic lock at 0x2000150C
    # [134-145] send success + exit
    # [146-157] wrong: send failure + exit
    # [158-161] type1_return
    # [162-165] exit_return

    OFF_CLEAR  = 62     # screen_switch + clear error (type=3 target)
    OFF_WRONG  = 146
    OFF_TYPE1  = 158
    OFF_EXIT   = 162

    # --- offset 0: Check type ---
    code += CMP_imm(0, 1)          # [0]  CMP R0, #1
    code += BEQ((OFF_TYPE1 - 2 - 4) // 2)  # [2]  BEQ type1_return
    code += CMP_imm(0, 3)          # [4]  CMP R0, #3
    code += BEQ((OFF_CLEAR - 6 - 4) // 2)  # [6]  BEQ clear_and_home (skip PIN check!)
    code += CMP_imm(0, 2)          # [8]  CMP R0, #2
    code += BNE((OFF_EXIT - 10 - 4) // 2)  # [10] BNE exit_return

    # --- offset 12: Get stored PIN into SP+0x10 ---
    code += MOVS(0, 0)             # [12] MOVS R0, #0
    code += STR_SP(0, 4)           # [14] STR R0, [SP, #0x10]
    code += ADD_SP(0, 4)           # [16] ADD R0, SP, #0x10
    code += BL(P+18, ADDR_GET_STORED_PIN)  # [18] BL get_stored_pin

    # --- offset 22: Compare digit 0 ---
    code += LDRB(0, 4, 2)         # [22] LDRB R0, [R4, #2]
    code += ADD_SP(1, 4)          # [24] ADD R1, SP, #0x10
    code += LDRB(1, 1, 0)         # [26] LDRB R1, [R1, #0]
    code += CMP_reg(0, 1)         # [28] CMP R0, R1
    code += BNE((OFF_WRONG - 30 - 4) // 2)  # [30] BNE wrong

    # --- offset 32: Compare digit 1 ---
    code += LDRB(0, 4, 3)         # [32] LDRB R0, [R4, #3]
    code += ADD_SP(1, 4)          # [34] ADD R1, SP, #0x10
    code += LDRB(1, 1, 1)         # [36] LDRB R1, [R1, #1]
    code += CMP_reg(0, 1)         # [38] CMP R0, R1
    code += BNE((OFF_WRONG - 40 - 4) // 2)  # [40] BNE wrong

    # --- offset 42: Compare digit 2 ---
    code += LDRB(0, 4, 4)         # [42] LDRB R0, [R4, #4]
    code += ADD_SP(1, 4)          # [44] ADD R1, SP, #0x10
    code += LDRB(1, 1, 2)         # [46] LDRB R1, [R1, #2]
    code += CMP_reg(0, 1)         # [48] CMP R0, R1
    code += BNE((OFF_WRONG - 50 - 4) // 2)  # [50] BNE wrong

    # --- offset 52: Compare digit 3 ---
    code += LDRB(0, 4, 5)         # [52] LDRB R0, [R4, #5]
    code += ADD_SP(1, 4)          # [54] ADD R1, SP, #0x10
    code += LDRB(1, 1, 3)         # [56] LDRB R1, [R1, #3]
    code += CMP_reg(0, 1)         # [58] CMP R0, R1
    code += BNE((OFF_WRONG - 60 - 4) // 2)  # [60] BNE wrong

    # --- offset 62: Clear & unlock — switch to home screen ---
    # type=3 jumps here directly (no PIN check)
    # type=2 falls through here after successful PIN comparison
    code += MOVS(0, 0x0C)         # [62] MOVS R0, #0x0C (home screen)
    code += BL(P+64, ADDR_SCREEN_SWITCH)   # [64] BL screen_switch

    # --- offset 68: Clear error_flag_byte at 0x20000368 ---
    code += MOVS(0, 0)            # [68] MOVS R0, #0  (R0=0 for all clears below)
    code += t32_movw(1, ERROR_FLAG_ADDR & 0xFFFF)  # [70] MOVW R1, #0x0368
    code += t32_movt(1, ERROR_FLAG_ADDR >> 16)      # [74] MOVT R1, #0x2000
    code += STRB(0, 1, 0)         # [78] STRB R0, [R1, #0]

    # --- offset 80: Clear incident_flag_byte at 0x200004CE ---
    code += t32_movw(1, INCIDENT_FLAG_ADDR & 0xFFFF)  # [80] MOVW R1, #0x04CE
    code += t32_movt(1, INCIDENT_FLAG_ADDR >> 16)      # [84] MOVT R1, #0x2000
    code += STRB(0, 1, 0)         # [88] STRB R0, [R1, #0]

    # --- offset 90: Clear error_byte at 0x20000774 (ROOT CAUSE! v3.6.4) ---
    # This is the ACTUAL variable that get_error_byte() reads for CMD 0x20.
    # check_pin_lock() sets this to 2 when PIN locked.
    code += t32_movw(1, ERROR_BYTE_ADDR & 0xFFFF)   # [90] MOVW R1, #0x0774
    code += t32_movt(1, ERROR_BYTE_ADDR >> 16)       # [94] MOVT R1, #0x2000
    code += STRB(0, 1, 0)         # [98] STRB R0, [R1, #0]  (R0=0)

    # --- offset 100: Set state=0xFF at 0x20000775 (permanent skip) ---
    # check_pin_lock() state machine handles 1/2/3 only.
    # 0xFF → enters state machine (cbnz) but NO handler matches → exits doing nothing.
    # Persists until reboot (RAM) or voltage < 15V (battery removed).
    code += MOVS(0, 0xFF)         # [100] MOVS R0, #0xFF
    code += t32_movw(1, LOCK_STATE_ADDR & 0xFFFF)   # [102] MOVW R1, #0x0775
    code += t32_movt(1, LOCK_STATE_ADDR >> 16)       # [106] MOVT R1, #0x2000
    code += STRB(0, 1, 0)         # [110] STRB R0, [R1, #0]

    # --- offset 112: Clear counter at 0x2000077C ---
    code += MOVS(0, 0)            # [112] MOVS R0, #0
    code += t32_movw(1, LOCK_COUNTER_ADDR & 0xFFFF)  # [114] MOVW R1, #0x077C
    code += t32_movt(1, LOCK_COUNTER_ADDR >> 16)      # [118] MOVT R1, #0x2000
    code += STRB(0, 1, 0)         # [122] STRB R0, [R1, #0]

    # --- offset 124: Disable periodic check_pin_lock at 0x2000150C ---
    # The periodic task at 0x08046578 checks this flag; if 0, skips lock check.
    # This is RAM, so it resets to 1 on reboot (PIN required again per power cycle).
    code += t32_movw(1, LOCK_ENABLE_ADDR & 0xFFFF)   # [124] MOVW R1, #0x150C
    code += t32_movt(1, LOCK_ENABLE_ADDR >> 16)       # [128] MOVT R1, #0x2000
    code += STRB(0, 1, 0)         # [132] STRB R0, [R1, #0]  (R0=0)

    # --- offset 134: Send success response (status=0 for ROS action compat) ---
    # ChassisPinCodeSet action: status=0 means success. chassis_control_node
    # calls set_pincode_flag(false) only when status=0. With status=2 (v3.6.5)
    # it logged "Goal fail PinCode config fail" and error_status=151 persisted.
    code += ADDS_i3(1, 4, 2)      # [134] ADDS R1, R4, #2 (digit pointer)
    code += MOVS(0, 0)            # [136] MOVS R0, #0 (success — was 2 in v3.6.5)
    code += BL(P+138, ADDR_SEND_RESPONSE)   # [138] BL send_response
    code += BW(P+142, ADDR_EXIT_DISPATCH)   # [142] B.W exit

    # --- wrong: offset 146 — PIN mismatch ---
    code += ADDS_i3(1, 4, 2)      # [146] ADDS R1, R4, #2
    code += MOVS(0, 3)            # [148] MOVS R0, #3 (verify failure)
    code += BL(P+150, ADDR_SEND_RESPONSE)  # [150] BL send_response
    code += BW(P+154, ADDR_EXIT_DISPATCH)  # [154] B.W exit

    # --- type1_return: offset 158 ---
    code += BW(P+158, ADDR_TYPE1_HANDLER)  # [158] B.W original type=1

    # --- exit_return: offset 162 ---
    code += BW(P+162, ADDR_EXIT_DISPATCH)  # [162] B.W original exit

    assert len(code) == 166, f"Patch is {len(code)} bytes, expected 166"
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
    dst = os.path.join(script_dir, "novabot_stm32f407_v3_6_7_NewMotor25082301_pin_unlock.bin")

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
    patch_area = fw[PATCH_OFFSET:PATCH_OFFSET+166]
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
    fw[PATCH_OFFSET:PATCH_OFFSET+166] = patch_code

    # 8. Update version byte: v3.6.0 → v3.6.5
    old_ver = fw[VERSION_OFFSET]
    fw[VERSION_OFFSET] = 0x07
    print(f"\nVersion: v3.6.{old_ver} -> v3.6.7 (offset 0x{VERSION_OFFSET:X})")

    # 9. Recompute CRC
    new_crc = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
    struct.pack_into('<I', fw, CRC_OFFSET, new_crc)
    print(f"CRC updated: 0x{orig_crc:08X} -> 0x{new_crc:08X}")

    # 10. Verify new CRC
    v = stm32_hw_crc32(bytes(fw[:CRC_RANGE]), CRC_RANGE)
    s = struct.unpack('<I', fw[CRC_OFFSET:CRC_OFFSET+4])[0]
    assert v == s, f"CRC verify failed: {v:#x} != {s:#x}"

    # 11. Save
    with open(dst, 'wb') as f:
        f.write(fw)
    print(f"\nSaved: {os.path.basename(dst)} ({len(fw)} bytes)")

    # Summary
    print(f"""
{'='*60}
PATCH SUMMARY (v3.6.7 — PIN UNLOCK + CLEAR ERROR)
{'='*60}
Trampoline : 4 bytes at file 0x{TRAMPOLINE_OFFSET:05X} (flash 0x{file_to_flash(TRAMPOLINE_OFFSET):08X})
Patch code : {len(patch_code)} bytes at file 0x{PATCH_OFFSET:05X} (flash 0x{file_to_flash(PATCH_OFFSET):08X})
Error flag : RAM 0x{ERROR_FLAG_ADDR:08X} (display error state)
Incident   : RAM 0x{INCIDENT_FLAG_ADDR:08X} (serial incident report)
Error byte : RAM 0x{ERROR_BYTE_ADDR:08X} (CMD 0x20 data byte)
Lock state : RAM 0x{LOCK_STATE_ADDR:08X} (check_pin_lock state machine → 0xFF)
Lock count : RAM 0x{LOCK_COUNTER_ADDR:08X} (lock trigger counter)
Lock enable: RAM 0x{LOCK_ENABLE_ADDR:08X} (not used by check_pin_lock, kept for safety)
Version    : v3.6.7 at file 0x{VERSION_OFFSET:05X}
CRC        : Updated at file 0x{CRC_OFFSET:05X}

CMD types:
  type=1: Set PIN (original handler)
  type=2: Verify PIN + clear all errors + home screen
  type=3: Clear all errors + home screen (NO PIN check)  ← NEW v3.6.7

v3.6.7 FIX: type=3 "clear error" command.
  After PIN verify (type=2), tilt/lift detection can re-trigger the error
  screen before the verify response reaches the ARM. type=3 allows
  extended_commands.py to repeatedly force-clear the error display
  without needing PIN re-verification.

After type=2 verify or type=3 clear, ALL state is set:
  1. Screen switches to home (0x0C)
  2. error_flag (0x20000368) = 0
  3. incident_flag (0x200004CE) = 0
  4. error_byte (0x20000774) = 0 — stops CMD 0x20 reporting 0x02
  5. lock_state (0x20000775) = 0xFF — PERMANENT skip
  6. lock_counter (0x2000077C) = 0 — resets counter
  7. lock_enable (0x2000150C) = 0 — extra safety
{'='*60}""")


if __name__ == '__main__':
    main()
