"""config.load() reads /userdata/json_config.json + http_address.txt
and applies env var overrides. Per CLAUDE.md, http_address.txt holds
'host:port' WITHOUT 'http://' or trailing newline."""
import os
import tempfile
import textwrap
from pathlib import Path

import pytest

from config import Config, load


def write(tmp: Path, name: str, content: str) -> Path:
    p = tmp / name
    p.write_text(content)
    return p


def test_load_minimal(tmp_path, monkeypatch):
    json_cfg = write(tmp_path, 'json_config.json', textwrap.dedent('''\
        {"mqtt": {"server": "192.168.0.222", "port": 1883}}
    '''))
    addr = write(tmp_path, 'http_address.txt', '192.168.0.222:80')
    cfg = load(json_path=json_cfg, http_addr_path=addr)
    assert cfg.mqtt_host == '192.168.0.222'
    assert cfg.mqtt_port == 1883
    assert cfg.http_host == '192.168.0.222'
    assert cfg.http_port == 80


def test_env_var_overrides_broker(tmp_path, monkeypatch):
    json_cfg = write(tmp_path, 'json_config.json',
                     '{"mqtt": {"server": "old", "port": 1}}')
    addr = write(tmp_path, 'http_address.txt', 'old:1')
    monkeypatch.setenv('BROKER_HOST', 'new')
    monkeypatch.setenv('BROKER_PORT', '8883')
    cfg = load(json_path=json_cfg, http_addr_path=addr)
    assert cfg.mqtt_host == 'new'
    assert cfg.mqtt_port == 8883


def test_aes_bypass_env(tmp_path, monkeypatch):
    json_cfg = write(tmp_path, 'json_config.json', '{"mqtt": {}}')
    addr = write(tmp_path, 'http_address.txt', 'x:1')
    monkeypatch.setenv('AES_BYPASS_SNS', 'LFIN1231000211,LFIN2230700238')
    cfg = load(json_path=json_cfg, http_addr_path=addr)
    assert cfg.aes_bypass_sns == {'LFIN1231000211', 'LFIN2230700238'}


def test_shadow_mode_default_off(tmp_path, monkeypatch):
    json_cfg = write(tmp_path, 'json_config.json', '{"mqtt": {}}')
    addr = write(tmp_path, 'http_address.txt', 'x:1')
    monkeypatch.delenv('OPEN_MQTT_NODE_SHADOW', raising=False)
    cfg = load(json_path=json_cfg, http_addr_path=addr)
    assert cfg.shadow_mode is False


@pytest.mark.parametrize('val', ['1', 'true', 'YES', 'on'])
def test_shadow_mode_env_truthy(tmp_path, monkeypatch, val):
    json_cfg = write(tmp_path, 'json_config.json', '{"mqtt": {}}')
    addr = write(tmp_path, 'http_address.txt', 'x:1')
    monkeypatch.setenv('OPEN_MQTT_NODE_SHADOW', val)
    cfg = load(json_path=json_cfg, http_addr_path=addr)
    assert cfg.shadow_mode is True


@pytest.mark.parametrize('val', ['0', 'false', 'no', 'off', ''])
def test_shadow_mode_env_falsy(tmp_path, monkeypatch, val):
    json_cfg = write(tmp_path, 'json_config.json', '{"mqtt": {}}')
    addr = write(tmp_path, 'http_address.txt', 'x:1')
    monkeypatch.setenv('OPEN_MQTT_NODE_SHADOW', val)
    cfg = load(json_path=json_cfg, http_addr_path=addr)
    assert cfg.shadow_mode is False
