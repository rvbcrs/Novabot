# Runtime tests on the mower

Pure-logic tests run anywhere via `pytest`. ROS-runtime tests require the
mower because rclpy DDS discovery needs the live `chassis_node`,
`coverage_planner_server`, etc.

Each task that needs runtime verification provides a `ros2 ...` command. Run
it from an SSH session:

```bash
sshpass -p 'novabot' ssh root@<MOWER_IP>
ROS_LOCALHOST_ONLY=1 ros2 service list | grep robot_decision
```

`run_smoke.sh` collects the high-signal ones in a single pass.
