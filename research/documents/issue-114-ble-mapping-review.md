# Issue 114: BLE mapping response and positioning evidence

Scope: the reported missing `stop_scan_map_respond`, failed close, open-loop
display after a long offline walk, and the separate map5+ mowing failure.
Issue: <https://github.com/rvbcrs/Novabot/issues/114>.

## Firmware response deadlines and command serialization

`research/ghidra_output/mqtt_node_decompiled.c` is the checked-in firmware
decompilation. The following mapping APIs first wait up to 2 seconds for a ROS
service, then wait up to 30 seconds for its response:

| API | Service discovery line | 30-second duration line | Response wait lines |
| --- | ---: | ---: | ---: |
| `api_start_scan_map` | 341505 | 341587 | 341611–341612 |
| `api_add_scan_map` | 340401 | 340483 | 340507–340508 |
| `api_stop_scan_map` | 342039 | 342112 | 342138–342139 |
| `api_save_map` | 339831 | 339916 | 339956–339957 |
| `api_quit_mapping_mode` | 338564 | 338646 | 338675–338676 |
| `api_stop_erase_map` | 343559 | 343632 | 343658–343659 |
| `api_save_recharge_pos` | 346414 | 346499 | 346523–346524 |
| `api_start_assistant_build_map` | 342551 | 342625 | 342651–342652 |
| `api_auto_recharge` | 349122 | 349204 | 349230–349231 |

The duration is `0x1e` (30), passed to `wait_for<long, std::ratio<1,1>>`, so the
unit is seconds. These limits exclude time queued before dispatch and BLE reply
delivery. A 45-second app deadline accommodates this normal service budget with
margin; it cannot guarantee delivery under an arbitrarily stalled connection.

The firmware creates one `cmd_fun` worker at line 11758. That worker reads the
command queue at 334432–334444 and invokes each selected API synchronously at
334951–334960. A waiting stop therefore delays a queued quit.

The app previously waited 20 seconds for stop, 12 seconds for save, and 5 seconds
for close/cleanup quit. Example, **a possible scenario, not Petrov's measured
timing**: stop takes 28 seconds; the app gives up at 20 seconds and sends quit;
quit's 5-second app timer expires before the firmware finishes stop at second 28.
Both errors can arise without losing a packet. Consistent mapping-service
deadlines avoid rejecting an operation while its firmware deadline is still open.

Successful stop and quit replies are
`{"message":{"result":0,"value":null},"type":"<command>_respond"}`.
The parser correctly allows `value:null` for these commands. Quit calls an Empty
ROS service and ignores the JSON `value`; boolean versus integer is not a mismatch.
Relevant response construction: 338837–338873 and 342310–342347.

## GATT write mode: the existing wire choice matches the stock app

The v2.4.0 Flutter dump proves `withoutResponse`, including framed mapping writes:

* `research/blutter_output_v2.4.0/asm/flutter_novabot/ble/ble_tools.dart:79–80`,
  `157–158`, and `183–184`: `writeData` sends start, data, and end through
  `BluetoothCharacteristic::write` at `0x47c8dc`.
* `research/blutter_output_v2.4.0/asm/flutter_blue_plus/flutter_blue_plus.dart:11071–11075`:
  that method selects `BmWriteType@a4bae1`.
* `research/blutter_output_v2.4.0/objs.txt:36036–36040`: this object is named
  **`withoutResponse`**. `writeDataForMove` uses the same write method at
  `ble_tools.dart:1522–1523`.

`app/src/services/ble.ts`'s `writeFrame` already uses writes without response for
all chunks. Its `withResponse` parameter affects logging only; the provisioning
comment claiming mower writes use `ATT_WRITE_REQ` disagrees with implementation
and the stock-app evidence. Correcting comments/removing dead configuration is
distinct from changing transport. Do not switch mapping to acknowledged GATT
writes merely because of that comment. Application-level `*_respond` validation
remains necessary regardless of GATT mode.

## Offline RTK display does not establish the walk's fix quality

`MappingScreen` reads `rtk_fix_quality` from server-fed device sensors. Its BLE
parser originally supplied only position, heading, and loop closure. A displayed
Fixed/DGPS value can therefore be old when either network leg is unavailable.
A DGPS screenshot after reconnect does not prove the preceding walk used DGPS.

The firmware's `bb` packet does contain fresh, narrower information:
byte 3 = `gps_status_flag`, byte 4 = satellites, byte 7 = localization availability
(`mqtt_node_decompiled.c:306248–306261`). `gps_status_flag` requires five
consecutive `NavSatFix.status == 2` reports, and clears on a different status
(305624–305646). It is **not** the full GGA fix-quality code (0/1/2/4/5).
Label fresh BLE readiness/satellites honestly; show server RTK as stale or unknown
when freshness is unavailable. Do not label BLE readiness as “RTK Fixed”.

