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


def test_handler_response_publishes_respond_message():
    """Handlers that return a dict must trigger a *_respond publish."""
    published = []
    d = CommandDispatcher(
        respond_publisher=lambda key, body: published.append((key, body)))
    d.register('start_navigation',
               lambda p: {'result': 0, 'msg': 'start_navigation_respond'})
    d.dispatch({'start_navigation': {'cov_mode': 0}})
    assert published == [
        ('start_navigation_respond', {'result': 0, 'msg': 'start_navigation_respond'}),
    ]


def test_handler_returning_none_does_not_publish():
    """OTA / fire-and-forget handlers may return None — no respond message."""
    published = []
    d = CommandDispatcher(
        respond_publisher=lambda key, body: published.append((key, body)))
    d.register('ota_upgrade_cmd', lambda p: None)
    d.dispatch({'ota_upgrade_cmd': {
        'cmd': 'upgrade', 'type': 'full', 'content': 'app',
        'url': 'http://x', 'md5': 'abc', 'version': '1.0',
    }})
    assert published == []


def test_set_respond_publisher_wires_after_construction():
    """main.py constructs dispatcher first, wires publish later."""
    d = CommandDispatcher()
    published = []
    d.set_respond_publisher(lambda key, body: published.append((key, body)))
    d.register('stop_task', lambda p: {'result': 0, 'msg': 'stop_task_respond'})
    d.dispatch({'stop_task': {}})
    assert published == [('stop_task_respond', {'result': 0, 'msg': 'stop_task_respond'})]


def test_publisher_exception_does_not_break_dispatch():
    """If publish fails (broker disconnect, AES error), keep dispatching
    the rest of a multi-key payload."""
    def boom(_key, _body):
        raise RuntimeError('broker dead')
    d = CommandDispatcher(respond_publisher=boom)
    seen = []
    d.register('a', lambda p: {'result': 0, 'msg': 'a_respond'})
    d.register('b', lambda p: seen.append('b'))
    d.dispatch({'a': {}, 'b': {}})
    assert seen == ['b']
