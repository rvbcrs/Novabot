"""
State machine enums and transition logic for the open-source robot_decision.

Mirrors the original C++ robot_decision state machine exactly.
Values derived from reverse engineering of the binary + decision_msgs/RobotStatus.msg.
"""

from enum import IntEnum


class TaskMode(IntEnum):
    """Task modes published in RobotStatus.task_mode.
    These are the high-level modes visible to the app/MQTT."""
    FREE = 0        # Idle, ready for commands
    COVER = 1       # Coverage/mowing task active
    RECHARGING = 2  # Recharging in progress (original typo: RECHARING)
    MAPPING = 3     # Mapping session active
    CHARGING = 4    # On charger
    STOP = 5        # Stopped


class WorkStatus(IntEnum):
    """Internal work_status values. These map to the internal state machine.
    Published in RobotStatus.work_status."""
    # Boot states (0-9)
    SYSTEM_CHECK_INIT = 0
    SENSOR_INIT = 1
    LOCALIZATION_UTM_INIT = 2
    LOCALIZATION_INIT = 3
    INIT_SUCCESS = 9

    # Undocking (10-19)
    QUIT_PILE_INIT = 10

    # Mapping states (20-39)
    MANUAL_MAPPING_WORKING_ZONE = 20
    MANUAL_MAPPING_OBSTACLE = 21
    MANUAL_MAPPING_UNICOM = 22
    MANUAL_MAPPING_UNICOM_TO_STATION = 23
    ASSISTANT_MAPPING_WORKING_ZONE = 24
    ASSISTANT_MAPPING_OBSTACLE = 25
    MAPPING_STOP_RECORD = 26
    MAPPING_EDIT_MODE = 27
    AUTO_ERASE_MAPPING = 28
    AUTO_ERASE_MAPPING_FAILED = 29
    AUTO_ERASE_MAPPING_SUCCESS = 30
    SETTING_CHARGING_STATION = 31

    # Coverage/mowing states (100-150)
    COVERING = 100
    BOUNDARY_COVERING = 101
    COVERING_MISSING = 102
    MOVING = 103

    # Recharge states (50-69)
    RETURN_TO_PILE = 50
    ALIGN_PILE = 51
    SEARCHING_VISUAL = 52

    # Task completion (70-79)
    FINISHED_ONCE = 70
    FAILED_ONCE = 71
    CANCELLED = 72
    REQUEST_START = 73
    WARN_REPEATED_START = 74

    # Error handling (80-99)
    LOC_ERROR_HANDLE = 80
    LORA_ERROR_HANDLE = 81
    SLIPPING_HANDLE = 82
    ROBOT_OUT_OF_MAP_HANDLE = 83
    RECOVER_ERROR_STOP = 84
    LOWER_POWER_STOP = 85
    TIME_LIMIT_STOP = 86
    USER_STOP = 87
    USER_RECHARGE_STOP = 88

    # Map editing (200+)
    DELETE_CHILD_MAP = 200
    DELETE_OBSTACLE = 201
    DELETE_UNICOM = 202
    ERROR_LOAD_MAP = 203

    # Misc
    PATROLLING = 110


class RechargeStatus(IntEnum):
    """Recharge status values for RobotStatus.recharge_status."""
    IDLE = 0
    NAVIGATING = 1
    DOCKING = 2
    CHARGING = 3
    CHARGED = 4
    FAILED = 5


class MergedWorkStatus(IntEnum):
    """Simplified status for app display. Maps to RobotStatus.merged_work_status.
    Same values as TaskMode constants in the msg."""
    FREE = 0
    COVER = 1
    RECHARGING = 2
    MAPPING = 3
    CHARGING = 4
    STOP = 5


class CovWorkStatus(IntEnum):
    """Coverage action feedback work_status values.
    From NavigateThroughCoveragePaths.action feedback."""
    STOP = 0
    EXCEPTION_STOP = 1
    RECOVERABLE_STUCK_STOP = 2
    COVERING = 100
    AVOIDING = 120
    BOUNDARY_COVERING = 150
    RECOVERING = 200
    MOVING = 250


class CovResultStatus(IntEnum):
    """Coverage action result status values.
    From NavigateThroughCoveragePaths.action result."""
    TF_RELATED_EXCEPTION = 1
    INPUT_RELATED_EXCEPTION = 2
    CANCELED = 3
    NO_FIXED_RTK_FOR_START = 4
    CURRENT_STUCK_OR_OUT_MAP = 5
    NAV_TO_POSE_ACTION_EXCEPTION = 6
    NO_PATH_TO_GOAL = 7
    PARTIALLY_FINISHED = 90
    FINISHED = 100


class AutoChargingResult(IntEnum):
    """AutoCharging action result codes.
    From automatic_recharge_msgs/AutoCharging.action."""
    SUCCESS = 100
    NO_VISUAL_SIGNAL = 3
    NO_CHARGE_POSE_SET = 5
    NAV_TO_GUIDE_POSE_EXCEPTION = 6
    CANCELED = 7
    ARUCO_SERVICE_EXCEPTION = 8
    MOVE_ROBOT_EXCEPTION = 9
    TF_RELATED_EXCEPTION = 10
    NAV_TO_POSE_ACTION_FAIL = 11
    RECHARGE_FAIL = 12
    OVERTIME_WORK = 13


class LocStatus(IntEnum):
    """Localization status from CombinationStatus.msg."""
    # Errors (<100)
    NO_RTK_DATA_ERROR = 1
    RTK_SINGLE_ERROR = 2
    ODOM_ERROR = 3
    EXIT_MAX_INS_ERROR = 4
    FIXED_STATION_MOVE_ERROR = 5
    FIXED_JUMP_ERROR = 6

    # Waiting (100)
    WAIT_RTK_DATA = 100

    # Warnings (101-149)
    COST_TOO_BIG_WARN = 101
    SLIP_WARN = 120
    CARRY_WARN = 121
    INS_ONLY_WARN = 122
    USING_FLOAT_WARN = 123

    # OK (>=150)
    ORIGIN_INITIAL = 190
    SUCCESS = 200
    VISUAL_TAKE = 210


class ErrorStatus(IntEnum):
    """Error status codes published in RobotStatus.error_status.
    Derived from ChassisIncident flags and internal logic."""
    NONE = 0
    PUSH_BUTTON_STOP = 1
    COLLISION_STOP = 2
    UPRAISE_STOP = 3
    TILE_STOP = 4
    TURN_OVER = 5
    LEFT_MOTOR_STALL = 6
    RIGHT_MOTOR_STALL = 7
    BLADE_MOTOR_STALL = 8
    LEFT_MOTOR_OVERCURRENT = 9
    RIGHT_MOTOR_OVERCURRENT = 10
    BLADE_MOTOR_OVERCURRENT = 11
    IMU_ERROR = 12
    LORA_ERROR = 13
    RTK_ERROR = 14
    CHARGE_STOP = 15
    WHEEL_OVERCURRENT_TIMEOUT = 16
    NO_PIN_CODE = 17
    USB_BUSY = 18
    USB_NOT_OK = 19
    NO_SET_PIN_CODE = 20
    LIFT_MOTOR_ERROR = 21
    # Internal errors
    LOW_BATTERY = 100
    LOC_BAD = 101
    OUT_OF_MAP = 102
    CPU_OVERHEAT = 103
    LOAD_MAP_FAILED = 104
    NO_PATH = 105
    HARDWARE_ERROR = 106
    # App-visible error_status 151 = PIN lock
    PIN_LOCK = 151
