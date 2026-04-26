"""Cross-check every Request/Goal field assignment in `mower/*.py` against
the live ROS interface schemas cached at
`research/ros2_msg_definitions/`. A miss here means the code is writing
to a fabricated field name that will AttributeError at runtime.

The audit at research/documents/field-name-audit-2026-04-26.md surfaced
8 such fabrications. This test prevents them from regressing.

Behaviour:
- Walks all .py files under `mower/` (excluding tests).
- Picks up every `<var> = <Type>.Request()` / `.Goal()` and every
  subsequent `<var>.<field> = ...` assignment.
- Looks up `<Type>` in the schemas (matching the file basename).
- If not found in the schema's request/goal section → FAIL with file:line
  + suggested closest existing field.

Exclusions allowed via the EXCLUSION_LIST below — for now, empty (every
known fabrication has been fixed). Add entries with rationale only when
a future field IS known to be missing on live hardware AND cannot be
removed (e.g. forward-compatibility for a not-yet-deployed firmware).
"""
from __future__ import annotations
from pathlib import Path
from difflib import get_close_matches
import sys

# Path setup so the helper imports work when pytest discovers this file.
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from _iface_schema import load_all_schemas  # noqa: E402
from _source_extractor import extract_all  # noqa: E402

REPO_ROOT = HERE.parents[1]
SCHEMA_ROOT = REPO_ROOT / 'research' / 'ros2_msg_definitions'
MOWER_DIR = HERE.parent


# Known multi-package types (e.g. `LoadMap` exists in both nav2_msgs and
# elsewhere). Disambiguate via the package context the import would use.
# Aliases used in source → real type name → package.
# e.g. `MappingControlSrv` is an alias for MappingControl from mapping_msgs
TYPE_PACKAGE_HINTS = {
    # decision_msgs srv
    'LoadMap': 'nav2_msgs',
    'NavigateToPose': 'nav2_msgs',
    'NavigateToPoseAction': 'nav2_msgs',  # alias: NavigateToPose as NavigateToPoseAction
    'NavigateThroughCoveragePaths': 'coverage_planner',
    'CoveragePathsByFile': 'coverage_planner',
    'StartCoverageTask': 'decision_msgs',
    'GenerateCoveragePath': 'decision_msgs',
    'StartMap': 'decision_msgs',
    'SaveMap': 'decision_msgs',
    'DeleteMap': 'decision_msgs',
    'Charging': 'decision_msgs',
    'ChargingSrv': 'decision_msgs',       # alias: Charging as ChargingSrv
    'SlipEscaping': 'decision_msgs',
    'LocRecoverMoving': 'decision_msgs',
    # mapping_msgs srv — aliases used in source
    'Recording': 'mapping_msgs',
    'RecordingSrv': 'mapping_msgs',       # alias: Recording as RecordingSrv
    'MappingControl': 'mapping_msgs',
    'MappingControlSrv': 'mapping_msgs',  # alias: MappingControl as MappingControlSrv
    'Mapping': 'mapping_msgs',
    'MappingSrv': 'mapping_msgs',         # alias: Mapping as MappingSrv
    'SetChargingPose': 'mapping_msgs',
    'SetChargingPoseSrv': 'mapping_msgs', # alias: SetChargingPose as SetChargingPoseSrv
    'GenerateEmptyMap': 'mapping_msgs',
    'GenerateEmptyMapSrv': 'mapping_msgs', # alias: GenerateEmptyMap as GenerateEmptyMapSrv
    # automatic_recharge_msgs action
    'AutoCharging': 'automatic_recharge_msgs',
    # coverage_planner action
    'BoundaryFollow': 'coverage_planner',
    # nav2_msgs srv
    'ClearCostmapAroundRobot': 'nav2_msgs',
    'SemanticMode': 'nav2_msgs',
    # nav2_pro_msgs srv
    'FreeMoveAround': 'nav2_pro_msgs',
    # general_msgs srv — aliases used in source
    'SetUint8': 'general_msgs',
    'SetUint8Srv': 'general_msgs',        # alias: SetUint8 as SetUint8Srv
    'SaveFile': 'general_msgs',
    'SaveFileSrv': 'general_msgs',        # alias: SaveFile as SaveFileSrv
    # localization_msgs srv
    'LoadUtmOriginInfo': 'localization_msgs',
    'SaveUtmOriginInfo': 'localization_msgs',
    # std_srvs
    'SetBool': 'std_srvs',
    'Trigger': 'std_srvs',
    'Empty': 'std_srvs',
    'EmptySrv': 'std_srvs',              # alias: Empty as EmptySrv
    # rclpy / ros internals — skip (no schema file)
    'SetParameters': None,    # rcl_interfaces — no schema captured
    'SetParamsSrv': None,     # alias: SetParameters as SetParamsSrv
    'CancelGoal': None,       # action_msgs — rclpy internal; skip
    'CancelGoalSrv': None,    # alias: CancelGoal as CancelGoalSrv
    'CommonSrv': None,        # add when needed
    'Common': None,           # add when needed
}

