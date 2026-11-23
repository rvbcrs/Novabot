# Mower won't join a WPA3 network — fix over USB Ethernet

> Community note from a Novabot owner running OpenNova. Shared in case it helps
> others and the maintainer.

## Symptom

After (re)provisioning the Wi-Fi, the mower would not come online over Wi-Fi: no
MQTT connection to the server for 15+ minutes, repeated across several BLE
re-provisioning attempts, even with the Wi-Fi password re-entered and confirmed
correct. The access point in this case was configured for **WPA3**.

## Cause

The mower runs NetworkManager. The stored Wi-Fi connection profile had
`key-mgmt=sae` (WPA3-SAE), and the mower would not associate to the AP with that
setting. In other words, it was a **WPA3 association failure**, not a wrong
password.

## Fix

1. Get a shell on the mower without Wi-Fi. We reached it over a **wired USB
   Ethernet adapter** (USB3) to the mower, then `adb` / shell.
2. Edit the NetworkManager connection and change the key management from WPA3 to
   WPA2-PSK:

   - `key-mgmt`: `sae` → `wpa-psk`

   (Back up the original connection file first, e.g. keep a copy of the
   `.nmconnection` before editing.)
3. The mower associated and came back online immediately after the change.

## Takeaways

- If a Novabot refuses to come online over Wi-Fi after provisioning and your AP
  is WPA3, suspect a **WPA3/SAE association problem**, not the password. Either
  switch that SSID (or a dedicated IoT SSID) to WPA2-PSK, or force the mower's
  NetworkManager profile to `wpa-psk`.
- A **USB Ethernet adapter** is a reliable fallback to get into the mower when
  Wi-Fi is down and the OpenNova hotspot is not available — useful for recovery
  in general, not just this case.

> This note is recorded from a single real recovery; the exact driver/supplicant
> reason for the SAE failure was not pinned down further. If the maintainer wants
> more detail we can dig in.
