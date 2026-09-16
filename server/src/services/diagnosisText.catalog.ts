/**
 * Diagnosis catalog — the sentences of connectionDiagnosis.ts in English,
 * French and German.
 *
 * The key is the Dutch original with {0}, {1}, … where the values go. Numbered
 * rather than positional, so a translation may reorder them. Dutch needs no
 * entry: it is the key.
 *
 * diagnosisText.coverage.test.ts fails when a sentence in the service is
 * missing here, in any of the three languages, so this file cannot silently
 * drift behind the code.
 */
import type { Catalog } from './diagnosisText.js';

export const CATALOG: Catalog = {
  // ── tijdsaanduiding ─────────────────────────────────────────────────────
  "{0} s geleden": {
    en: "{0} s ago",
    fr: "il y a {0} s",
    de: "vor {0} s",
  },
  "{0} min geleden": {
    en: "{0} min ago",
    fr: "il y a {0} min",
    de: "vor {0} min",
  },
  "{0} uur geleden": {
    en: "{0} hours ago",
    fr: "il y a {0} heures",
    de: "vor {0} Stunden",
  },
  "{0} dagen geleden": {
    en: "{0} days ago",
    fr: "il y a {0} jours",
    de: "vor {0} Tagen",
  },

  // ── server ──────────────────────────────────────────────────────────────
  "{0} MB vrij van {1} MB ({2}%)": {
    en: "{0} MB free of {1} MB ({2}%)",
    fr: "{0} Mo libres sur {1} Mo ({2} %)",
    de: "{0} MB frei von {1} MB ({2} %)",
  },
  "kaartuploads en de database hebben ruimte nodig; maak schijfruimte vrij": {
    en: "map uploads and the database need room; free up disk space",
    fr: "les envois de cartes et la base de données ont besoin de place ; libérez de l'espace disque",
    de: "Karten-Uploads und die Datenbank brauchen Platz; geben Sie Speicherplatz frei",
  },
  "schijfruimte niet op te vragen": {
    en: "cannot read the disk space",
    fr: "impossible de lire l'espace disque",
    de: "Speicherplatz nicht auslesbar",
  },
  "niet gepeild": {
    en: "not probed",
    fr: "non sondé",
    de: "nicht geprüft",
  },
  "niet te peilen: geen adres van deze server op het thuisnetwerk bekend": {
    en: "cannot probe: no address of this server on the home network is known",
    fr: "impossible de sonder : aucune adresse de ce serveur sur le réseau domestique n'est connue",
    de: "nicht prüfbar: keine Adresse dieses Servers im Heimnetz bekannt",
  },
  "nog een OpenNova-server op dit netwerk: {0}": {
    en: "another OpenNova server on this network: {0}",
    fr: "un autre serveur OpenNova sur ce réseau : {0}",
    de: "ein weiterer OpenNova-Server in diesem Netzwerk: {0}",
  },
  "{0} andere MQTT-broker(s) op dit netwerk ({1}); geen ervan is OpenNova, ze concurreren niet om de maaiers": {
    en: "{0} other MQTT broker(s) on this network ({1}); none of them is OpenNova, they do not compete for the mowers",
    fr: "{0} autre(s) courtier(s) MQTT sur ce réseau ({1}) ; aucun n'est OpenNova, ils ne se disputent pas les tondeuses",
    de: "{0} weitere(r) MQTT-Broker in diesem Netzwerk ({1}); keiner davon ist OpenNova, sie konkurrieren nicht um die Mäher",
  },
  "twee OpenNova-servers claimen dezelfde maaiers via opennova.local en mqtt.lfibot.com; zet er één uit": {
    en: "two OpenNova servers claim the same mowers through opennova.local and mqtt.lfibot.com; switch one off",
    fr: "deux serveurs OpenNova revendiquent les mêmes tondeuses via opennova.local et mqtt.lfibot.com ; éteignez-en un",
    de: "zwei OpenNova-Server beanspruchen dieselben Mäher über opennova.local und mqtt.lfibot.com; schalten Sie einen aus",
  },
  "geen tweede MQTT-broker op dit netwerk": {
    en: "no second MQTT broker on this network",
    fr: "aucun second courtier MQTT sur ce réseau",
    de: "kein zweiter MQTT-Broker in diesem Netzwerk",
  },
  "deze machine": {
    en: "this machine",
    fr: "cette machine",
    de: "dieser Rechner",
  },
  "draait rechtstreeks op {0}": {
    en: "running directly on {0}",
    fr: "fonctionne directement sur {0}",
    de: "läuft direkt auf {0}",
  },
  "container met bridge-netwerk ({0})": {
    en: "container on bridge networking ({0})",
    fr: "conteneur en réseau bridge ({0})",
    de: "Container mit Bridge-Netzwerk ({0})",
  },
  "container met host-netwerk ({0})": {
    en: "container on host networking ({0})",
    fr: "conteneur en réseau host ({0})",
    de: "Container mit Host-Netzwerk ({0})",
  },

  // ── mDNS op 5353 ────────────────────────────────────────────────────────
  "mDNS is uitgezet (ENABLE_MDNS)": {
    en: "mDNS is switched off (ENABLE_MDNS)",
    fr: "mDNS est désactivé (ENABLE_MDNS)",
    de: "mDNS ist ausgeschaltet (ENABLE_MDNS)",
  },
  "maaiers kunnen deze server dan niet zelf vinden en hebben je DNS-omleiding nodig; zet ENABLE_MDNS niet op false als je automatisch ontdekken wilt": {
    en: "mowers cannot then find this server by themselves and depend on your DNS redirect; leave ENABLE_MDNS on if you want automatic discovery",
    fr: "les tondeuses ne peuvent alors pas trouver ce serveur elles-mêmes et dépendent de votre redirection DNS ; laissez ENABLE_MDNS activé si vous voulez la découverte automatique",
    de: "Mäher finden diesen Server dann nicht selbst und sind auf Ihre DNS-Umleitung angewiesen; lassen Sie ENABLE_MDNS an, wenn Sie automatische Erkennung wollen",
  },
  "de advertiser is niet gestart: geen LAN-adres bekend": {
    en: "the advertiser did not start: no LAN address known",
    fr: "l'annonceur n'a pas démarré : aucune adresse LAN connue",
    de: "der Advertiser ist nicht gestartet: keine LAN-Adresse bekannt",
  },
  "zet TARGET_IP op het adres van deze server op je thuisnetwerk, binnen een container is dat niet zelf te bepalen": {
    en: "set TARGET_IP to this server's address on your home network; inside a container it cannot work that out for itself",
    fr: "définissez TARGET_IP sur l'adresse de ce serveur dans votre réseau domestique ; dans un conteneur il ne peut pas la deviner",
    de: "setzen Sie TARGET_IP auf die Adresse dieses Servers im Heimnetz; in einem Container kann er sie nicht selbst ermitteln",
  },
  "de advertiser draait niet: {0}": {
    en: "the advertiser is not running: {0}",
    fr: "l'annonceur ne fonctionne pas : {0}",
    de: "der Advertiser läuft nicht: {0}",
  },
  "de advertiser draait niet": {
    en: "the advertiser is not running",
    fr: "l'annonceur ne fonctionne pas",
    de: "der Advertiser läuft nicht",
  },
  "herstart de server en kijk in het log naar [MDNS]": {
    en: "restart the server and look for [MDNS] in the log",
    fr: "redémarrez le serveur et cherchez [MDNS] dans le journal",
    de: "starten Sie den Server neu und suchen Sie im Log nach [MDNS]",
  },
  "poort {0} geeft een fout: {1}": {
    en: "port {0} reports an error: {1}",
    fr: "le port {0} signale une erreur : {1}",
    de: "Port {0} meldet einen Fehler: {1}",
  },
  "iets anders heeft 5353 al, meestal avahi op de host bij host-netwerk; stop dat of zet MDNS_PORT anders (de maaiers verwachten wel 5353)": {
    en: "something else already holds 5353, usually avahi on the host when using host networking; stop it or move MDNS_PORT (mowers do expect 5353)",
    fr: "autre chose occupe déjà 5353, généralement avahi sur l'hôte en réseau host ; arrêtez-le ou changez MDNS_PORT (les tondeuses attendent bien 5353)",
    de: "etwas anderes belegt bereits 5353, meist avahi auf dem Host bei Host-Netzwerk; stoppen Sie es oder ändern Sie MDNS_PORT (die Mäher erwarten aber 5353)",
  },
  "de container mag geen multicast versturen; geef hem host-netwerk of de juiste rechten": {
    en: "the container is not allowed to send multicast; give it host networking or the right permissions",
    fr: "le conteneur n'a pas le droit d'émettre en multicast ; donnez-lui le réseau host ou les droits nécessaires",
    de: "der Container darf kein Multicast senden; geben Sie ihm Host-Netzwerk oder die nötigen Rechte",
  },
  "kijk in het serverlog naar [MDNS] voor de volledige fout": {
    en: "look for [MDNS] in the server log for the full error",
    fr: "cherchez [MDNS] dans le journal du serveur pour l'erreur complète",
    de: "suchen Sie im Server-Log nach [MDNS] für den vollständigen Fehler",
  },
  "{0} wordt óók beantwoord door {1}": {
    en: "{0} is also answered by {1}",
    fr: "{0} reçoit aussi une réponse de {1}",
    de: "{0} wird auch von {1} beantwortet",
  },
  "twee servers claimen dezelfde naam en maaiers kiezen willekeurig; zet de andere uit of geef hem ENABLE_MDNS=false": {
    en: "two servers claim the same name and mowers pick at random; switch the other one off or give it ENABLE_MDNS=false",
    fr: "deux serveurs revendiquent le même nom et les tondeuses choisissent au hasard ; éteignez l'autre ou mettez-lui ENABLE_MDNS=false",
    de: "zwei Server beanspruchen denselben Namen und Mäher wählen zufällig; schalten Sie den anderen aus oder geben Sie ihm ENABLE_MDNS=false",
  },
  "{0} wordt op 5353 beantwoord met {1}": {
    en: "{0} is answered on 5353 with {1}",
    fr: "{0} reçoit sur 5353 la réponse {1}",
    de: "{0} wird auf 5353 mit {1} beantwortet",
  },
  "{0} wordt op 224.0.0.251:5353 door niemand beantwoord, ook niet door deze server zelf": {
    en: "nobody answers {0} on 224.0.0.251:5353, not even this server itself",
    fr: "personne ne répond à {0} sur 224.0.0.251:5353, pas même ce serveur",
    de: "niemand beantwortet {0} auf 224.0.0.251:5353, auch dieser Server nicht",
  },
  "multicast komt de container niet in of uit; zet \"5353:5353/udp\" in de compose-ports of draai met network_mode: host": {
    en: "multicast does not reach in or out of the container; add \"5353:5353/udp\" to the compose ports or run with network_mode: host",
    fr: "le multicast n'entre ni ne sort du conteneur ; ajoutez « 5353:5353/udp » aux ports compose ou lancez avec network_mode: host",
    de: "Multicast kommt weder in den Container hinein noch heraus; tragen Sie \"5353:5353/udp\" in die Compose-Ports ein oder starten Sie mit network_mode: host",
  },
  "controleer of een firewall multicast op 224.0.0.251 blokkeert": {
    en: "check whether a firewall is blocking multicast on 224.0.0.251",
    fr: "vérifiez qu'un pare-feu ne bloque pas le multicast sur 224.0.0.251",
    de: "prüfen Sie, ob eine Firewall Multicast auf 224.0.0.251 blockiert",
  },

  // ── bereikbaarheid: DNS ─────────────────────────────────────────────────
  "{0} lost hier niet op": {
    en: "{0} does not resolve here",
    fr: "{0} ne se résout pas ici",
    de: "{0} lässt sich hier nicht auflösen",
  },
  "{0} lost op naar {1}; deze server draait in een container en kent zijn eigen adres op het thuisnetwerk niet, dus daar valt niets uit af te leiden": {
    en: "{0} resolves to {1}; this server runs in a container and does not know its own address on the home network, so nothing follows from that",
    fr: "{0} se résout en {1} ; ce serveur tourne dans un conteneur et ne connaît pas sa propre adresse sur le réseau domestique, on ne peut donc rien en conclure",
    de: "{0} löst sich zu {1} auf; dieser Server läuft in einem Container und kennt seine eigene Adresse im Heimnetz nicht, daraus folgt also nichts",
  },
  "{0} wijst naar deze server ({1})": {
    en: "{0} points at this server ({1})",
    fr: "{0} pointe vers ce serveur ({1})",
    de: "{0} zeigt auf diesen Server ({1})",
  },
  "deze server serveert de omleiding, maar {0} wijst naar {1} en niet naar {2}": {
    en: "this server serves the redirect, but {0} points at {1} and not at {2}",
    fr: "ce serveur sert la redirection, mais {0} pointe vers {1} et non vers {2}",
    de: "dieser Server liefert die Umleitung, aber {0} zeigt auf {1} und nicht auf {2}",
  },
  "zet de omleiding op het huidige serveradres; dit adres is waarschijnlijk veranderd sinds de installatie": {
    en: "point the redirect at the current server address; it has probably changed since installation",
    fr: "faites pointer la redirection vers l'adresse actuelle du serveur ; elle a probablement changé depuis l'installation",
    de: "richten Sie die Umleitung auf die aktuelle Serveradresse; sie hat sich seit der Installation vermutlich geändert",
  },
  "{0} lost hier op naar {1}. Deze server serveert de omleiding niet, dus dit zegt alleen iets als je apparaten dezelfde DNS gebruiken als deze container": {
    en: "{0} resolves here to {1}. This server does not serve the redirect, so this only means something if your devices use the same DNS as this container",
    fr: "ici {0} se résout en {1}. Ce serveur ne sert pas la redirection, cela n'a donc de sens que si vos appareils utilisent le même DNS que ce conteneur",
    de: "{0} löst sich hier zu {1} auf. Dieser Server liefert die Umleitung nicht, das sagt also nur etwas aus, wenn Ihre Geräte denselben DNS nutzen wie dieser Container",
  },

  // ── bereikbaarheid: netwerk ─────────────────────────────────────────────
  "geen adres van dit apparaat bekend, dus niet te peilen": {
    en: "no address known for this device, so nothing to probe",
    fr: "aucune adresse connue pour cet appareil, rien à sonder",
    de: "keine Adresse dieses Geräts bekannt, also nichts zu prüfen",
  },
  "geen adres bekend en {0}": {
    en: "no address known and {0}",
    fr: "aucune adresse connue et {0}",
    de: "keine Adresse bekannt und {0}",
  },
  "draai de container met host-netwerk om het lokale netwerk te kunnen inzien": {
    en: "run the container with host networking so it can see the local network",
    fr: "lancez le conteneur en réseau host pour qu'il voie le réseau local",
    de: "starten Sie den Container mit Host-Netzwerk, damit er das lokale Netzwerk sieht",
  },
  "geen enkel LFI-apparaat gevonden op {0}.0/24 ({1} apparaten bekeken)": {
    en: "no LFI device found on {0}.0/24 ({1} devices examined)",
    fr: "aucun appareil LFI trouvé sur {0}.0/24 ({1} appareils examinés)",
    de: "kein LFI-Gerät auf {0}.0/24 gefunden ({1} Geräte geprüft)",
  },
  "het apparaat hangt niet aan dit netwerk: controleer de stroom en of de wifi-gegevens goed zijn doorgegeven": {
    en: "the device is not on this network: check the power and whether the wifi details were passed on correctly",
    fr: "l'appareil n'est pas sur ce réseau : vérifiez l'alimentation et que les identifiants wifi ont bien été transmis",
    de: "das Gerät hängt nicht an diesem Netzwerk: prüfen Sie den Strom und ob die WLAN-Daten richtig übergeben wurden",
  },
  "gevonden op {0} (MAC {1}), maar hij praat geen MQTT met ons": {
    en: "found at {0} (MAC {1}), but it speaks no MQTT to us",
    fr: "trouvé sur {0} (MAC {1}), mais il ne parle pas MQTT avec nous",
    de: "auf {0} gefunden (MAC {1}), spricht aber kein MQTT mit uns",
  },
  "hij hangt aan het netwerk, dus het probleem zit in de serverinstelling van het apparaat: naar welk adres wijst het": {
    en: "it is on the network, so the problem is in the device's server setting: which address does it point at",
    fr: "il est sur le réseau, le problème est donc dans le réglage serveur de l'appareil : vers quelle adresse pointe-t-il",
    de: "es hängt am Netzwerk, das Problem liegt also in der Server-Einstellung des Geräts: auf welche Adresse zeigt es",
  },
  "{0} laadstation(s) op het netwerk ({1}), maar niet deze": {
    en: "{0} charging station(s) on the network ({1}), but not this one",
    fr: "{0} station(s) de charge sur le réseau ({1}), mais pas celle-ci",
    de: "{0} Ladestation(en) im Netzwerk ({1}), aber nicht diese",
  },
  "{0} maaier(s) op het netwerk ({1}), maar niet deze": {
    en: "{0} mower(s) on the network ({1}), but not this one",
    fr: "{0} tondeuse(s) sur le réseau ({1}), mais pas celle-ci",
    de: "{0} Mäher im Netzwerk ({1}), aber nicht dieser",
  },
  "controleer of het serienummer klopt, of dit apparaat staat uit": {
    en: "check that the serial number is right, or this device is switched off",
    fr: "vérifiez que le numéro de série est correct, ou cet appareil est éteint",
    de: "prüfen Sie, ob die Seriennummer stimmt, oder dieses Gerät ist aus",
  },
  "wel {0} LFI-apparaat(en) gezien, geen ervan is een laadstation": {
    en: "{0} LFI device(s) seen, none of them a charging station",
    fr: "{0} appareil(s) LFI vus, aucun n'est une station de charge",
    de: "{0} LFI-Gerät(e) gesehen, keines davon ist eine Ladestation",
  },
  "wel {0} LFI-apparaat(en) gezien, geen ervan is een maaier": {
    en: "{0} LFI device(s) seen, none of them a mower",
    fr: "{0} appareil(s) LFI vus, aucun n'est une tondeuse",
    de: "{0} LFI-Gerät(e) gesehen, keines davon ist ein Mäher",
  },
  "dit apparaat hangt niet aan het netwerk": {
    en: "this device is not on the network",
    fr: "cet appareil n'est pas sur le réseau",
    de: "dieses Gerät hängt nicht am Netzwerk",
  },
  "{0} antwoordt, het apparaat staat aan en zit op het netwerk": {
    en: "{0} answers, the device is on and connected to the network",
    fr: "{0} répond, l'appareil est allumé et connecté au réseau",
    de: "{0} antwortet, das Gerät ist an und im Netzwerk",
  },
  "{0} antwoordt niet op poort 22 of 8000; op stock firmware staan die dicht, dus dit bewijst niets": {
    en: "{0} does not answer on port 22 or 8000; stock firmware keeps those closed, so this proves nothing",
    fr: "{0} ne répond ni sur le port 22 ni sur 8000 ; sur le firmware d'origine ils sont fermés, cela ne prouve donc rien",
    de: "{0} antwortet nicht auf Port 22 oder 8000; bei Werks-Firmware sind die zu, das beweist also nichts",
  },
  "laatst bekende adres {0} zit in een ander subnet dan deze server ({1})": {
    en: "last known address {0} is in a different subnet from this server ({1})",
    fr: "la dernière adresse connue {0} est dans un autre sous-réseau que ce serveur ({1})",
    de: "die zuletzt bekannte Adresse {0} liegt in einem anderen Subnetz als dieser Server ({1})",
  },
  "zet beide in hetzelfde netwerk, of laat het verkeer ertussen door": {
    en: "put both on the same network, or allow the traffic between them",
    fr: "mettez les deux sur le même réseau, ou laissez passer le trafic entre eux",
    de: "bringen Sie beide ins selbe Netzwerk oder lassen Sie den Verkehr dazwischen durch",
  },

  // ── bereikbaarheid: wifi ────────────────────────────────────────────────
  "geen adres bekend": {
    en: "no address known",
    fr: "aucune adresse connue",
    de: "keine Adresse bekannt",
  },
  "verbonden via wifi op {0}": {
    en: "connected over wifi at {0}",
    fr: "connecté en wifi sur {0}",
    de: "per WLAN verbunden auf {0}",
  },
  "MAC {0}": {
    en: "MAC {0}",
    fr: "MAC {0}",
    de: "MAC {0}",
  },
  "MAC {0} (afgeleid uit de BLE-MAC {1})": {
    en: "MAC {0} (derived from BLE MAC {1})",
    fr: "MAC {0} (dérivée de la MAC BLE {1})",
    de: "MAC {0} (abgeleitet aus der BLE-MAC {1})",
  },
  "signaal {0}%": {
    en: "signal {0}%",
    fr: "signal {0}%",
    de: "Signal {0}%",
  },
  " (MAC nergens bekend)": {
    en: " (MAC not known anywhere)",
    fr: " (MAC inconnue partout)",
    de: " (MAC nirgends bekannt)",
  },
  "zwak signaal, de verbinding valt daar met regelmaat van weg; zet een toegangspunt dichterbij": {
    en: "weak signal, the connection drops regularly at this level; move an access point closer",
    fr: "signal faible, la connexion tombe régulièrement à ce niveau ; rapprochez un point d'accès",
    de: "schwaches Signal, die Verbindung bricht auf diesem Niveau regelmäßig ab; stellen Sie einen Zugangspunkt näher",
  },

  // ── verbinding ──────────────────────────────────────────────────────────
  "{0} heeft zich nog nooit bij deze server gemeld": {
    en: "{0} has never reported to this server",
    fr: "{0} ne s'est jamais annoncé auprès de ce serveur",
    de: "{0} hat sich bei diesem Server noch nie gemeldet",
  },
  "het apparaat is nog niet ingericht of wijst naar een andere server: controleer wifi, de BLE-provisioning en of mqtt.lfibot.com naar dit adres verwijst": {
    en: "the device is not set up yet or points at another server: check wifi, the BLE provisioning, and whether mqtt.lfibot.com points at this address",
    fr: "l'appareil n'est pas encore configuré ou pointe vers un autre serveur : vérifiez le wifi, le provisionnement BLE et que mqtt.lfibot.com pointe vers cette adresse",
    de: "das Gerät ist noch nicht eingerichtet oder zeigt auf einen anderen Server: prüfen Sie WLAN, die BLE-Einrichtung und ob mqtt.lfibot.com auf diese Adresse zeigt",
  },
  "laatst gezien {0} als {1}": {
    en: "last seen {0} as {1}",
    fr: "vu pour la dernière fois {0} en tant que {1}",
    de: "zuletzt gesehen {0} als {1}",
  },
  "was verbonden, maar laatst gezien {0}": {
    en: "was connected, but last seen {0}",
    fr: "était connecté, mais vu pour la dernière fois {0}",
    de: "war verbunden, aber zuletzt gesehen {0}",
  },
  "hij wérkte eerder, dus zoek wat er rond dat moment veranderde: stroom, wifi, DNS of een serverherstart": {
    en: "it did work before, so look for what changed around that moment: power, wifi, DNS, or a server restart",
    fr: "il fonctionnait avant, cherchez donc ce qui a changé à ce moment-là : alimentation, wifi, DNS ou un redémarrage du serveur",
    de: "er hat vorher funktioniert, suchen Sie also, was sich um diesen Zeitpunkt geändert hat: Strom, WLAN, DNS oder ein Server-Neustart",
  },
  "niet nodig, hij is binnen": {
    en: "not needed, it is connected",
    fr: "pas nécessaire, il est connecté",
    de: "nicht nötig, er ist verbunden",
  },
  "laatste poging {0} geweigerd: {1}": {
    en: "last attempt {0} refused: {1}",
    fr: "dernière tentative {0} refusée : {1}",
    de: "letzter Versuch {0} abgelehnt: {1}",
  },
  "dit serienummer staat geblokkeerd na een \"verwijder en verban\": koppel het apparaat opnieuw via de app": {
    en: "this serial number is banned after a \"remove and ban\": pair the device again through the app",
    fr: "ce numéro de série est banni après un « supprimer et bannir » : réappairez l'appareil via l'application",
    de: "diese Seriennummer ist nach einem \"Entfernen und Sperren\" gesperrt: koppeln Sie das Gerät über die App neu",
  },
  "het apparaat bereikt de server wel maar komt niet door: controleer de inloggegevens en het serienummer": {
    en: "the device does reach the server but is not let in: check the credentials and the serial number",
    fr: "l'appareil atteint bien le serveur mais n'est pas admis : vérifiez les identifiants et le numéro de série",
    de: "das Gerät erreicht den Server, kommt aber nicht durch: prüfen Sie die Zugangsdaten und die Seriennummer",
  },
  "geen enkele verbindingspoging geregistreerd in de laatste 24 uur": {
    en: "no connection attempt recorded in the last 24 hours",
    fr: "aucune tentative de connexion enregistrée dans les dernières 24 heures",
    de: "kein Verbindungsversuch in den letzten 24 Stunden registriert",
  },
  "er komt niets binnen, dus het probleem zit vóór de broker: netwerk, DNS of het apparaat staat uit": {
    en: "nothing arrives, so the problem is upstream of the broker: network, DNS, or the device is off",
    fr: "rien n'arrive, le problème est donc en amont du courtier : réseau, DNS ou l'appareil est éteint",
    de: "es kommt nichts an, das Problem liegt also vor dem Broker: Netzwerk, DNS oder das Gerät ist aus",
  },
  "client_id {0} komt van {1}": {
    en: "client_id {0} comes from {1}",
    fr: "le client_id {0} vient de {1}",
    de: "client_id {0} kommt von {1}",
  },
  "twee apparaten of processen gebruiken hetzelfde client_id en gooien elkaar er om beurten uit; zet er één uit": {
    en: "two devices or processes use the same client_id and keep kicking each other off; switch one off",
    fr: "deux appareils ou processus utilisent le même client_id et s'éjectent à tour de rôle ; éteignez-en un",
    de: "zwei Geräte oder Prozesse nutzen dieselbe client_id und werfen sich gegenseitig raus; schalten Sie eines aus",
  },
  "geen dubbel gebruikt client_id gezien": {
    en: "no client_id seen in use twice",
    fr: "aucun client_id utilisé en double",
    de: "keine doppelt genutzte client_id gesehen",
  },
  "hij is niet verbonden": {
    en: "it is not connected",
    fr: "il n'est pas connecté",
    de: "er ist nicht verbunden",
  },
  "verbonden, maar er is geen enkele meetwaarde binnengekomen": {
    en: "connected, but not a single reading has come in",
    fr: "connecté, mais aucune mesure n'est arrivée",
    de: "verbunden, aber kein einziger Messwert ist angekommen",
  },
  "de berichten zijn niet te ontcijferen of hebben een ander formaat; controleer of het serienummer klopt, daar wordt de sleutel uit afgeleid": {
    en: "the messages cannot be decrypted or have another format; check that the serial number is right, the key is derived from it",
    fr: "les messages ne peuvent pas être déchiffrés ou ont un autre format ; vérifiez que le numéro de série est correct, la clé en est dérivée",
    de: "die Nachrichten lassen sich nicht entschlüsseln oder haben ein anderes Format; prüfen Sie, ob die Seriennummer stimmt, daraus wird der Schlüssel abgeleitet",
  },
  "{0} meetwaarden ontvangen": {
    en: "{0} readings received",
    fr: "{0} mesures reçues",
    de: "{0} Messwerte empfangen",
  },

  // ── identiteit ──────────────────────────────────────────────────────────
  "geen koppeling in equipment": {
    en: "no pairing in equipment",
    fr: "aucun appairage dans equipment",
    de: "keine Kopplung in equipment",
  },
  "koppel het apparaat via de app, dat schrijft de equipment-rij": {
    en: "pair the device through the app, that writes the equipment row",
    fr: "appairez l'appareil via l'application, cela écrit la ligne equipment",
    de: "koppeln Sie das Gerät über die App, das schreibt die equipment-Zeile",
  },
  "gekoppeld maar zonder gebruiker (user_id leeg)": {
    en: "paired but without a user (user_id empty)",
    fr: "appairé mais sans utilisateur (user_id vide)",
    de: "gekoppelt, aber ohne Benutzer (user_id leer)",
  },
  "de app doet dan BLE-provisioning; rond die stap af in de app": {
    en: "the app then does BLE provisioning; finish that step in the app",
    fr: "l'application fait alors le provisionnement BLE ; terminez cette étape dans l'application",
    de: "die App macht dann die BLE-Einrichtung; schließen Sie diesen Schritt in der App ab",
  },
  "gekoppeld aan {0}": {
    en: "paired with {0}",
    fr: "appairé à {0}",
    de: "gekoppelt mit {0}",
  },
  "geen BLE MAC bekend bij de koppeling": {
    en: "no BLE MAC known for the pairing",
    fr: "aucune MAC BLE connue pour l'appairage",
    de: "keine BLE-MAC für die Kopplung bekannt",
  },
  "zonder MAC herkent de app de maaier niet in een BLE-scan": {
    en: "without a MAC the app will not recognise the mower in a BLE scan",
    fr: "sans MAC l'application ne reconnaît pas la tondeuse dans un scan BLE",
    de: "ohne MAC erkennt die App den Mäher in einem BLE-Scan nicht",
  },
  "de opgeslagen MAC {0} is die van een laadstation, niet van de maaier": {
    en: "the stored MAC {0} belongs to a charging station, not to the mower",
    fr: "la MAC enregistrée {0} est celle d'une station de charge, pas de la tondeuse",
    de: "die gespeicherte MAC {0} gehört zu einer Ladestation, nicht zum Mäher",
  },
  "laat de MAC opnieuw afleiden uit device_factory": {
    en: "have the MAC derived again from device_factory",
    fr: "faites redériver la MAC depuis device_factory",
    de: "lassen Sie die MAC neu aus device_factory ableiten",
  },
  "MAC {0} wijkt af van de fabriekswaarde {1}": {
    en: "MAC {0} differs from the factory value {1}",
    fr: "la MAC {0} diffère de la valeur d'usine {1}",
    de: "MAC {0} weicht vom Werkswert {1} ab",
  },
  "BLE MAC {0}": {
    en: "BLE MAC {0}",
    fr: "MAC BLE {0}",
    de: "BLE-MAC {0}",
  },
  "alleen van toepassing op een maaier of laadstation": {
    en: "only applies to a mower or charging station",
    fr: "ne s'applique qu'à une tondeuse ou une station de charge",
    de: "gilt nur für einen Mäher oder eine Ladestation",
  },
  "geen BLE MAC bekend voor dit laadstation": {
    en: "no BLE MAC known for this charging station",
    fr: "aucune MAC BLE connue pour cette station de charge",
    de: "keine BLE-MAC für diese Ladestation bekannt",
  },
  "{0} is via MQTT verbonden, dus hij zit op het netwerk": {
    en: "{0} is connected over MQTT, so it is on the network",
    fr: "{0} est connecté en MQTT, il est donc sur le réseau",
    de: "{0} ist über MQTT verbunden, also im Netzwerk",
  },
  "een laadstation heeft geen poorten om te peilen, dus van buitenaf valt niet te zien of {0} er nog is": {
    en: "a charging station has no ports to probe, so there is no way to see from the outside whether {0} is still there",
    fr: "une station de charge n'a aucun port à sonder ; impossible de voir de l'extérieur si {0} est toujours là",
    de: "eine Ladestation hat keine Ports zum Prüfen, von außen ist also nicht zu sehen, ob {0} noch da ist",
  },

  // ── lader en LoRa ───────────────────────────────────────────────────────
  "geen laadstation gekoppeld": {
    en: "no charging station paired",
    fr: "aucune station de charge appairée",
    de: "keine Ladestation gekoppelt",
  },
  "geen maaier gekoppeld": {
    en: "no mower paired",
    fr: "aucune tondeuse appairée",
    de: "kein Mäher gekoppelt",
  },
  "zonder laadstation is er geen RTK-correctie en dus geen nauwkeurige positie": {
    en: "without a charging station there is no RTK correction and so no accurate position",
    fr: "sans station de charge il n'y a pas de correction RTK, donc pas de position précise",
    de: "ohne Ladestation gibt es keine RTK-Korrektur und damit keine genaue Position",
  },
  "{0} heeft zich nog nooit gemeld": {
    en: "{0} has never reported in",
    fr: "{0} ne s'est jamais annoncé",
    de: "{0} hat sich noch nie gemeldet",
  },
  "richt ook het laadstation in; het heeft een eigen wifi- en MQTT-verbinding": {
    en: "set up the charging station as well; it has its own wifi and MQTT connection",
    fr: "configurez aussi la station de charge ; elle a sa propre connexion wifi et MQTT",
    de: "richten Sie auch die Ladestation ein; sie hat eine eigene WLAN- und MQTT-Verbindung",
  },
  "{0} laatst gezien {1}": {
    en: "{0} last seen {1}",
    fr: "{0} vu pour la dernière fois {1}",
    de: "{0} zuletzt gesehen {1}",
  },
  "controleer de stroom en het wifi-bereik van het laadstation": {
    en: "check the charging station's power and wifi range",
    fr: "vérifiez l'alimentation et la portée wifi de la station de charge",
    de: "prüfen Sie Strom und WLAN-Reichweite der Ladestation",
  },
  "{0} gezien {1}": {
    en: "{0} seen {1}",
    fr: "{0} vu {1}",
    de: "{0} gesehen {1}",
  },
  "de LoRa-instellingen van de maaier zijn alleen op OpenNova-firmware uit te lezen": {
    en: "the mower's LoRa settings can only be read on OpenNova firmware",
    fr: "les réglages LoRa de la tondeuse ne sont lisibles que sur le firmware OpenNova",
    de: "die LoRa-Einstellungen des Mähers sind nur auf OpenNova-Firmware auslesbar",
  },
  "geen LoRa-paar om te controleren": {
    en: "no LoRa pair to check",
    fr: "aucune paire LoRa à vérifier",
    de: "kein LoRa-Paar zu prüfen",
  },
  "adres {0} kanaal {1} aan beide kanten gelijk": {
    en: "address {0} channel {1}, identical on both sides",
    fr: "adresse {0} canal {1}, identiques des deux côtés",
    de: "Adresse {0} Kanal {1}, auf beiden Seiten gleich",
  },
  "maaier {0}/{1} tegen lader {2}/{3}": {
    en: "mower {0}/{1} against charger {2}/{3}",
    fr: "tondeuse {0}/{1} contre chargeur {2}/{3}",
    de: "Mäher {0}/{1} gegen Ladestation {2}/{3}",
  },
  "adres en kanaal moeten IDENTIEK zijn aan beide kanten; koppel opnieuw via de app": {
    en: "address and channel must be IDENTICAL on both sides; pair again through the app",
    fr: "adresse et canal doivent être IDENTIQUES des deux côtés ; réappairez via l'application",
    de: "Adresse und Kanal müssen auf beiden Seiten IDENTISCH sein; koppeln Sie über die App neu",
  },
  "de LoRa-instellingen zijn nog niet van beide apparaten gelezen": {
    en: "the LoRa settings have not been read from both devices yet",
    fr: "les réglages LoRa n'ont pas encore été lus sur les deux appareils",
    de: "die LoRa-Einstellungen wurden noch nicht von beiden Geräten gelesen",
  },

  // ── firmware ────────────────────────────────────────────────────────────
  "firmwareversie nog niet gemeld": {
    en: "firmware version not reported yet",
    fr: "version du firmware pas encore signalée",
    de: "Firmware-Version noch nicht gemeldet",
  },
  "{0} (OpenNova)": {
    en: "{0} (OpenNova)",
    fr: "{0} (OpenNova)",
    de: "{0} (OpenNova)",
  },
  "{0} (stock)": {
    en: "{0} (stock)",
    fr: "{0} (d'origine)",
    de: "{0} (Werksfirmware)",
  },
  "{0} werkzones op firmware die er maximaal 5 aankan": {
    en: "{0} work zones on firmware that handles at most 5",
    fr: "{0} zones de travail sur un firmware qui en gère au plus 5",
    de: "{0} Arbeitszonen auf einer Firmware, die höchstens 5 verkraftet",
  },
  "zones boven de vijfde eindigen in fout 125; werk de firmware bij naar custom-{0} of hoger": {
    en: "zones beyond the fifth end in error 125; update the firmware to custom-{0} or higher",
    fr: "les zones au-delà de la cinquième finissent en erreur 125 ; mettez le firmware à jour vers custom-{0} ou plus",
    de: "Zonen über der fünften enden in Fehler 125; aktualisieren Sie die Firmware auf custom-{0} oder höher",
  },

  // ── klaar om te maaien ──────────────────────────────────────────────────
  "{0} werkgebied(en)": {
    en: "{0} work area(s)",
    fr: "{0} zone(s) de travail",
    de: "{0} Arbeitsbereich(e)",
  },
  "geen enkel werkgebied bekend": {
    en: "no work area known at all",
    fr: "aucune zone de travail connue",
    de: "kein einziger Arbeitsbereich bekannt",
  },
  "karteer eerst een gebied, zonder kaart start er niets": {
    en: "map an area first, nothing starts without a map",
    fr: "cartographiez d'abord une zone, sans carte rien ne démarre",
    de: "kartieren Sie zuerst einen Bereich, ohne Karte startet nichts",
  },
  "geen meetwaarden": {
    en: "no readings",
    fr: "aucune mesure",
    de: "keine Messwerte",
  },
  "nog geen RTK-status ontvangen": {
    en: "no RTK status received yet",
    fr: "aucun état RTK reçu pour le moment",
    de: "noch kein RTK-Status empfangen",
  },
  "RTK-status {0}, {1} satellieten": {
    en: "RTK status {0}, {1} satellites",
    fr: "état RTK {0}, {1} satellites",
    de: "RTK-Status {0}, {1} Satelliten",
  },
  "RTK-status {0}": {
    en: "RTK status {0}",
    fr: "état RTK {0}",
    de: "RTK-Status {0}",
  },
  "zonder RTK-fix is de positie te onnauwkeurig om te maaien; controleer het laadstation en of het zicht op de hemel heeft": {
    en: "without an RTK fix the position is too imprecise to mow; check the charging station and whether it has a clear view of the sky",
    fr: "sans fix RTK la position est trop imprécise pour tondre ; vérifiez la station de charge et qu'elle a une vue dégagée du ciel",
    de: "ohne RTK-Fix ist die Position zu ungenau zum Mähen; prüfen Sie die Ladestation und ob sie freie Sicht zum Himmel hat",
  },
  "geen storing": {
    en: "no fault",
    fr: "aucune panne",
    de: "keine Störung",
  },
  "storing {0} actief": {
    en: "fault {0} active",
    fr: "panne {0} active",
    de: "Störung {0} aktiv",
  },
  "melding {0}, niet blokkerend": {
    en: "notice {0}, not blocking",
    fr: "avis {0}, non bloquant",
    de: "Meldung {0}, nicht blockierend",
  },
  "los de storing op of wis hem, anders start er geen taak": {
    en: "clear or resolve the fault, otherwise no task will start",
    fr: "résolvez ou effacez la panne, sinon aucune tâche ne démarre",
    de: "beheben oder löschen Sie die Störung, sonst startet keine Aufgabe",
  },
  "de maaier staat in karteermodus": {
    en: "the mower is in mapping mode",
    fr: "la tondeuse est en mode cartographie",
    de: "der Mäher ist im Kartierungsmodus",
  },
  "niet in karteermodus": {
    en: "not in mapping mode",
    fr: "pas en mode cartographie",
    de: "nicht im Kartierungsmodus",
  },
  "in deze stand start geen maaitaak en kun je geen kaart verwijderen; sluit het karteren af": {
    en: "in this mode no mowing task starts and no map can be deleted; finish the mapping session",
    fr: "dans ce mode aucune tâche de tonte ne démarre et aucune carte ne peut être supprimée ; terminez la cartographie",
    de: "in diesem Modus startet keine Mähaufgabe und keine Karte lässt sich löschen; beenden Sie die Kartierung",
  },
  "een onderbroken maaibeurt staat geparkeerd (status {0})": {
    en: "an interrupted mowing run is parked (status {0})",
    fr: "une tonte interrompue est en attente (état {0})",
    de: "ein unterbrochener Mähdurchgang ist geparkt (Status {0})",
  },
  "geen geparkeerde taak": {
    en: "no parked task",
    fr: "aucune tâche en attente",
    de: "keine geparkte Aufgabe",
  },
  "de firmware weigert een nieuwe start zolang deze er staat; hervat hem of beëindig de sessie": {
    en: "the firmware refuses a new start while this one stands; resume it or end the session",
    fr: "le firmware refuse un nouveau départ tant qu'elle est là ; reprenez-la ou terminez la session",
    de: "die Firmware verweigert einen neuen Start, solange diese steht; setzen Sie sie fort oder beenden Sie die Sitzung",
  },
  "het kaartframe is nog niet gecontroleerd na een herstel": {
    en: "the map frame has not been verified since a restore",
    fr: "le cadre de carte n'a pas été vérifié depuis une restauration",
    de: "der Kartenrahmen wurde seit einer Wiederherstellung nicht überprüft",
  },
  "kaartframe gecontroleerd": {
    en: "map frame verified",
    fr: "cadre de carte vérifié",
    de: "Kartenrahmen überprüft",
  },
  "anker de maaier opnieuw op het laadstation voor je gaat maaien": {
    en: "re-anchor the mower on the charging station before you mow",
    fr: "réancrez la tondeuse sur la station de charge avant de tondre",
    de: "verankern Sie den Mäher neu an der Ladestation, bevor Sie mähen",
  },

  // ── op de maaier zelf ───────────────────────────────────────────────────
  "stock firmware heeft geen SSH, dus hier valt niets te lezen": {
    en: "stock firmware has no SSH, so there is nothing to read here",
    fr: "le firmware d'origine n'a pas de SSH, il n'y a donc rien à lire ici",
    de: "die Werksfirmware hat kein SSH, hier gibt es also nichts zu lesen",
  },
  "kan niet inloggen op {0}: {1}": {
    en: "cannot log in to {0}: {1}",
    fr: "impossible de se connecter à {0} : {1}",
    de: "Anmeldung auf {0} nicht möglich: {1}",
  },
  "zonder toegang tot de maaier zelf blijft de diagnose bij wat van buitenaf te zien is": {
    en: "without access to the mower itself the diagnosis stops at what is visible from the outside",
    fr: "sans accès à la tondeuse elle-même, le diagnostic s'arrête à ce qui est visible de l'extérieur",
    de: "ohne Zugang zum Mäher selbst bleibt die Diagnose bei dem, was von außen sichtbar ist",
  },
  "ingelogd op {0}": {
    en: "logged in to {0}",
    fr: "connecté à {0}",
    de: "angemeldet auf {0}",
  },
  "mqtt_node draait niet": {
    en: "mqtt_node is not running",
    fr: "mqtt_node ne tourne pas",
    de: "mqtt_node läuft nicht",
  },
  "zonder dit proces stuurt de maaier geen enkele status; herstart hem met set_server_urls.sh --restart-mqtt": {
    en: "without this process the mower sends no status at all; restart it with set_server_urls.sh --restart-mqtt",
    fr: "sans ce processus la tondeuse n'envoie aucun état ; redémarrez-le avec set_server_urls.sh --restart-mqtt",
    de: "ohne diesen Prozess sendet der Mäher keinerlei Status; starten Sie ihn mit set_server_urls.sh --restart-mqtt neu",
  },
  "mqtt_node draait al {0} uur maar heeft geen verbinding met de broker, {1} netwerkfouten in zijn log": {
    en: "mqtt_node has been running for {0} hours with no connection to the broker, {1} network errors in its log",
    fr: "mqtt_node tourne depuis {0} heures sans connexion au courtier, {1} erreurs réseau dans son journal",
    de: "mqtt_node läuft seit {0} Stunden ohne Verbindung zum Broker, {1} Netzwerkfehler in seinem Log",
  },
  "mqtt_node draait al {0} uur maar heeft geen verbinding met de broker": {
    en: "mqtt_node has been running for {0} hours with no connection to the broker",
    fr: "mqtt_node tourne depuis {0} heures sans connexion au courtier",
    de: "mqtt_node läuft seit {0} Stunden ohne Verbindung zum Broker",
  },
  "mqtt_node draait maar heeft geen verbinding met de broker, {0} netwerkfouten in zijn log": {
    en: "mqtt_node is running but has no connection to the broker, {0} network errors in its log",
    fr: "mqtt_node tourne mais n'a pas de connexion au courtier, {0} erreurs réseau dans son journal",
    de: "mqtt_node läuft, hat aber keine Verbindung zum Broker, {0} Netzwerkfehler in seinem Log",
  },
  "mqtt_node draait maar heeft geen verbinding met de broker": {
    en: "mqtt_node is running but has no connection to the broker",
    fr: "mqtt_node tourne mais n'a pas de connexion au courtier",
    de: "mqtt_node läuft, hat aber keine Verbindung zum Broker",
  },
  "hij is bij het opstarten blijven hangen en komt daar niet zelf uit; herstart hem met set_server_urls.sh --restart-mqtt": {
    en: "it got stuck during boot and will not recover on its own; restart it with set_server_urls.sh --restart-mqtt",
    fr: "il s'est bloqué au démarrage et n'en sortira pas seul ; redémarrez-le avec set_server_urls.sh --restart-mqtt",
    de: "er ist beim Start hängen geblieben und kommt da nicht selbst heraus; starten Sie ihn mit set_server_urls.sh --restart-mqtt neu",
  },
  "mqtt_node verbonden met de broker": {
    en: "mqtt_node connected to the broker",
    fr: "mqtt_node connecté au courtier",
    de: "mqtt_node mit dem Broker verbunden",
  },
  "json_config.json mist het serienummer": {
    en: "json_config.json is missing the serial number",
    fr: "json_config.json n'a pas le numéro de série",
    de: "in json_config.json fehlt die Seriennummer",
  },
  "mqtt-adres in json_config.json: {0}": {
    en: "MQTT address in json_config.json: {0}",
    fr: "adresse MQTT dans json_config.json : {0}",
    de: "MQTT-Adresse in json_config.json: {0}",
  },
  "zonder serienummer kan mqtt_node zich niet aanmelden": {
    en: "without a serial number mqtt_node cannot announce itself",
    fr: "sans numéro de série mqtt_node ne peut pas s'annoncer",
    de: "ohne Seriennummer kann sich mqtt_node nicht anmelden",
  },
  "dit is het cloudadres; het werkt alleen zolang je DNS het omleidt naar je eigen server. Een IP is betrouwbaarder": {
    en: "this is the cloud address; it only works while your DNS redirects it to your own server. An IP address is more reliable",
    fr: "c'est l'adresse cloud ; elle ne fonctionne que tant que votre DNS la redirige vers votre propre serveur. Une adresse IP est plus fiable",
    de: "das ist die Cloud-Adresse; sie funktioniert nur, solange Ihr DNS sie auf Ihren eigenen Server umleitet. Eine IP-Adresse ist zuverlässiger",
  },
  "de maaier vindt de server zelf via opennova.local": {
    en: "the mower finds the server by itself over opennova.local",
    fr: "la tondeuse trouve le serveur elle-même via opennova.local",
    de: "der Mäher findet den Server selbst über opennova.local",
  },
  "de maaier vindt opennova.local niet (server: {0})": {
    en: "the mower cannot find opennova.local (server: {0})",
    fr: "la tondeuse ne trouve pas opennova.local (serveur : {0})",
    de: "der Mäher findet opennova.local nicht (Server: {0})",
  },
  "hij leunt nu volledig op je DNS-omleiding. Automatisch ontdekken werkt niet omdat de container multicast niet naar het thuisnetwerk krijgt; host-netwerk of een mDNS-reflector lost dat op": {
    en: "it now leans entirely on your DNS redirect. Automatic discovery does not work because the container cannot get multicast onto the home network; host networking or an mDNS reflector solves that",
    fr: "il repose maintenant entièrement sur votre redirection DNS. La découverte automatique ne fonctionne pas car le conteneur ne fait pas passer le multicast vers le réseau domestique ; le réseau host ou un réflecteur mDNS résout cela",
    de: "er stützt sich jetzt vollständig auf Ihre DNS-Umleitung. Automatische Erkennung funktioniert nicht, weil der Container Multicast nicht ins Heimnetz bekommt; Host-Netzwerk oder ein mDNS-Reflektor löst das",
  },
  "hij leunt nu volledig op je DNS-omleiding. Automatisch ontdekken werkt pas als de server zich op het netwerk adverteert": {
    en: "it now leans entirely on your DNS redirect. Automatic discovery only works once the server advertises itself on the network",
    fr: "il repose maintenant entièrement sur votre redirection DNS. La découverte automatique ne fonctionne que lorsque le serveur s'annonce sur le réseau",
    de: "er stützt sich jetzt vollständig auf Ihre DNS-Umleitung. Automatische Erkennung funktioniert erst, wenn sich der Server im Netzwerk bekannt macht",
  },
  "set_server_urls sloeg de config-update over, opennova.local lost op de maaier niet op": {
    en: "set_server_urls skipped the config update, opennova.local does not resolve on the mower",
    fr: "set_server_urls a sauté la mise à jour de config, opennova.local ne se résout pas sur la tondeuse",
    de: "set_server_urls hat das Config-Update übersprungen, opennova.local lässt sich auf dem Mäher nicht auflösen",
  },
  "set_server_urls sloeg de config-update over, opennova.local lost op de maaier niet op en /userdata/lfi/server_ip.txt bestaat niet": {
    en: "set_server_urls skipped the config update, opennova.local does not resolve on the mower and /userdata/lfi/server_ip.txt does not exist",
    fr: "set_server_urls a sauté la mise à jour de config, opennova.local ne se résout pas sur la tondeuse et /userdata/lfi/server_ip.txt n'existe pas",
    de: "set_server_urls hat das Config-Update übersprungen, opennova.local lässt sich auf dem Mäher nicht auflösen und /userdata/lfi/server_ip.txt existiert nicht",
  },
  "set_server_urls sloeg de config-update over": {
    en: "set_server_urls skipped the config update",
    fr: "set_server_urls a sauté la mise à jour de config",
    de: "set_server_urls hat das Config-Update übersprungen",
  },
  "set_server_urls sloeg de config-update over en /userdata/lfi/server_ip.txt bestaat niet": {
    en: "set_server_urls skipped the config update and /userdata/lfi/server_ip.txt does not exist",
    fr: "set_server_urls a sauté la mise à jour de config et /userdata/lfi/server_ip.txt n'existe pas",
    de: "set_server_urls hat das Config-Update übersprungen und /userdata/lfi/server_ip.txt existiert nicht",
  },
  "zet het serveradres in /userdata/lfi/server_ip.txt, dan vult het script json_config.json bij de volgende boot alsnog": {
    en: "put the server address in /userdata/lfi/server_ip.txt, then the script will still fill in json_config.json on the next boot",
    fr: "mettez l'adresse du serveur dans /userdata/lfi/server_ip.txt, le script remplira alors json_config.json au prochain démarrage",
    de: "tragen Sie die Serveradresse in /userdata/lfi/server_ip.txt ein, dann füllt das Skript json_config.json beim nächsten Start doch noch",
  },
  "laatst bekende server {0}": {
    en: "last known server {0}",
    fr: "dernier serveur connu {0}",
    de: "zuletzt bekannter Server {0}",
  },
  "config-update liep door": {
    en: "config update went through",
    fr: "la mise à jour de config est passée",
    de: "Config-Update ist durchgelaufen",
  },
  "extended_commands draait": {
    en: "extended_commands is running",
    fr: "extended_commands tourne",
    de: "extended_commands läuft",
  },
  "extended_commands draait niet": {
    en: "extended_commands is not running",
    fr: "extended_commands ne tourne pas",
    de: "extended_commands läuft nicht",
  },
  "zonder dit script werken de OpenNova-commando's en de RTK-telemetrie niet": {
    en: "without this script the OpenNova commands and the RTK telemetry do not work",
    fr: "sans ce script les commandes OpenNova et la télémétrie RTK ne fonctionnent pas",
    de: "ohne dieses Skript funktionieren die OpenNova-Befehle und die RTK-Telemetrie nicht",
  },

  // ── samenvatting ────────────────────────────────────────────────────────
  "geen blokkade gevonden, alles staat goed": {
    en: "no blockage found, everything is in order",
    fr: "aucun blocage trouvé, tout est en ordre",
    de: "keine Blockade gefunden, alles in Ordnung",
  },
  "geen blokkade gevonden, wel 1 aandachtspunt: {0}": {
    en: "no blockage found, but 1 point of attention: {0}",
    fr: "aucun blocage trouvé, mais 1 point d'attention : {0}",
    de: "keine Blockade gefunden, aber 1 Hinweis: {0}",
  },
  "geen blokkade gevonden, wel {0} aandachtspunten: {1}": {
    en: "no blockage found, but {0} points of attention: {1}",
    fr: "aucun blocage trouvé, mais {0} points d'attention : {1}",
    de: "keine Blockade gefunden, aber {0} Hinweise: {1}",
  },
  // ── netwerkmodus, SSH-bewijs en de netcheck van mqtt_node (2026-09-16) ──
  "in bridge-modus komt multicast meestal niet op het thuisnetwerk; of de maaier de server zo vindt staat verderop bij de maaier zelf": {
    en: "in bridge mode multicast usually does not reach the home network; whether the mower finds the server that way is shown further down, at the mower itself",
    fr: "en mode bridge, le multicast n'atteint généralement pas le réseau domestique ; si la tondeuse trouve le serveur ainsi est indiqué plus bas, chez la tondeuse elle-même",
    de: "im Bridge-Modus erreicht Multicast das Heimnetz meist nicht; ob der Mäher den Server so findet, steht weiter unten beim Mäher selbst",
  },
  "de server kent {0} (stock), maar inloggen via SSH lukt en dat kan alleen op OpenNova-firmware; op de maaier staat {1}": {
    en: "the server has {0} (stock) on record, but logging in over SSH works and that is only possible on OpenNova firmware; the mower itself says {1}",
    fr: "le serveur connaît {0} (stock), mais la connexion SSH fonctionne et ce n'est possible que sur le firmware OpenNova ; la tondeuse elle-même indique {1}",
    de: "der Server kennt {0} (Stock), aber die SSH-Anmeldung klappt und das geht nur mit OpenNova-Firmware; auf dem Mäher steht {1}",
  },
  "de server kent geen versie, maar inloggen via SSH lukt en dat kan alleen op OpenNova-firmware; op de maaier staat {0}": {
    en: "the server has no version on record, but logging in over SSH works and that is only possible on OpenNova firmware; the mower itself says {0}",
    fr: "le serveur ne connaît aucune version, mais la connexion SSH fonctionne et ce n'est possible que sur le firmware OpenNova ; la tondeuse elle-même indique {0}",
    de: "der Server kennt keine Version, aber die SSH-Anmeldung klappt und das geht nur mit OpenNova-Firmware; auf dem Mäher steht {0}",
  },
  "de versie in de server komt van mqtt_node; zolang die niet verbindt blijft de oude staan, zie de maaier-groep hieronder": {
    en: "the version in the server comes from mqtt_node; as long as it does not connect the old one stays, see the mower group below",
    fr: "la version dans le serveur vient de mqtt_node ; tant qu'il ne se connecte pas, l'ancienne reste, voir le groupe tondeuse ci-dessous",
    de: "die Version im Server kommt von mqtt_node; solange der nicht verbindet, bleibt die alte stehen, siehe die Mäher-Gruppe unten",
  },
  "de netcheck van mqtt_node naar http://{0} slaagt": {
    en: "mqtt_node's network check to http://{0} succeeds",
    fr: "le contrôle réseau de mqtt_node vers http://{0} réussit",
    de: "der Netzwerkcheck von mqtt_node nach http://{0} gelingt",
  },
  "de netcheck van mqtt_node naar http://{0} geeft {1}": {
    en: "mqtt_node's network check to http://{0} returns {1}",
    fr: "le contrôle réseau de mqtt_node vers http://{0} renvoie {1}",
    de: "der Netzwerkcheck von mqtt_node nach http://{0} liefert {1}",
  },
  "de netcheck van mqtt_node naar http://{0} krijgt geen antwoord": {
    en: "mqtt_node's network check to http://{0} gets no answer",
    fr: "le contrôle réseau de mqtt_node vers http://{0} ne reçoit aucune réponse",
    de: "der Netzwerkcheck von mqtt_node nach http://{0} bekommt keine Antwort",
  },
  "zolang dit faalt verbindt mqtt_node nooit; zet in /userdata/lfi/http_address.txt het adres van deze server met de juiste poort (bv. {0}:{1}) en herstart met set_server_urls.sh --restart-mqtt": {
    en: "as long as this fails mqtt_node never connects; put this server's address with the right port in /userdata/lfi/http_address.txt (e.g. {0}:{1}) and restart with set_server_urls.sh --restart-mqtt",
    fr: "tant que cela échoue, mqtt_node ne se connecte jamais ; mettez l'adresse de ce serveur avec le bon port dans /userdata/lfi/http_address.txt (p. ex. {0}:{1}) et redémarrez avec set_server_urls.sh --restart-mqtt",
    de: "solange das fehlschlägt, verbindet mqtt_node nie; trage in /userdata/lfi/http_address.txt die Adresse dieses Servers mit dem richtigen Port ein (z. B. {0}:{1}) und starte mit set_server_urls.sh --restart-mqtt neu",
  },
  "/userdata/lfi/http_address.txt ontbreekt of is leeg": {
    en: "/userdata/lfi/http_address.txt is missing or empty",
    fr: "/userdata/lfi/http_address.txt est absent ou vide",
    de: "/userdata/lfi/http_address.txt fehlt oder ist leer",
  },
  "zonder dit adres slaat de netcheck van mqtt_node nergens op; draai set_server_urls.sh --restart-mqtt": {
    en: "without this address mqtt_node's network check has nowhere to go; run set_server_urls.sh --restart-mqtt",
    fr: "sans cette adresse, le contrôle réseau de mqtt_node n'a nulle part où aller ; exécutez set_server_urls.sh --restart-mqtt",
    de: "ohne diese Adresse hat der Netzwerkcheck von mqtt_node kein Ziel; führe set_server_urls.sh --restart-mqtt aus",
  },
};
