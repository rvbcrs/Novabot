# mqtt_node — BLE GATT trace (RE-6)

**Status:** DEFERRED. Live `btmon` capture during a fresh provisioning
session was skipped at user request on 2026-04-27 — the project moves
forward with the existing reverse-engineered BLE protocol documentation
instead of a fresh hardware capture.

## Sources we rely on instead

- **`docs/reference/BLE.md`** — primary source. Documents GATT service +
  characteristic UUIDs, frame format (`le_start` / `le_end` markers),
  command sequence (get_signal_info → set_wifi_info → set_lora_info →
  set_mqtt_info → set_cfg_info), exact payloads, charger + mower flows.
- **Memory: `ble-provisioning-protocol.md`** — frame protocol facts
  proven on real hardware.
- **Memory: `ble-provisioning-facts.md`** — BLE re-provisioning works on
  already-provisioned device (proven 2026-04-09).
- **`bootstrap/src/ble.ts`** — Node.js noble implementation. Source of
  truth for the exact byte sequences mqtt_node must accept on the
  GATT char.
- **`bootstrap/wizard/src/ble/webBle.ts`** — browser Web-Bluetooth
  twin of the Node.js client. Useful for double-checking framing.

## Phase 4 implementation note

When `mower/mqtt_node/ble_handler.py`'s `start_gatt_server()` is wired
(currently a `NotImplementedError` stub per Plan Task 4.1), use the
sources above as the implementation reference. The BleFramer pure-Python
frame parser in `mower/mqtt_node/ble_handler.py` is already validated by
unit tests against the same `le_start` / `le_end` framing the bootstrap
client emits — a fresh `btmon` capture is not strictly required to
proceed.

## Refresh path

If hardware behaviour ever diverges from the bootstrap-derived
documentation, capture via:

```bash
sshpass -p 'novabot' ssh -o StrictHostKeyChecking=no root@192.168.0.100 \
  'btmon -w /tmp/mqtt_node-ble.btsnoop &
   sleep 60
   pkill -INT btmon
   sleep 2
   ls -la /tmp/mqtt_node-ble.btsnoop'
```

(Coordinate the 60-second window with a manual provisioning run on the
OpenNova app.)

Then `scp` the `.btsnoop` to `research/captures/` and decode with
Wireshark or `btsnoop_parse.py`.
