#!/usr/bin/env python3
"""Laat map_server map.pgm opnieuw inlezen.

map_server leest de kaart exact één keer: bij het opstarten. Daarna herschrijft
map_generator.cpp map.pgm nog tientallen keren per maaibeurt en zetten wij de
unicom-kanalen erin open, maar nav2 blijft plannen op de kaart van toen de node
startte. Live gemeten op LFIN2230700238 (2026-09-14): map.pgm was op schijf over
0,55 m in elke richting vrij op (3.18, 4.23), /map gaf daar `0` (vrij), en de
global costmap gaf op datzelfde punt `254` (lethal) met als gevolg
GOAL_COLLIDED. Het verschil was leeftijd: de navigator draaide sinds 15:43, de
kaart was om 16:58 aangepast.

De global costmap staat tussen taken in op `unconfigured` en bouwt zichzelf pas
bij de volgende navigatie op. Hij pakt dan de gelatchte /map van map_server, dus
map_server bijwerken is genoeg; de costmap zelf hoeft niets te doen.

Losse proces met opzet: rclpy in de seam-fix daemon zou die permanent een
iceoryx-deelnemer maken, en die chunks komen pas vrij bij procesexit.
"""
import os
import sys

DEFAULT_YAML = "/userdata/lfi/maps/home0/map.yaml"
TIMEOUT_S = 20.0

# run_novabot.sh zet deze twee alleen rond het starten van de nodes en haalt ze
# daarna weer weg (regel 74-75), dus een daemon die later start erft ze niet.
# Zonder RMW_IMPLEMENTATION praat dit proces tegen een andere DDS dan de
# firmware en komt de service-call nooit aan; zonder CYCLONEDDS_URI mist het de
# shared-memory configuratie. Zelf zetten is betrouwbaarder dan hopen dat de
# aanroeper het goed doet.
os.environ.setdefault("RMW_IMPLEMENTATION", "rmw_cyclonedds_cpp")
os.environ.setdefault("CYCLONEDDS_URI",
                      "file:///root/novabot/shm_config/shm_cyclonedds.xml")
os.environ.setdefault("ROS_LOCALHOST_ONLY", "1")


def main(argv):
    map_yaml = argv[1] if len(argv) > 1 else DEFAULT_YAML

    import rclpy
    from rclpy.node import Node
    from nav2_msgs.srv import LoadMap

    rclpy.init()
    node = Node("reload_nav_map")
    try:
        cli = node.create_client(LoadMap, "/map_server/load_map")
        if not cli.wait_for_service(timeout_sec=TIMEOUT_S):
            print("reload_nav_map: map_server niet bereikbaar", flush=True)
            return 2
        req = LoadMap.Request()
        req.map_url = map_yaml
        fut = cli.call_async(req)
        rclpy.spin_until_future_complete(node, fut, timeout_sec=TIMEOUT_S)
        res = fut.result()
        if res is None:
            print("reload_nav_map: geen antwoord", flush=True)
            return 3
        print("reload_nav_map: %s result=%d" % (map_yaml, res.result), flush=True)
        return 0 if res.result == 0 else 4
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
