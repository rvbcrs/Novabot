# Fase 0 veldtest — kale volg-test (go/no-go voor route B)

**Doel:** meten hoe ver BoundaryFollow met lawn_edge_relay komt langs de
randtypes van het testgazon. Succescriterium (spec): ≥1 volledige ronde om
het testgazon zonder FOLLOW_FAILED. Structureel falen → route A.

## Voorbereiding (eenmalig, door Ramon gestart)
1. Custom firmware met auto-map-sectie op de testmaaier (build via
   ./research/build_custom_firmware.sh, flash via normale OTA-flow), OF
   handmatig voor een snelle iteratie:
   scp research/lawn_edge_relay.py research/auto_map_node.py \
       research/start_lawn_relay.sh research/start_auto_map.sh \
       root@192.168.0.100:/root/novabot/scripts/
2. Daemons starten (ROS-env verplicht, NOOIT kaal python3):
   ssh root@192.168.0.100 "(nohup /root/novabot/scripts/start_lawn_relay.sh \
       >> /userdata/lfi/log/lawn_edge_relay.log 2>&1 &)"
   ssh root@192.168.0.100 "(nohup /root/novabot/scripts/start_auto_map.sh \
       >> /userdata/lfi/log/auto_map_node.log 2>&1 &)"
3. Check relay: ros2 topic hz /perception/points_relabeled (verwacht ~5 Hz
   zodra perceptie draait).

## Testrit (maaier midden op het gras, NIET op de dock)
Start via MQTT (server of mosquitto_pub op de broker):
  topic:   novabot/extended/<SN>
  payload: {"start_auto_map_test": {"radiusM": 30, "timeoutS": 1200}}
Stop:      {"stop_auto_map": {}}
Status:    {"get_auto_map_status": {}}
Volg auto_map_status-events op novabot/extended_response/<SN>.

## Meetformulier (per poging invullen)
| # | Startpunt | Randtype bereikt | Afstand/duur | Result-code | Notities |
|---|-----------|------------------|--------------|-------------|----------|
Randtypes van het testgazon: heg, border, stoeprand, zandbak-overgang
(= maart-breekpunt), schutting.

## Uitkomst
- ≥1 volledige ronde zonder FOLLOW_FAILED → GO voor fase 1.
- Structureel FOLLOW_FAILED op hetzelfde randtype → log + laatste positie
  documenteren; beslissing route A (spec: gedocumenteerd vangnet).
