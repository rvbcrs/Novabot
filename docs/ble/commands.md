# BLE Commands

Full payload specifications for all BLE provisioning commands.

---

## get_signal_info

Read WiFi RSSI and GPS satellite count.

```json title="Command"
{"get_signal_info":0}
```

```json title="Response"
{
  "type": "get_signal_info_respond",
  "message": {
    "result": 0,
    "value": {
      "wifi": 0,
      "rtk": 17
    }
  }
}
```

| Field | Description |
|-------|-------------|
| `wifi` | WiFi RSSI (0 = strong signal) |
| `rtk` | GPS satellite count (17 = good) |

---

## set_wifi_info

Configure WiFi networks.

=== "Charger (STA + AP)"

    ```json
    {
      "set_wifi_info": {
        "sta": {
          "ssid": "HomeNetwork",
          "passwd": "wifi-password",
          "encrypt": 0
        },
        "ap": {
          "ssid": "LFIC1230700XXX",
          "passwd": "12345678",
          "encrypt": 0
        }
      }
    }
    ```

    The charger gets **both** `sta` (connect to home router) and `ap` (own access point).

=== "Mower (AP only)"

    ```json
    {
      "set_wifi_info": {
        "ap": {
          "ssid": "HomeNetwork",
          "passwd": "wifi-password",
          "encrypt": 0
        }
      }
    }
    ```

    The mower only gets `ap` — it connects via the charger's AP, not directly to the home router.

```json title="Response"
{
  "type": "set_wifi_info_respond",
  "message": {
    "result": 0,
    "value": null
  }
}
```

!!! warning "Charger vs Mower difference"
    - **Charger**: receives `sta` + `ap` (connects to home WiFi directly)
    - **Mower**: receives only `ap` (connects via charger AP OR home WiFi)

---

## set_mqtt_info

Configure MQTT broker connection. Only host and port — no credentials via BLE.

```json title="Command"
{"set_mqtt_info":{"addr":"mqtt.lfibot.com","port":1883}}
```

```json title="Response"
{
  "type": "set_mqtt_info_respond",
  "message": {
    "result": 0,
    "value": null
  }
}
```

---

## set_lora_info

Configure LoRa communication parameters.

```json title="Command"
{"set_lora_info":{"addr":718,"channel":16,"hc":20,"lc":14}}
```

| Field | Description |
|-------|-------------|
| `addr` | LoRa address (shared between charger and mower) |
| `channel` | Requested LoRa channel |
| `hc` | High channel limit (for scanning) |
| `lc` | Low channel limit (for scanning) |

=== "Charger Response"

    ```json
    {
      "type": "set_lora_info_respond",
      "message": {
        "value": 15
      }
    }
    ```

    Returns the **actually assigned** channel (may differ from requested).

=== "Mower Response"

    ```json
    {
      "type": "set_lora_info_respond",
      "message": {
        "value": null
      }
    }
    ```

    Mower returns `null` (channel assigned by charger).

!!! important "chargerChannel in bindingEquipment"
    The app uses the `value` from `set_lora_info_respond` (the assigned channel) as `chargerChannel` when calling `bindingEquipment`, NOT the originally requested channel.

---

## set_rtk_info

Configure RTK GPS.

```json title="Command"
{"set_rtk_info":0}
```

```json title="Response"
{
  "type": "set_rtk_info_respond",
  "message": {
    "result": 0,
    "value": null
  }
}
```

!!! note
    Only sent during **charger** provisioning, not mower.

---

## set_cfg_info

Commit and activate all configuration changes.

=== "Charger"

    ```json
    {"set_cfg_info":1}
    ```

=== "Mower (with timezone)"

    ```json
    {"set_cfg_info":{"cfg_value":1,"tz":"Europe/Amsterdam"}}
    ```

```json title="Response"
{
  "type": "set_cfg_info_respond",
  "message": {
    "result": 0,
    "value": null
  }
}
```

After `set_cfg_info`, the device disconnects from BLE and reconnects to WiFi + MQTT.

---

## Error Handling

If `set_wifi_info_respond` or `set_mqtt_info_respond` returns a non-zero `result`:

> **"Network configuration error. Please retry."**

If `set_lora_info_respond` or `set_rtk_info_respond` returns a non-zero `result`:

> **"Network configuration error. Please ensure the antenna is connected properly and try again."**
