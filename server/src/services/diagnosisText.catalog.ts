/**
 * Diagnosis catalog — the sentences of connectionDiagnosis.ts in English.
 *
 * The key is the Dutch original with {0}, {1}, … where the values go. Numbered
 * rather than positional, so a translation may reorder them. Dutch needs no
 * entry: it is the key. A language with no entry falls back to English.
 *
 * diagnosisText.coverage.test.ts fails when a sentence in the service is
 * missing here, so this file cannot silently drift behind the code.
 */
import type { Catalog } from './diagnosisText.js';

export const CATALOG: Catalog = {
  // ── tijdsaanduiding ──────────────────────────────────────────────────
  '{0} s geleden': { en: '{0} s ago' },
  '{0} min geleden': { en: '{0} min ago' },
  '{0} uur geleden': { en: '{0} hours ago' },
  '{0} dagen geleden': { en: '{0} days ago' },

  // ── server ───────────────────────────────────────────────────────────
  '{0} MB vrij van {1} MB ({2}%)': { en: '{0} MB free of {1} MB ({2}%)' },
  'kaartuploads en de database hebben ruimte nodig; maak schijfruimte vrij': {
    en: 'map uploads and the database need room; free up disk space',
  },
  'schijfruimte niet op te vragen': { en: 'cannot read the disk space' },
  'niet gepeild': { en: 'not probed' },
  'nog {0} andere MQTT-broker(s) op dit netwerk: {1}': {
    en: '{0} other MQTT broker(s) on this network: {1}',
  },
  'geen tweede MQTT-broker op dit netwerk': { en: 'no second MQTT broker on this network' },
  'maaiers ontdekken via mDNS de verkeerde en springen heen en weer; zet er één uit': {
    en: 'mowers discover the wrong one over mDNS and bounce between them; switch one off',
  },
  'deze machine': { en: 'this machine' },
  'draait rechtstreeks op {0}': { en: 'running directly on {0}' },
  'container met bridge-netwerk ({0})': { en: 'container on bridge networking ({0})' },
  'container met host-netwerk ({0})': { en: 'container on host networking ({0})' },

  // ── mDNS op 5353 ─────────────────────────────────────────────────────
  'mDNS is uitgezet (ENABLE_MDNS)': { en: 'mDNS is switched off (ENABLE_MDNS)' },
  'maaiers kunnen deze server dan niet zelf vinden en hebben je DNS-omleiding nodig; zet ENABLE_MDNS niet op false als je automatisch ontdekken wilt': {
    en: 'mowers cannot then find this server by themselves and depend on your DNS redirect; leave ENABLE_MDNS on if you want automatic discovery',
  },
  'de advertiser is niet gestart: geen LAN-adres bekend': {
    en: 'the advertiser did not start: no LAN address known',
  },
  'zet TARGET_IP op het adres van deze server op je thuisnetwerk, binnen een container is dat niet zelf te bepalen': {
    en: "set TARGET_IP to this server's address on your home network; inside a container it cannot work that out for itself",
  },
  'de advertiser draait niet: {0}': { en: 'the advertiser is not running: {0}' },
  'de advertiser draait niet': { en: 'the advertiser is not running' },
  'herstart de server en kijk in het log naar [MDNS]': {
    en: 'restart the server and look for [MDNS] in the log',
  },
  'poort {0} geeft een fout: {1}': { en: 'port {0} reports an error: {1}' },
  'iets anders heeft 5353 al, meestal avahi op de host bij host-netwerk; stop dat of zet MDNS_PORT anders (de maaiers verwachten wel 5353)': {
    en: 'something else already holds 5353, usually avahi on the host when using host networking; stop it or move MDNS_PORT (mowers do expect 5353)',
  },
  'de container mag geen multicast versturen; geef hem host-netwerk of de juiste rechten': {
    en: 'the container is not allowed to send multicast; give it host networking or the right permissions',
  },
  'kijk in het serverlog naar [MDNS] voor de volledige fout': {
    en: 'look for [MDNS] in the server log for the full error',
  },
  '{0} wordt óók beantwoord door {1}': { en: '{0} is also answered by {1}' },
  'twee servers claimen dezelfde naam en maaiers kiezen willekeurig; zet de andere uit of geef hem ENABLE_MDNS=false': {
    en: 'two servers claim the same name and mowers pick at random; switch the other one off or give it ENABLE_MDNS=false',
  },
  '{0} wordt op 5353 beantwoord met {1}': { en: '{0} is answered on 5353 with {1}' },
  '{0} wordt op 224.0.0.251:5353 door niemand beantwoord, ook niet door deze server zelf': {
    en: 'nobody answers {0} on 224.0.0.251:5353, not even this server itself',
  },
  'multicast komt de container niet in of uit; zet "5353:5353/udp" in de compose-ports of draai met network_mode: host': {
    en: 'multicast does not reach in or out of the container; add "5353:5353/udp" to the compose ports or run with network_mode: host',
  },
  'controleer of een firewall multicast op 224.0.0.251 blokkeert': {
    en: 'check whether a firewall is blocking multicast on 224.0.0.251',
  },

  // ── bereikbaarheid: DNS ──────────────────────────────────────────────
  '{0} lost hier niet op': { en: '{0} does not resolve here' },
  '{0} lost op naar {1}; deze server draait in een container en kent zijn eigen adres op het thuisnetwerk niet, dus daar valt niets uit af te leiden': {
    en: '{0} resolves to {1}; this server runs in a container and does not know its own address on the home network, so nothing follows from that',
  },
  '{0} wijst naar deze server ({1})': { en: '{0} points at this server ({1})' },
  'deze server serveert de omleiding, maar {0} wijst naar {1} en niet naar {2}': {
    en: 'this server serves the redirect, but {0} points at {1} and not at {2}',
  },
  'zet de omleiding op het huidige serveradres; dit adres is waarschijnlijk veranderd sinds de installatie': {
    en: 'point the redirect at the current server address; it has probably changed since installation',
  },
  '{0} lost hier op naar {1}. Deze server serveert de omleiding niet, dus dit zegt alleen iets als je apparaten dezelfde DNS gebruiken als deze container': {
    en: '{0} resolves here to {1}. This server does not serve the redirect, so this only means something if your devices use the same DNS as this container',
  },

  // ── bereikbaarheid: netwerk ──────────────────────────────────────────
  'geen adres van dit apparaat bekend, dus niet te peilen': {
    en: 'no address known for this device, so nothing to probe',
  },
  'geen adres bekend en {0}': { en: 'no address known and {0}' },
  'draai de container met host-netwerk om het lokale netwerk te kunnen inzien': {
    en: 'run the container with host networking so it can see the local network',
  },
  'geen enkel LFI-apparaat gevonden op {0}.0/24 ({1} apparaten bekeken)': {
    en: 'no LFI device found on {0}.0/24 ({1} devices examined)',
  },
  'het apparaat hangt niet aan dit netwerk: controleer de stroom en of de wifi-gegevens goed zijn doorgegeven': {
    en: 'the device is not on this network: check the power and whether the wifi details were passed on correctly',
  },
  'gevonden op {0} (MAC {1}), maar hij praat geen MQTT met ons': {
    en: 'found at {0} (MAC {1}), but it speaks no MQTT to us',
  },
  'hij hangt aan het netwerk, dus het probleem zit in de serverinstelling van het apparaat: naar welk adres wijst het': {
    en: "it is on the network, so the problem is in the device's server setting: which address does it point at",
  },
  '{0} laadstation(s) op het netwerk ({1}), maar niet deze': {
    en: '{0} charging station(s) on the network ({1}), but not this one',
  },
  '{0} maaier(s) op het netwerk ({1}), maar niet deze': {
    en: '{0} mower(s) on the network ({1}), but not this one',
  },
  'controleer of het serienummer klopt, of dit apparaat staat uit': {
    en: 'check that the serial number is right, or this device is switched off',
  },
  'wel {0} LFI-apparaat(en) gezien, geen ervan is een laadstation': {
    en: '{0} LFI device(s) seen, none of them a charging station',
  },
  'wel {0} LFI-apparaat(en) gezien, geen ervan is een maaier': {
    en: '{0} LFI device(s) seen, none of them a mower',
  },
  'dit apparaat hangt niet aan het netwerk': { en: 'this device is not on the network' },
  '{0} antwoordt, het apparaat staat aan en zit op het netwerk': {
    en: '{0} answers, the device is on and connected to the network',
  },
  '{0} antwoordt niet op poort 22 of 8000; op stock firmware staan die dicht, dus dit bewijst niets': {
    en: '{0} does not answer on port 22 or 8000; stock firmware keeps those closed, so this proves nothing',
  },
  'laatst bekende adres {0} zit in een ander subnet dan deze server ({1})': {
    en: 'last known address {0} is in a different subnet from this server ({1})',
  },
  'zet beide in hetzelfde netwerk, of laat het verkeer ertussen door': {
    en: 'put both on the same network, or allow the traffic between them',
  },

  // ── bereikbaarheid: wifi ─────────────────────────────────────────────
  'geen adres bekend': { en: 'no address known' },
  'verbonden via wifi op {0}': { en: 'connected over wifi at {0}' },
  'MAC {0}': { en: 'MAC {0}' },
  'MAC {0} (afgeleid uit de BLE-MAC {1})': { en: 'MAC {0} (derived from BLE MAC {1})' },
  'signaal {0} dBm': { en: 'signal {0} dBm' },
  ' (MAC nergens bekend)': { en: ' (MAC not known anywhere)' },
  'zwak signaal, de verbinding valt daar met regelmaat van weg; zet een toegangspunt dichterbij': {
    en: 'weak signal, the connection drops regularly at this level; move an access point closer',
  },

  // ── verbinding ───────────────────────────────────────────────────────
  '{0} heeft zich nog nooit bij deze server gemeld': {
    en: '{0} has never reported to this server',
  },
  'het apparaat is nog niet ingericht of wijst naar een andere server: controleer wifi, de BLE-provisioning en of mqtt.lfibot.com naar dit adres verwijst': {
    en: 'the device is not set up yet or points at another server: check wifi, the BLE provisioning, and whether mqtt.lfibot.com points at this address',
  },
  'laatst gezien {0} als {1}': { en: 'last seen {0} as {1}' },
  'was verbonden, maar laatst gezien {0}': { en: 'was connected, but last seen {0}' },
  'hij wérkte eerder, dus zoek wat er rond dat moment veranderde: stroom, wifi, DNS of een serverherstart': {
    en: 'it did work before, so look for what changed around that moment: power, wifi, DNS, or a server restart',
  },
  'niet nodig, hij is binnen': { en: 'not needed, it is connected' },
  'laatste poging {0} geweigerd: {1}': { en: 'last attempt {0} refused: {1}' },
  'dit serienummer staat geblokkeerd na een "verwijder en verban": koppel het apparaat opnieuw via de app': {
    en: 'this serial number is banned after a "remove and ban": pair the device again through the app',
  },
  'het apparaat bereikt de server wel maar komt niet door: controleer de inloggegevens en het serienummer': {
    en: 'the device does reach the server but is not let in: check the credentials and the serial number',
  },
  'geen enkele verbindingspoging geregistreerd in de laatste 24 uur': {
    en: 'no connection attempt recorded in the last 24 hours',
  },
  'er komt niets binnen, dus het probleem zit vóór de broker: netwerk, DNS of het apparaat staat uit': {
    en: 'nothing arrives, so the problem is upstream of the broker: network, DNS, or the device is off',
  },
  'client_id {0} komt van {1}': { en: 'client_id {0} comes from {1}' },
  'twee apparaten of processen gebruiken hetzelfde client_id en gooien elkaar er om beurten uit; zet er één uit': {
    en: 'two devices or processes use the same client_id and keep kicking each other off; switch one off',
  },
  'geen dubbel gebruikt client_id gezien': { en: 'no client_id seen in use twice' },
  'hij is niet verbonden': { en: 'it is not connected' },
  'verbonden, maar er is geen enkele meetwaarde binnengekomen': {
    en: 'connected, but not a single reading has come in',
  },
  'de berichten zijn niet te ontcijferen of hebben een ander formaat; controleer of het serienummer klopt, daar wordt de sleutel uit afgeleid': {
    en: 'the messages cannot be decrypted or have another format; check that the serial number is right, the key is derived from it',
  },
  '{0} meetwaarden ontvangen': { en: '{0} readings received' },

  // ── identiteit ───────────────────────────────────────────────────────
  'geen koppeling in equipment': { en: 'no pairing in equipment' },
  'koppel het apparaat via de app, dat schrijft de equipment-rij': {
    en: 'pair the device through the app, that writes the equipment row',
  },
  'gekoppeld maar zonder gebruiker (user_id leeg)': {
    en: 'paired but without a user (user_id empty)',
  },
  'de app doet dan BLE-provisioning; rond die stap af in de app': {
    en: 'the app then does BLE provisioning; finish that step in the app',
  },
  'gekoppeld aan {0}': { en: 'paired with {0}' },
  'geen BLE MAC bekend bij de koppeling': { en: 'no BLE MAC known for the pairing' },
  'zonder MAC herkent de app de maaier niet in een BLE-scan': {
    en: 'without a MAC the app will not recognise the mower in a BLE scan',
  },
  'de opgeslagen MAC {0} is die van een laadstation, niet van de maaier': {
    en: "the stored MAC {0} belongs to a charging station, not to the mower",
  },
  'laat de MAC opnieuw afleiden uit device_factory': {
    en: 'have the MAC derived again from device_factory',
  },
  'MAC {0} wijkt af van de fabriekswaarde {1}': {
    en: 'MAC {0} differs from the factory value {1}',
  },
  'BLE MAC {0}': { en: 'BLE MAC {0}' },
  'alleen van toepassing op een maaier': { en: 'only applies to a mower' },

  // ── lader en LoRa ────────────────────────────────────────────────────
  'geen laadstation gekoppeld': { en: 'no charging station paired' },
  'geen maaier gekoppeld': { en: 'no mower paired' },
  'zonder laadstation is er geen RTK-correctie en dus geen nauwkeurige positie': {
    en: 'without a charging station there is no RTK correction and so no accurate position',
  },
  '{0} heeft zich nog nooit gemeld': { en: '{0} has never reported in' },
  'richt ook het laadstation in; het heeft een eigen wifi- en MQTT-verbinding': {
    en: 'set up the charging station as well; it has its own wifi and MQTT connection',
  },
  '{0} laatst gezien {1}': { en: '{0} last seen {1}' },
  'controleer de stroom en het wifi-bereik van het laadstation': {
    en: "check the charging station's power and wifi range",
  },
  '{0} gezien {1}': { en: '{0} seen {1}' },
  'geen lader gekoppeld': { en: 'no charger paired' },
  'laderversie onbekend': { en: 'charger version unknown' },
  'laderfirmware {0}, kent nog geen AES': { en: 'charger firmware {0}, does not know AES yet' },
  'laderfirmware {0}': { en: 'charger firmware {0}' },
  'de server versleutelt alles naar LFI-apparaten en deze lader kan dat niet lezen; werk hem bij naar v0.4.0': {
    en: 'the server encrypts everything it sends to LFI devices and this charger cannot read that; update it to v0.4.0',
  },
  'geen LoRa-paar om te controleren': { en: 'no LoRa pair to check' },
  'adres {0} kanaal {1} aan beide kanten gelijk': {
    en: 'address {0} channel {1}, identical on both sides',
  },
  'maaier {0}/{1} tegen lader {2}/{3}': { en: 'mower {0}/{1} against charger {2}/{3}' },
  'adres en kanaal moeten IDENTIEK zijn aan beide kanten; koppel opnieuw via de app': {
    en: 'address and channel must be IDENTICAL on both sides; pair again through the app',
  },
  'de LoRa-instellingen zijn nog niet van beide apparaten gelezen': {
    en: 'the LoRa settings have not been read from both devices yet',
  },

  // ── firmware ─────────────────────────────────────────────────────────
  'firmwareversie nog niet gemeld': { en: 'firmware version not reported yet' },
  '{0} (OpenNova)': { en: '{0} (OpenNova)' },
  '{0} (stock)': { en: '{0} (stock)' },
  '{0} werkzones op firmware die er maximaal 5 aankan': {
    en: '{0} work zones on firmware that handles at most 5',
  },
  'zones boven de vijfde eindigen in fout 125; werk de firmware bij naar custom-{0} of hoger': {
    en: 'zones beyond the fifth end in error 125; update the firmware to custom-{0} or higher',
  },

  // ── klaar om te maaien ───────────────────────────────────────────────
  '{0} werkgebied(en)': { en: '{0} work area(s)' },
  'geen enkel werkgebied bekend': { en: 'no work area known at all' },
  'karteer eerst een gebied, zonder kaart start er niets': {
    en: 'map an area first, nothing starts without a map',
  },
  'geen meetwaarden': { en: 'no readings' },
  'geen RTK-status gemeld': { en: 'no RTK status reported' },
  'RTK-status {0}, {1} satellieten': { en: 'RTK status {0}, {1} satellites' },
  'RTK-status {0}': { en: 'RTK status {0}' },
  'zonder RTK-fix is de positie te onnauwkeurig om te maaien; controleer het laadstation en of het zicht op de hemel heeft': {
    en: 'without an RTK fix the position is too imprecise to mow; check the charging station and whether it has a clear view of the sky',
  },
  'geen storing': { en: 'no fault' },
  'storing {0} actief': { en: 'fault {0} active' },
  'melding {0}, niet blokkerend': { en: 'notice {0}, not blocking' },
  'los de storing op of wis hem, anders start er geen taak': {
    en: 'clear or resolve the fault, otherwise no task will start',
  },
  'de maaier staat in karteermodus': { en: 'the mower is in mapping mode' },
  'niet in karteermodus': { en: 'not in mapping mode' },
  'in deze stand start geen maaitaak en kun je geen kaart verwijderen; sluit het karteren af': {
    en: 'in this mode no mowing task starts and no map can be deleted; finish the mapping session',
  },
  'een onderbroken maaibeurt staat geparkeerd (status {0})': {
    en: 'an interrupted mowing run is parked (status {0})',
  },
  'geen geparkeerde taak': { en: 'no parked task' },
  'de firmware weigert een nieuwe start zolang deze er staat; hervat hem of beëindig de sessie': {
    en: 'the firmware refuses a new start while this one stands; resume it or end the session',
  },
  'het kaartframe is nog niet gecontroleerd na een herstel': {
    en: 'the map frame has not been verified since a restore',
  },
  'kaartframe gecontroleerd': { en: 'map frame verified' },
  'anker de maaier opnieuw op het laadstation voor je gaat maaien': {
    en: 're-anchor the mower on the charging station before you mow',
  },

  // ── op de maaier zelf ────────────────────────────────────────────────
  'stock firmware heeft geen SSH, dus hier valt niets te lezen': {
    en: 'stock firmware has no SSH, so there is nothing to read here',
  },
  'kan niet inloggen op {0}: {1}': { en: 'cannot log in to {0}: {1}' },
  'zonder toegang tot de maaier zelf blijft de diagnose bij wat van buitenaf te zien is': {
    en: 'without access to the mower itself the diagnosis stops at what is visible from the outside',
  },
  'ingelogd op {0}': { en: 'logged in to {0}' },
  'mqtt_node draait niet': { en: 'mqtt_node is not running' },
  'zonder dit proces stuurt de maaier geen enkele status; herstart hem met set_server_urls.sh --restart-mqtt': {
    en: 'without this process the mower sends no status at all; restart it with set_server_urls.sh --restart-mqtt',
  },
  'mqtt_node draait al {0} uur maar heeft geen verbinding met de broker, {1} netwerkfouten in zijn log': {
    en: 'mqtt_node has been running for {0} hours with no connection to the broker, {1} network errors in its log',
  },
  'mqtt_node draait al {0} uur maar heeft geen verbinding met de broker': {
    en: 'mqtt_node has been running for {0} hours with no connection to the broker',
  },
  'mqtt_node draait maar heeft geen verbinding met de broker, {0} netwerkfouten in zijn log': {
    en: 'mqtt_node is running but has no connection to the broker, {0} network errors in its log',
  },
  'mqtt_node draait maar heeft geen verbinding met de broker': {
    en: 'mqtt_node is running but has no connection to the broker',
  },
  'hij is bij het opstarten blijven hangen en komt daar niet zelf uit; herstart hem met set_server_urls.sh --restart-mqtt': {
    en: 'it got stuck during boot and will not recover on its own; restart it with set_server_urls.sh --restart-mqtt',
  },
  'mqtt_node verbonden met de broker': { en: 'mqtt_node connected to the broker' },
  'json_config.json mist het serienummer': { en: 'json_config.json is missing the serial number' },
  'mqtt-adres in json_config.json: {0}': { en: 'MQTT address in json_config.json: {0}' },
  'zonder serienummer kan mqtt_node zich niet aanmelden': {
    en: 'without a serial number mqtt_node cannot announce itself',
  },
  'dit is het cloudadres; het werkt alleen zolang je DNS het omleidt naar je eigen server. Een IP is betrouwbaarder': {
    en: 'this is the cloud address; it only works while your DNS redirects it to your own server. An IP address is more reliable',
  },
  'de maaier vindt de server zelf via opennova.local': {
    en: 'the mower finds the server by itself over opennova.local',
  },
  'de maaier vindt opennova.local niet (server: {0})': {
    en: 'the mower cannot find opennova.local (server: {0})',
  },
  'hij leunt nu volledig op je DNS-omleiding. Automatisch ontdekken werkt niet omdat de container multicast niet naar het thuisnetwerk krijgt; host-netwerk of een mDNS-reflector lost dat op': {
    en: 'it now leans entirely on your DNS redirect. Automatic discovery does not work because the container cannot get multicast onto the home network; host networking or an mDNS reflector solves that',
  },
  'hij leunt nu volledig op je DNS-omleiding. Automatisch ontdekken werkt pas als de server zich op het netwerk adverteert': {
    en: 'it now leans entirely on your DNS redirect. Automatic discovery only works once the server advertises itself on the network',
  },
  'set_server_urls sloeg de config-update over, opennova.local lost op de maaier niet op': {
    en: 'set_server_urls skipped the config update, opennova.local does not resolve on the mower',
  },
  'set_server_urls sloeg de config-update over, opennova.local lost op de maaier niet op en /userdata/lfi/server_ip.txt bestaat niet': {
    en: 'set_server_urls skipped the config update, opennova.local does not resolve on the mower and /userdata/lfi/server_ip.txt does not exist',
  },
  'set_server_urls sloeg de config-update over': { en: 'set_server_urls skipped the config update' },
  'set_server_urls sloeg de config-update over en /userdata/lfi/server_ip.txt bestaat niet': {
    en: 'set_server_urls skipped the config update and /userdata/lfi/server_ip.txt does not exist',
  },
  'zet het serveradres in /userdata/lfi/server_ip.txt, dan vult het script json_config.json bij de volgende boot alsnog': {
    en: 'put the server address in /userdata/lfi/server_ip.txt, then the script will still fill in json_config.json on the next boot',
  },
  'laatst bekende server {0}': { en: 'last known server {0}' },
  'config-update liep door': { en: 'config update went through' },
  'extended_commands draait': { en: 'extended_commands is running' },
  'extended_commands draait niet': { en: 'extended_commands is not running' },
  "zonder dit script werken de OpenNova-commando's en de RTK-telemetrie niet": {
    en: 'without this script the OpenNova commands and the RTK telemetry do not work',
  },

  // ── samenvatting ─────────────────────────────────────────────────────
  'geen blokkade gevonden, alles staat goed': {
    en: 'no blockage found, everything is in order',
  },
  'geen blokkade gevonden, wel 1 aandachtspunt: {0}': {
    en: 'no blockage found, but 1 point of attention: {0}',
  },
  'geen blokkade gevonden, wel {0} aandachtspunten: {1}': {
    en: 'no blockage found, but {0} points of attention: {1}',
  },
};