# Deduplicate (last dict-literal value wins in Python 3.7+, but be explicit)
TYPE_PACKAGE_HINTS = {k: v for k, v in TYPE_PACKAGE_HINTS.items()}

# Skip references where we genuinely cannot determine the package
# (e.g. an alias `from foo import X as Y`). Add to suppress with note.
EXCLUSIONS: dict[tuple[str, str, str], str] = {
    # (TypeName, kind, field): reason
}


def test_no_fabricated_field_names():
    schemas = load_all_schemas(SCHEMA_ROOT)
    refs = extract_all(MOWER_DIR)

    failures: list[str] = []
    skipped: list[str] = []

    for ref in refs:
        pkg = TYPE_PACKAGE_HINTS.get(ref.type_name)
        if pkg is None:
            # Either an internal type (e.g. CancelGoal from rclpy) or an
            # un-mapped one — either way, we can't validate. Record so
            # someone can extend the hints.
            skipped.append(
                f'{ref.file}:{ref.line}: {ref.type_name}.{ref.field} '
                f'(no package mapping)')
            continue

        # For aliases, the schema key uses the canonical type name.
        # Alias map: source name → canonical schema name
        ALIAS_TO_CANONICAL = {
            'NavigateToPoseAction': 'NavigateToPose',
            'ChargingSrv': 'Charging',
            'RecordingSrv': 'Recording',
            'MappingControlSrv': 'MappingControl',
            'MappingSrv': 'Mapping',
            'SetChargingPoseSrv': 'SetChargingPose',
            'GenerateEmptyMapSrv': 'GenerateEmptyMap',
            'SetUint8Srv': 'SetUint8',
            'SaveFileSrv': 'SaveFile',
            'EmptySrv': 'Empty',
        }
        canonical = ALIAS_TO_CANONICAL.get(ref.type_name, ref.type_name)
        key = f'{pkg}/{canonical}'
        schema = schemas.get(key)
        if schema is None:
            failures.append(
                f'{ref.file}:{ref.line}: schema {key} not in '
                f'research/ros2_msg_definitions/ — capture it via SSH first')
            continue

        excl_key = (ref.type_name, ref.kind, ref.field)
        if excl_key in EXCLUSIONS:
            continue

        section = ref.kind  # 'request' | 'goal'
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
            f'{len(failures)} fabricated field reference(s) in mower/. '
            f'Audit rule: see gap-analysis section 0.\n\n'
            + '\n'.join(failures)
        )
        if skipped:
            msg += (
                f'\n\n{len(skipped)} reference(s) skipped (no package mapping):\n'
                + '\n'.join(skipped[:10])
            )
        raise AssertionError(msg)


