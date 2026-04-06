#!/bin/bash
# install_hook.sh — Install open_decision boot hook in run_novabot.sh
# Called by deploy.sh (SCP'd to mower, then executed remotely)
#
# This adds a block to the start) section that:
#   1. Waits 20s for ROS2 to start
#   2. Kills the C++ robot_decision
#   3. Starts our Python robot_decision
#
# Also adds a pkill to the stop) section.

set -e

RUN_SCRIPT=/root/novabot/scripts/run_novabot.sh

if ! [ -f "$RUN_SCRIPT" ]; then
    echo "ERROR: $RUN_SCRIPT not found"
    exit 1
fi

if grep -q 'open_decision' "$RUN_SCRIPT"; then
    echo "Boot hook already installed — skipping"
    exit 0
fi

# Create the hook block as a temp file
cat > /tmp/open_decision_hook_block.txt << 'BLOCK'

  # CUSTOM: Open robot_decision (vervangt closed-source C++ binary)
  # Bestanden in /userdata/open_decision/ overleven firmware updates.
  # Rollback: rm -rf /userdata/open_decision && reboot
  if [ -d "/userdata/open_decision" ] && [ -f "/userdata/open_decision/robot_decision.py" ]; then
      (sleep 20 && killall -q -9 robot_decision && sleep 2 && \
       source /opt/ros/galactic/setup.bash && \
       source /root/novabot/install/setup.bash && \
       export PYTHONPATH=$PYTHONPATH:/userdata/open_decision && \
       export ROS_LOG_DIR=/root/novabot/data/ros2_log && \
       export ROS_LOCALHOST_ONLY=1 && \
       python3 /userdata/open_decision/robot_decision.py \
       --ros-args --params-file /root/novabot/install/compound_decision/share/compound_decision/config/robot_decision.yaml \
       >> /userdata/open_decision/decision.log 2>&1) &
      echo "Open robot_decision scheduled (20s delay)" >> $LOGS_PATH/open_decision.log
  fi
BLOCK

# Find injection point: after camera_stream block, or before daemon_node
if grep -q 'camera_stream.py' "$RUN_SCRIPT"; then
    # Inject after the camera_stream fi block
    ANCHOR=$(grep -n 'Camera stream scheduled' "$RUN_SCRIPT" | tail -1 | cut -d: -f1)
    if [ -n "$ANCHOR" ]; then
        # Find the next 'fi' after the anchor
        FI_OFFSET=$(tail -n +"$ANCHOR" "$RUN_SCRIPT" | grep -n '^ *fi' | head -1 | cut -d: -f1)
        INSERT_LINE=$((ANCHOR + FI_OFFSET))
    fi
fi

# Fallback: before daemon_node
if [ -z "$INSERT_LINE" ] || [ "$INSERT_LINE" -eq 0 ]; then
    INSERT_LINE=$(grep -n 'daemon_process daemon_node' "$RUN_SCRIPT" | head -1 | cut -d: -f1)
    if [ -n "$INSERT_LINE" ]; then
        INSERT_LINE=$((INSERT_LINE - 1))
    fi
fi

if [ -z "$INSERT_LINE" ] || [ "$INSERT_LINE" -eq 0 ]; then
    echo "ERROR: Could not find injection point in run_novabot.sh"
    rm -f /tmp/open_decision_hook_block.txt
    exit 1
fi

# Inject the block using sed
sed -i "${INSERT_LINE}r /tmp/open_decision_hook_block.txt" "$RUN_SCRIPT"
echo "Start hook injected at line $INSERT_LINE"

# Add Python kill to stop section (after the existing killall robot_decision)
# Use a unique match to only hit the stop section's killall (not the boot hook's)
STOP_KILLALL=$(grep -n 'killall -q -9 robot_decision$' "$RUN_SCRIPT" | tail -1 | cut -d: -f1)
if [ -n "$STOP_KILLALL" ]; then
    sed -i "${STOP_KILLALL}a\\  pkill -9 -f \"python3.*robot_decision\" 2>/dev/null" "$RUN_SCRIPT"
    echo "Stop kill added after line $STOP_KILLALL"
else
    echo "WARNING: Could not find stop section killall — manual cleanup needed"
fi

rm -f /tmp/open_decision_hook_block.txt
echo "Boot hook installed successfully"
