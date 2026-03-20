# Binary Patches

Binary patches for the OEM STM32 firmware live in `research/firmware/STM32/`.

See:
- `research/STM32_firmware_feasibility_analysis.md` — Hardware analysis
- `research/chassis_serial_protocol.md` — Complete serial protocol specification

## Existing patches

| Patch | Description | Status |
|-------|-------------|--------|
| PIN lock NOP | `check_pin_lock()` → NOP, prevents `error_no_pin_code` | Deployed (v3.6.7 as v3.6.9) |
| PIN verify | `check_pin_match()` → always return success | Deployed (v3.6.7 as v3.6.9) |

## Notes

- v3.6.8 was REMOVED — it broke charging!
- Current deployed version: v3.6.7 with patches, reported as v3.6.9
- See `stm32-firmware.md` in auto-memory for full patch history
