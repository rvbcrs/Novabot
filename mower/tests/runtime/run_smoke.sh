#!/usr/bin/env bash
# mower/tests/runtime/run_smoke.sh — copy to /tmp on mower and run.
set -euo pipefail
export ROS_LOCALHOST_ONLY=1
. /opt/ros/galactic/setup.bash 2>/dev/null || true

echo '=== service servers (expect 19) ==='
ros2 service list | grep -E '(/robot_decision/|/decision_assistant/)' | sort

echo '=== action servers ==='
ros2 action list | grep -E '(/robot_decision|/decision_assistant)' | sort

echo '=== topic types (sanity) ==='
for t in /robot_decision/map_position /decision_assistant/robot_out_working_zone; do
  echo "--- $t"
  ros2 topic info "$t" -v || true
done
