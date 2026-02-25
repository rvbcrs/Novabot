kill -2 $(ps aux | grep teleop | tr -s ' '| cut -d ' ' -f 2)
