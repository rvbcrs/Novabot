"""Parse ROS .msg/.srv/.action files into a field-name schema.

Copied verbatim from mower/tests/_iface_schema.py during Phase 0 of the
open mqtt_node project. Keep the two copies in sync — the audit rule
(gap-analysis section 0) applies equally to both packages.
"""
from __future__ import annotations
from dataclasses import dataclass, field as dc_field
from pathlib import Path
import re
import os
from typing import Dict, List


@dataclass
class IfaceSchema:
    """Per-section field set. For .msg → only `fields`; for .srv → request/response;
    for .action → goal/result/feedback."""
    sections: Dict[str, List[str]] = dc_field(default_factory=dict)
    constants: Dict[str, List[str]] = dc_field(default_factory=dict)

    def has_field(self, section: str, name: str) -> bool:
        return name in self.sections.get(section, [])


_FIELD_RE = re.compile(
    r'^\s*'
    r'(?P<type>[A-Za-z_][\w/]*(?:\[\d*\])?(?:<=\d+)?)'  # type with optional array/bound
    r'\s+'
    r'(?P<name>[A-Za-z_]\w*)'
    r'(?:\s*=\s*\S+)?'                          # optional constant value
    r'(?:\s+\S.*)?$'                            # optional default value
)


def parse(path: Path) -> IfaceSchema:
    text = path.read_text()
    schema = IfaceSchema()
    section_names = _section_names_for(path)
    section_idx = 0
    cur_fields: List[str] = []
    cur_constants: List[str] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('---'):
            schema.sections[section_names[section_idx]] = cur_fields
            schema.constants[section_names[section_idx]] = cur_constants
            cur_fields, cur_constants = [], []
            section_idx = min(section_idx + 1, len(section_names) - 1)
            continue
        m = _FIELD_RE.match(line)
        if not m:
            continue
        name = m.group('name')
        # Constants are <UPPER_SNAKE> assigned with =. Detect via regex.
        if '=' in line:
            cur_constants.append(name)
        else:
            cur_fields.append(name)
    schema.sections[section_names[section_idx]] = cur_fields
    schema.constants[section_names[section_idx]] = cur_constants
    return schema


def _section_names_for(path: Path) -> List[str]:
    suffix = path.suffix.lower()
    if suffix == '.msg':
        return ['fields']
    if suffix == '.srv':
        return ['request', 'response']
    if suffix == '.action':
        return ['goal', 'result', 'feedback']
    raise ValueError(f'Unknown interface kind: {path}')


def load_all_schemas(root: Path) -> Dict[str, IfaceSchema]:
    """Walk research/ros2_msg_definitions/. Return dict keyed by
    `<pkg>/<TypeName>` (no extension). E.g. `decision_msgs/SaveMap`."""
    out: Dict[str, IfaceSchema] = {}
    for pkg_dir in root.iterdir():
        if not pkg_dir.is_dir():
            continue
        pkg = pkg_dir.name
        for kind in ('msg', 'srv', 'action'):
            kind_dir = pkg_dir / kind
            if not kind_dir.is_dir():
                continue
            for f in kind_dir.glob(f'*.{kind}'):
                key = f'{pkg}/{f.stem}'
                out[key] = parse(f)
    return out
