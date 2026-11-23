# Community notes

Field notes and contributions from Novabot owners running OpenNova, shared so the
project and other owners can benefit. These are owner reports and offers, not
official project documentation — the maintainer is welcome to fold in, move, or
rework anything here.

- **[remote-pin-unlock.md](remote-pin-unlock.md)** — ✅ **remote PIN unlock works**
  (chassis MCU **v3.6.101**, live-tested 2026-11-22 and after a cold boot on
  2026-11-23). The PIN lock is **incident 13 (`0xd`)**; v3.6.101 adds an honest
  `type=2` verify that, on the correct PIN only, calls `clr_incident(0xd)`. Wrong PIN
  is rejected and the lock returns on every boot (anti-theft kept). Also documents
  how the STM32 MCU flasher works (it's in `chassis_control_node`, not the OTA
  service) and how to use/automate the unlock. Spanish summary included.
- **[wpa3-usb-ethernet.md](wpa3-usb-ethernet.md)** — mower won't join a **WPA3**
  network: it's a WPA3/SAE association failure, not a wrong password. Fix via USB
  Ethernet by setting the NetworkManager profile to `wpa-psk` (WPA2).
- **[spanish-translation.md](spanish-translation.md)** — complete Spanish (es-AR)
  translation of the dashboard (PR #181, 1739/1739 keys) and the admin + server
  texts (PR #184), both brought up to date with `master` on 2026-11-23 (type-check and
  `serverText.coverage` test pass).

> Firmware flashing can brick the motor controller. Read the PIN note in full,
> keep a verified backup of the stock binary, and CRC-check any `.bin` before
> flashing. Use at your own risk.