The app now decodes satellites, localization availability, and battery percentage
(byte 10) directly from `bb`. While connected in BLE mode these replace the
server-fed chips; missing/disconnected values and RTK quality display `?`.
The readiness flag is deliberately not presented as an RTK quality measurement.

## Save lifecycle and limits of the available evidence

Saved successful-session logs show stop completing in roughly 10–15 ms, and add
taking roughly 11–13 seconds. These are measurements on Ramon's mower, not a
latency bound for Petrov's. His app's 1,068 displayed points are not a measurement
of firmware processing time or necessarily its internal recording-point count.

The captured `novabot_mapping_20260907_133631_3113.log` shows stop at lines 486–489;
overlap detection and CSV generation start with the subsequent save at 490–518.
“Stop mapping” appears at 568, 646, and 779 within that same process/log, with
later commands between them. Contrary to `docs/portable-map-export-import.md`,
this message does **not** establish that the process exits after a save.

Save still changes persistent files and mapping state. A lost save ACK does not
establish that replay is safe. Retry only a failed stop; do not restart the whole
sequence after a save timeout, including post-recharge total-save timeouts.

## Reproduced app failure paths and fixes

Regression tests reproduce a notification subscription failing while the native
link still reports connected, and a native write promise never resolving. The
former left a connection with no ACK receiver; the latter blocked every later
queued command, including stop and cleanup. Notification errors now invalidate
the session. Each BLE write operation has a 5-second deadline; a failure closes
the session instead of replaying a partial frame. Queue identity fences late
chunks even when the native layer reuses its Device object. Reconnection waits
for native cancellation to finish so delayed teardown cannot close the new link.

Mapping ACK deadlines are consistently 45 seconds, including assistant session
entry and auto-recharge. A missing mapping ACK forces a fresh BLE session before
recovery. Assistant entry now requires its existing `result:0,value:null` reply.
The autonomous request's existing type value is unchanged; its stock/custom
encoding is a separate firmware compatibility question.

Opening Android quick settings or backgrounding the app previously left its
movement interval running because React Navigation had not blurred. Native
AppState change/blur now stops the joystick; returning never resumes motion.
Switching mower A to B and back to A remounts the mapping state, preventing an
old A timeout from disconnecting or changing the new A session. A detected
external session can be closed explicitly; it cannot be resumed with guessed
default map0/type values.

## map5+ selection and imported identity

The separate error-125 cause is confirmed in `robot_decision` disassembly:
`map_ids == 255` or unsigned `map_ids > 60000` selects `vision_test` rather than
the coverage task. Decimal map5 is 100000, so recording/importing a map can
succeed while mowing it fails. See
[`multi-map-area-bitmask-decode.md`](multi-map-area-bitmask-decode.md#6-hard-cap-map_ids--60000--vision_test-found-2026-09-08-gh-114)
for addresses and the still untested named-YAML route.

The server now rejects these area codes before sending parameters or movement
commands through normal/custom mowing routes and shared scheduled-mowing code.
App/dashboard display the explanation. This prevents the known firmware failure;
it does not enable ten-zone mowing or alter saved maps. Direct external MQTT
clients bypass these server API guards.

Both legacy ZIP endpoints omitted `file_name`, losing the canonical slot. A ZIP
containing only map4 could consequently be presented as an unnamed map and later
fall back to the wrong slot. Import now keeps work slots, obstacle sub-indices,
and channel endpoints using the existing filename helper. Reimporting the same
canonical areas does not replace existing aliases or geometry on the server.
Real ZIP regressions cover both endpoints, repeated imports, and local XY
coordinate preservation. The old app import-name prompt can still rename other
default-named uploaded maps; this is a separate UI follow-up.

## Device validation that resolves the remaining uncertainty

Source validation: app TypeScript and all 177 tests pass; server TypeScript and
all 1,019 enabled tests pass (39 existing skipped tests). Dashboard TypeScript
and production build pass. Expo production export succeeds for both Android
and iOS Hermes bundles. These checks cover code and packaging, not radio or
mower behavior in a garden.

Capture Petrov's `mqtt_node` command/reply timestamps and corresponding mapping
log around the failed stop. Distinguish command absent, delayed ROS result, reply
generated but not received, and explicit firmware rejection. Record queue errors
such as `ble_pipe_not_space`; a `strJson_send` log alone is not BLE delivery proof.
On a controlled mapping session, verify delayed stop/quit replies, reconnect
failure followed by retry, fresh positioning labels while offline, and a complete
save/upload after reconnect. Confirm saved geometry on the mower and server.
Do not inject lost-save retries or repeat a completed save to test recovery.
The code fixes and synthetic regressions do not establish which failure path
occurred on Petrov's mower, nor explain the 8.5-m gap without its timed trail and
localization logs. No mower commands or firmware modifications were used for
this investigation.
