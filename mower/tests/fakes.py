"""Lightweight fakes that mimic the rclpy Node surface area used by the
robot_decision modules. Pure-logic tests can use these without bringing up a
real DDS runtime."""
from __future__ import annotations
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable


@dataclass
class FakeLogger:
    records: list[tuple[str, str]] = field(default_factory=list)

    def info(self, msg: str):
        self.records.append(('info', msg))

    def warn(self, msg: str):
        self.records.append(('warn', msg))

    def warning(self, msg: str):
        self.records.append(('warn', msg))

    def error(self, msg: str):
        self.records.append(('error', msg))

    def debug(self, msg: str):
        self.records.append(('debug', msg))


@dataclass
class FakeParameter:
    value: Any


@dataclass
class FakePublisher:
    topic: str
    msgs: list[Any] = field(default_factory=list)

    def publish(self, msg):
        self.msgs.append(msg)


@dataclass
class FakeNode:
    parameters: dict[str, Any] = field(default_factory=dict)
    publishers: dict[str, FakePublisher] = field(default_factory=dict)
    services: dict[str, Callable] = field(default_factory=dict)
    subscriptions: dict[str, list[Callable]] = field(
        default_factory=lambda: defaultdict(list))
    logger: FakeLogger = field(default_factory=FakeLogger)

    def get_logger(self):
        return self.logger

    def declare_parameter(self, name, default):
        self.parameters.setdefault(name, default)

    def get_parameter(self, name):
        return FakeParameter(self.parameters[name])

    def set_parameter_value(self, name, value):
        self.parameters[name] = value

    def create_publisher(self, _msg_type, topic, _qos):
        pub = self.publishers.setdefault(topic, FakePublisher(topic))
        return pub
