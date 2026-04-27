"""Route inbound MQTT JSON payloads to registered handlers.

Inbound payloads from app/server look like:
    { "<cmd_name>": { ...fields... } }

The dispatcher splits on top-level keys; each key is one command. A
single payload can carry multiple commands (the protocol allows it).

Handlers may return a response dict. If they do AND a `respond_publisher`
callback was wired, the dispatcher publishes
    { "<cmd_name>_respond": <response dict> }
back to the app. This is the path stock binaries use to send
`start_navigation_respond`, `save_map_respond`, etc. (per
docs/reference/MQTT.md command/response table).

The OTA-tz strip is applied before any handler runs:
- The Novabot app ALWAYS sends `tz: "Europe/Amsterdam"` in
  `ota_upgrade_cmd`.
- mqtt_node (stock + ours) reads tz, writes it to a timezone file,
  and FALSELY decides type:"full" → "increment". That breaks OTA.
- The server-side broker fix already strips tz from app→mower
  (CLAUDE.md "OTA — KRITIEK"). We strip again here as defense in
  depth — if a payload reaches us with tz, our handler sees the
  cleaned form.
"""
from __future__ import annotations
import logging
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger('mqtt_node.command_dispatcher')

Handler = Callable[[Dict[str, Any]], Optional[Dict[str, Any]]]
RespondPublisher = Callable[[str, Dict[str, Any]], None]
"""(respond_cmd_name, response_dict) -> None — publishes
    { respond_cmd_name: response_dict } encrypted to Dart/Receive_mqtt/<SN>.
"""


class CommandDispatcher:
    def __init__(self, respond_publisher: Optional[RespondPublisher] = None):
        self._handlers: Dict[str, Handler] = {}
        self._respond_publisher = respond_publisher

    def set_respond_publisher(self, publisher: RespondPublisher) -> None:
        self._respond_publisher = publisher

    def register(self, cmd: str, handler: Handler) -> None:
        if cmd in self._handlers:
            log.warning('command_dispatcher: %s re-registered, overriding', cmd)
        self._handlers[cmd] = handler

    def dispatch(self, payload: Dict[str, Any]) -> None:
        if not isinstance(payload, dict):
            log.warning('command_dispatcher: top-level payload not dict: %r', payload)
            return
        for cmd, body in payload.items():
            if cmd == 'ota_upgrade_cmd' and isinstance(body, dict):
                body = self._strip_ota_tz(body)
            handler = self._handlers.get(cmd)
            if handler is None:
                log.info('command_dispatcher: unknown cmd %s (skipping)', cmd)
                continue
            try:
                response = handler(body)
            except Exception:
                log.exception('command_dispatcher: handler %s raised', cmd)
                continue
            if response is None:
                continue
            if not isinstance(response, dict):
                log.warning(
                    'command_dispatcher: %s returned non-dict %r (skipping respond)',
                    cmd, type(response).__name__)
                continue
            if self._respond_publisher is None:
                log.debug('command_dispatcher: %s has response but no respond_publisher wired',
                          cmd)
                continue
            try:
                self._respond_publisher(f'{cmd}_respond', response)
            except Exception:
                log.exception('command_dispatcher: respond_publisher raised for %s', cmd)

    @staticmethod
    def _strip_ota_tz(body: Dict[str, Any]) -> Dict[str, Any]:
        out = {k: v for k, v in body.items() if k != 'tz'}
        out['type'] = 'full'  # force full per CLAUDE.md OTA fix
        return out

    @property
    def registered_commands(self) -> List[str]:
        return sorted(self._handlers.keys())
