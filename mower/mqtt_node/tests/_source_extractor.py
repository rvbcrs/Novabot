"""AST source extractor for mower/mqtt_node.

Copied from mower/tests/_source_extractor.py and retargeted at the new
package directory. Same Reference dataclass, same visitor logic, same
SUFFIX_HINTS — only the directory walked changes.
"""
from __future__ import annotations
import ast
from dataclasses import dataclass
from pathlib import Path
from typing import List


@dataclass
class Reference:
    file: str
    line: int
    type_name: str  # e.g. 'Mapping' or 'CoveragePathsByFile'
    field: str
    kind: str       # 'request' | 'response' | 'goal' | 'result' | 'feedback' | 'fields'


# Map common variable names to their kind. Extended on the fly via the
# RHS of `Request()` / `Goal()` constructors.
SUFFIX_HINTS = {
    'request': 'request',
    'req': 'request',
    'goal': 'goal',
    'response': 'response',
    'resp': 'response',
    'result': 'result',
    'fb': 'feedback',
}


class _Visitor(ast.NodeVisitor):
    def __init__(self, file: str):
        self.file = file
        self.refs: List[Reference] = []
        # Map local var name → (TypeName, kind)
        self._var_types: dict[str, tuple[str, str]] = {}

    def visit_Assign(self, node: ast.Assign):  # noqa: N802
        # Pattern A: `req = <Type>.Request()` / `.Goal()`
        if (
            len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
        ):
            attr = node.value.func.attr
            if attr in ('Request', 'Goal') and isinstance(node.value.func.value, ast.Name):
                type_name = node.value.func.value.id
                kind = 'request' if attr == 'Request' else 'goal'
                self._var_types[node.targets[0].id] = (type_name, kind)
        # Pattern B: `req.<field> = ...`  /  `goal.<field> = ...`
        if (
            len(node.targets) == 1
            and isinstance(node.targets[0], ast.Attribute)
            and isinstance(node.targets[0].value, ast.Name)
        ):
            varname = node.targets[0].value.id
            field = node.targets[0].attr
            if varname in self._var_types:
                type_name, kind = self._var_types[varname]
                self.refs.append(Reference(
                    self.file, node.lineno, type_name, field, kind))
        self.generic_visit(node)


def extract(path: Path) -> List[Reference]:
    tree = ast.parse(path.read_text(), filename=str(path))
    v = _Visitor(str(path))
    v.visit(tree)
    return v.refs


def extract_all(mower_dir: Path) -> List[Reference]:
    """Extract all field references from mower/mqtt_node/*.py.

    Walks the mqtt_node directory and parses each Python file to find
    request/goal/response/result/feedback field assignments and reads.
    Test files (test_*.py) are skipped.
    """
    out: List[Reference] = []
    for f in mower_dir.glob('*.py'):
        if f.name.startswith('test_'):
            continue
        out.extend(extract(f))
    return out
