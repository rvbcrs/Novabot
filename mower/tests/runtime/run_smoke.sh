#!/usr/bin/env bash
# mower/tests/runtime/run_smoke.sh — copy to /tmp on mower and run.
set -u
export ROS_LOCALHOST_ONLY=1
. /opt/ros/galactic/setup.bash 2>/dev/null || true

echo '=== service servers (expect 19) ==='
ros2 service list 2>&1 | grep -E '(/robot_decision/|/decision_assistant/)' | sort || true

echo '=== action servers ==='
ros2 action list 2>&1 | grep -E '(/robot_decision|/decision_assistant)' | sort || true

echo '=== topic types (sanity) ==='
for t in /robot_decision/map_position /decision_assistant/robot_out_working_zone; do
  echo "--- $t"
  ros2 topic info "$t" -v 2>&1 || true
done

echo
echo '=== node info: /robot_decision ==='
ros2 node info /robot_decision 2>&1 | head -200 || true

echo
echo '=== node info: /decision_assistant ==='
ros2 node info /decision_assistant 2>&1 | head -200 || true

echo
echo '=== param dump (robot_decision) ==='
ros2 param dump /robot_decision 2>&1 | head -100 || true

echo
echo '=== param dump (decision_assistant) ==='
ros2 param dump /decision_assistant 2>&1 | head -100 || true
