# mower/mqtt_node/tests/test_field_name_verification.py
"""Cross-check every Request/Goal field assignment in mower/mqtt_node/*.py
against the live ROS interface schemas cached at
research/ros2_msg_definitions/. A miss here means the code is writing
to a fabricated field name that will AttributeError at runtime.

Mirror of mower/tests/test_field_name_verification.py — see that file
for the full design rationale and the audit history that motivated this
framework.
"""
from __future__ import annotations
from pathlib import Path
from difflib import get_close_matches
import sys

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from _iface_schema import load_all_schemas  # noqa: E402
from _source_extractor import extract_all  # noqa: E402

REPO_ROOT = HERE.parents[2]
SCHEMA_ROOT = REPO_ROOT / 'research' / 'ros2_msg_definitions'
PACKAGE_DIR = HERE.parent

# Same hint table as the open-decision suite. Add new entries here when
# mqtt_node touches a Request/Goal type that doesn't appear in the
# open-decision codebase.
TYPE_PACKAGE_HINTS = {
    'LoadMap': 'nav2_msgs',
    'NavigateToPose': 'nav2_msgs',
    'NavigateThroughCoveragePaths': 'coverage_planner',
    'CoveragePathsByFile': 'coverage_planner',
    'StartCoverageTask': 'decision_msgs',
    'GenerateCoveragePath': 'decision_msgs',
    'StartMap': 'decision_msgs',
    'SaveMap': 'decision_msgs',
    'DeleteMap': 'decision_msgs',
    'Charging': 'decision_msgs',
    'SlipEscaping': 'decision_msgs',
    'LocRecoverMoving': 'decision_msgs',
    'BoundaryFollow': 'decision_msgs',
    'AutoCharging': 'decision_msgs',
    'Recording': 'mapping_msgs',
    'Mapping': 'mapping_msgs',
    'MappingControl': 'mapping_msgs',
    'GenerateEmptyMap': 'mapping_msgs',
    'SetChargingPose': 'mapping_msgs',
    'SetBool': 'std_srvs',
    'Trigger': 'std_srvs',
    'Empty': 'std_srvs',
    'FreeMoveAround': 'nav2_pro_msgs',
    'Common': 'novabot_msgs',
    'SetUint8': 'novabot_msgs',
    'SaveFile': 'novabot_msgs',
    'LoadUtmOriginInfo': 'novabot_msgs',
    'SaveUtmOriginInfo': 'novabot_msgs',
    'ResetUtmOriginInfo': 'novabot_msgs',
    'ClearCostmapAroundRobot': 'nav2_msgs',
}

EXCLUSIONS: dict[tuple[str, str, str], str] = {}


def test_no_fabricated_field_names():
    schemas = load_all_schemas(SCHEMA_ROOT)
    refs = extract_all(PACKAGE_DIR)

    failures: list[str] = []
    skipped: list[str] = []

    for ref in refs:
        pkg = TYPE_PACKAGE_HINTS.get(ref.type_name)
        if pkg is None:
            skipped.append(
                f'{ref.file}:{ref.line}: {ref.type_name}.{ref.field} '
                f'(no package mapping)')
            continue
        key = f'{pkg}/{ref.type_name}'
        schema = schemas.get(key)
        if schema is None:
            failures.append(
                f'{ref.file}:{ref.line}: schema {key} not in '
                f'research/ros2_msg_definitions/ — capture it via SSH first')
            continue
        section = ref.kind
        if not schema.has_field(section, ref.field):
            existing = schema.sections.get(section, [])
            close = get_close_matches(ref.field, existing, n=3, cutoff=0.6)
            suggestion = (
                f' did you mean {", ".join(close)}?' if close else ''
            )
            failures.append(
                f'{ref.file}:{ref.line}: '
                f'{ref.type_name}.{section.capitalize()} has no field '
                f'`{ref.field}`. Live fields: {existing}.{suggestion}'
            )

    if failures:
        msg = (
            f'{len(failures)} fabricated field reference(s) in '
            f'mower/mqtt_node/. Audit rule: gap-analysis section 0.\n\n'
            + '\n'.join(failures)
        )
        if skipped:
            msg += (
                f'\n\n{len(skipped)} reference(s) skipped '
                f'(no package mapping):\n' + '\n'.join(skipped[:10])
            )
        raise AssertionError(msg)


def test_no_fabricated_endpoint_names():
    """Service / action / topic NAMES used by `create_client`,
    `create_publisher`, `create_subscription`, `create_service`,
    `ActionClient`, `ActionServer` must appear in the live mower's
    snapshot at research/documents/mqtt_node-graph-snapshot.txt.

    Catches typos like `/novabot_mapping/mapping_data` (which is a topic,
    not a service) — the same regression class that bit the open
    robot_decision project before it shipped.
    """
    import re
    snap = (REPO_ROOT / 'research' / 'documents'
            / 'mqtt_node-graph-snapshot.txt').read_text()

    src = '\n'.join(
        f.read_text() for f in PACKAGE_DIR.glob('*.py')
        if not f.name.startswith('test_')
    )
    endpoint_re = re.compile(
        r"(?:create_client|create_publisher|create_subscription|"
        r"create_service|ActionClient|ActionServer)\s*\("
        r"[^)]*?'(/[^']+)'", re.DOTALL,
    )
    endpoints = set(endpoint_re.findall(src))

    OPEN_ONLY: set[str] = set()  # populate as needed during Phase 2

    missing: list[str] = []
    for ep in sorted(endpoints):
        if ep in OPEN_ONLY:
            continue
        if ep not in snap:
            missing.append(ep)

    if missing:
        raise AssertionError(
            f'{len(missing)} endpoint(s) not found in the live snapshot:\n  '
            + '\n  '.join(missing)
            + '\n\nEither the endpoint is fabricated, or the snapshot needs '
            'a refresh. Re-run Task 1.3 Step 1 to recapture.'
        )
