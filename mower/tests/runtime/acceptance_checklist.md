# Hardware acceptance — open robot_decision

Run with mower on charger, working zone clear, dry conditions.
**REQUIRED — get user confirmation BEFORE any movement step.**

1. **Boot parity**
   - Stop stock C++ binary: `pkill -f /root/novabot/install/.*/robot_decision`.
   - Start Python: `bash /userdata/open_decision/start.sh` (with ROS_LOCALHOST_ONLY=1).
   - Expect: `/robot_decision` + `/decision_assistant` nodes; 18 services on robot_decision; 2 actions on decision_assistant.
   - **OPERATOR**: ensure clear space BEHIND the mower (≥ `quit_pile_distance` m, default 1.0 m) before proceeding — the open implementation now drives REVERSE during heading discovery via `free_move_around` (matching closed binary). If the `/nav2_single_node_navigator/free_move_around` service is unavailable the node falls back to forward+spin automatically (log line: "falling back to forward+spin").

2. **map_position publisher**
   - `ros2 topic hz /robot_decision/map_position` should report ~2 Hz.

3. **Coverage cov_mode 0 (full coverage)**
   - Trigger via app or `ros2 service call /robot_decision/start_cov_task ...`.
   - Confirm coverage starts; cancel after ~30s.

4. **Coverage cov_mode 2 (only edge)**
   - Verify coverage_planner_server logs "Only edge mode, only covering boundary path !!!!".
   - Cancel and dock back.

5. **Coverage cov_mode 1 (specified area)**
   - Send a polygon via the app (manual zone selection).
   - Verify mower stays inside the polygon.

6. **Slip auto-escalation**
   - Block one wheel briefly; expect SlipEscaping action goal observed in `ros2 action info`.

7. **Loc recover auto-escalation**
   - Cover GPS antenna with foil for ~10s; expect LocRecoverMoving goal.

8. **Battery hysteresis**
   - Use `ros2 topic pub /battery_message ...` (manual injection) to drop to 19%, then 21%, then 19% again. Recharge should fire ONCE.

9. **reset_data after fault**
   - Trigger a soft fault, then `ros2 service call /robot_decision/reset_data std_srvs/srv/SetBool '{data: true}'` and verify state returns to INIT_SUCCESS.
