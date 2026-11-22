# Community notes

Field notes and contributions from Novabot owners running OpenNova, shared so the
project and other owners can benefit. These are owner reports and offers, not
official project documentation — the maintainer is welcome to fold in, move, or
rework anything here.

- **[remote-pin-unlock.md](remote-pin-unlock.md)** — how the STM32 chassis MCU
  flasher actually works (it's in `chassis_control_node`, not the OTA service),
  and an "honest verify" firmware patch that adds remote PIN unlock (`CMD 0x23`
  `type=2`) **without** disabling the anti-theft lock. Includes the flashing
  procedure, CRC/offset details, a safe dry-run, and rollback.
- **[wpa3-usb-ethernet.md](wpa3-usb-ethernet.md)** — mower won't join a **WPA3**
  network: it's a WPA3/SAE association failure, not a wrong password. Fix via USB
  Ethernet by setting the NetworkManager profile to `wpa-psk` (WPA2).
- **[spanish-translation.md](spanish-translation.md)** — offer of a complete
  Spanish (es-AR) translation of the app, admin and server-facing strings.

> Firmware flashing can brick the motor controller. Read the PIN note in full,
> keep a verified backup of the stock binary, and CRC-check any `.bin` before
> flashing. Use at your own risk.
