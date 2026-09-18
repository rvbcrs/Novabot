# Reconnect to Wi-Fi

New router, new network name, new password, or the mower simply lost its
Wi-Fi: the charger and the mower get the new settings over Bluetooth from the
OpenNova app. A few minutes, and nothing is lost.

!!! warning "Do not delete the mower or the station"
    Deleting a device wipes its saved map and forces a full remap. The map
    lives on the mower itself and does not depend on Wi-Fi, so re-sending the
    Wi-Fi settings brings everything back as it was.

## Before you start

- Use the **2.4 GHz** network; the mower and charger cannot see 5 GHz.
- Stand next to the devices, with Bluetooth on and the OpenNova app allowed
  to use it. Both devices powered on.

## Charger first

1. Open the **OpenNova app** → **Settings** → **Provision Devices**.
2. Confirm the **server address** (usually already filled in).
3. Choose the **charging station**.
4. Enter the network name and password, **Next**.
5. The app scans and finds the charger. Select it, **Start provisioning**,
   and wait until it reports done.

## Then the mower

Same steps, now for the **mower**. The app insists on this order: the mower's
LoRa link is paired to the charger, and a mower done before its charger ends
up with a LoRa mismatch.

## Done

Both show as online in the app and the admin panel within a minute. Map,
schedules and settings are still there.

**The app does not find a device?** Get closer (next to the dock), power-cycle
that device, scan again.

**New router?** Two more things, outside the devices: the OpenNova server may
have got a different IP from the new router (then `TARGET_IP` in the compose
has to follow, and `docker compose up -d`), and the router's DNS setting has
to be made again ([DNS Setup](../guide/dns-setup.md)).
