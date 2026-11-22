# Community notes

Field notes and contributions from Novabot owners running OpenNova, shared so the
project and other owners can benefit. These are owner reports and offers, not
official project documentation — the maintainer is welcome to fold in, move, or
rework anything here.

- **[remote-pin-unlock.md](remote-pin-unlock.md)** — ⚠️ **work in progress.** How
  the STM32 chassis MCU flasher actually works (it's in `chassis_control_node`,
  not the OTA service) — **confirmed and reusable**. Plus the remote PIN unlock
  research: the flashed "honest verify" patch (v3.6.99) returns the right status
  but does **not** clear a real lock; the gate is now identified (bit 16,
  `0x10000`, of the RAM mask at `0x200002E0`, RAM-only — no RTC persistence), and
  a clear-the-gate patch (v3.6.100) is **built but not yet flashed/verified live**.
  Fix candidate, documented honestly.
- **[wpa3-usb-ethernet.md](wpa3-usb-ethernet.md)** — mower won't join a **WPA3**
  network: it's a WPA3/SAE association failure, not a wrong password. Fix via USB
  Ethernet by setting the NetworkManager profile to `wpa-psk` (WPA2).
- **[spanish-translation.md](spanish-translation.md)** — offer of a complete
  Spanish (es-AR) translation of the app, admin and server-facing strings.

> Firmware flashing can brick the motor controller. Read the PIN note in full,
> keep a verified backup of the stock binary, and CRC-check any `.bin` before
> flashing. Use at your own risk.