def test_all_referenced_types_have_schemas():
    """Sanity: every TypeName resolved by the hint table must have a schema
    file on disk. Catches drift between the hint table and what's been
    captured."""
    schemas = load_all_schemas(SCHEMA_ROOT)

    ALIAS_TO_CANONICAL = {
        'NavigateToPoseAction': 'NavigateToPose',
        'ChargingSrv': 'Charging',
        'RecordingSrv': 'Recording',
        'MappingControlSrv': 'MappingControl',
        'MappingSrv': 'Mapping',
        'SetChargingPoseSrv': 'SetChargingPose',
        'GenerateEmptyMapSrv': 'GenerateEmptyMap',
        'SetUint8Srv': 'SetUint8',
        'SaveFileSrv': 'SaveFile',
        'EmptySrv': 'Empty',
    }

    missing: list[str] = []
    seen: set[str] = set()
    for type_name, pkg in TYPE_PACKAGE_HINTS.items():
        if pkg is None:
            continue
        canonical = ALIAS_TO_CANONICAL.get(type_name, type_name)
        key = f'{pkg}/{canonical}'
        if key in seen:
            continue
        seen.add(key)
        if key not in schemas:
            missing.append(key)
    if missing:
        raise AssertionError(
            f'TYPE_PACKAGE_HINTS references {len(missing)} type(s) without a '
            f'schema file in research/ros2_msg_definitions/:\n  '
            + '\n  '.join(missing)
        )


def test_no_fabricated_endpoint_names():
    """Service / action / topic NAMES used by `create_client`,
    `create_publisher`, `create_subscription`, `create_service`,
    `ActionClient`, `ActionServer` must appear in the live mower's
    snapshot at research/documents/closed-decision-graph-snapshot-2026-04-26.txt.

    Catches typos like `/novabot_mapping/mapping_data` (which is a topic,
    not a service).
    """
    import re
    snap_path = (REPO_ROOT / 'research' / 'documents'
                 / 'closed-decision-graph-snapshot-2026-04-26.txt')
    if not snap_path.exists():
        import pytest
        pytest.skip(
            f'Snapshot file not found: {snap_path}. '
            'Run mower/tests/runtime/run_smoke.sh on the live mower to create it.')

    snap = snap_path.read_text()

    src = '\n'.join(
        f.read_text() for f in MOWER_DIR.glob('*.py') if not f.name.startswith('test_')
    )
    # Pull every endpoint string used in a create_* call. Conservative pattern.
    endpoint_re = re.compile(
        r"(?:create_client|create_publisher|create_subscription|create_service|ActionClient|ActionServer)\s*\("
        r"[^)]*?'(/[^']+)'", re.DOTALL,
    )
    endpoints = set(endpoint_re.findall(src))

    # Endpoints we KNOW are open-only (we expose them; closed binary doesn't
    # need to) OR are standard ROS2 infrastructure endpoints that exist on the
    # live mower but don't appear in the snapshot (which covers only the two
    # robot_decision / decision_assistant nodes).
    OPEN_ONLY = {
        '/decision_assistant/load_map',     # we serve it; closed expects it
        '/decision_assistant/escape_pose',  # we publish; closed has identical
        '/decision_assistant/move_abnormal',
        '/decision_assistant/robot_out_working_zone',
        '/collision_range',
        '/robot_decision/map_position',  # we publish (formerly fabricated as srv)
        # Standard ROS2 infra endpoints on other mower nodes (not in snapshot):
        '/auto_recharge_server/set_parameters',          # rcl_interfaces std param srv
        '/local_costmap/local_costmap_rclcpp_node/set_parameters',  # nav2 costmap param srv
        '/navigate_to_pose/_action/cancel_goal',         # nav2 action cancel endpoint
        '/perception/points_labeled',                    # perception topic
        '/robot_combination_localization/combination_status',  # localization topic
    }

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
            'a refresh. Run mower/tests/runtime/run_smoke.sh on the live '
            'mower and update closed-decision-graph-snapshot-*.txt.'
        )
