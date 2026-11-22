# Community notes

Field notes and contributions from Novabot owners running OpenNova, shared so the
project and other owners can benefit. These are owner reports and offers, not
official project documentation — the maintainer is welcome to fold in, move, or
rework anything here.

- **[remote-pin-unlock.md](remote-pin-unlock.md)** — ⚠️ **work in progress.** How
  the STM32 chassis MCU flasher actually works (it's in `chassis_control_node`,
  not the OTA service) — **confirmed and reusable**. Plus the remote PIN unlock
  research: two patches were flashed and live-tested — v3.6.99 (honest verify)
  returns the right status but does **not** clear the lock, and v3.6.100 clears the
  gate bit but the **lock FSM re-asserts it**, so the mower stays locked. **No
  working unlock yet**; documented honestly with the open question for a next try.
- **[wpa3-usb-ethernet.md](wpa3-usb-ethernet.md)** — mower won't join a **WPA3**
  network: it's a WPA3/SAE association failure, not a wrong password. Fix via USB
  Ethernet by setting the NetworkManager profile to `wpa-psk` (WPA2).
- **[spanish-translation.md](spanish-translation.md)** — offer of a complete
  Spanish (es-AR) translation of the app, admin and server-facing strings.

> Firmware flashing can brick the motor controller. Read the PIN note in full,
> keep a verified backup of the stock binary, and CRC-check any `.bin` before
> flashing. Use at your own risk.
