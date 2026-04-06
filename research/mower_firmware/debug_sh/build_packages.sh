for i in "$@"; do
    echo $i
    cd /root/novabot
    varb=$(basename $i)
    colcon build --cmake-args -DCMAKE_BUILD_TYPE=Release --parallel-workers 12 --packages-select ${varb} --allow-overriding ${varb}
done

