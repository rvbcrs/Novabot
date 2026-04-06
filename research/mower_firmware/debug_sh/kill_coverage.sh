 killall -q -9 coverage_planner_server
 kill -2 $(ps aux | grep  coverage_planner_server.launch.py | tr -s ' '| cut -d ' ' -f 2)
