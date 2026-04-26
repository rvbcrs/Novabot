"""CommandDispatcher routes inbound MQTT JSON to per-command handlers.

The actual handlers (start_run → ros2_bridge.call_service, etc.) come in
later tasks. This test verifies just the registry mechanics."""
import pytest

from command_dispatcher import CommandDispatcher


def test_dispatch_calls_registered_handler():
    d = CommandDispatcher()
    seen = []
    d.register('start_run', lambda payload: seen.append(('start_run', payload)))
    d.dispatch({'start_run': {'cov_mode': 0}})
    assert seen == [('start_run', {'cov_mode': 0})]


def test_unknown_command_logs_no_raise(caplog):
    d = CommandDispatcher()
    d.dispatch({'no_such_cmd': {'foo': 1}})  # must not raise


def test_dispatch_strips_tz_from_ota_upgrade_cmd():
    """CLAUDE.md OTA fix: tz field forces stock binary into incremental
    mode. Strip it from inbound ota_upgrade_cmd so OUR handler always
    sees full-mode payloads."""
    d = CommandDispatcher()
    seen = []
    d.register('ota_upgrade_cmd', lambda p: seen.append(p))
    d.dispatch({
        'ota_upgrade_cmd': {
            'cmd': 'upgrade', 'type': 'increment', 'tz': 'Europe/Amsterdam',
            'url': 'http://x', 'md5': 'abc', 'version': '1.0',
        }
    })
    assert seen == [{'cmd': 'upgrade', 'type': 'full', 'url': 'http://x',
                     'md5': 'abc', 'version': '1.0'}]


def test_multi_key_payload_dispatches_each():
    d = CommandDispatcher()
    seen = []
    d.register('a', lambda p: seen.append('a'))
    d.register('b', lambda p: seen.append('b'))
    d.dispatch({'a': {}, 'b': {}})
    assert sorted(seen) == ['a', 'b']
