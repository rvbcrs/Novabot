/**
 * API catalog: every sentence the server says outside the connection
 * diagnosis (API errors, status messages), in English, French and German.
 *
 * Same rules as diagnosisText.catalog.ts: the key is the Dutch original with
 * {0}, {1}, … where the values go, Dutch needs no entry because it is the key,
 * and serverText.coverage.test.ts fails when a sentence in the source is
 * missing here in any language.
 */
import type { Catalog } from './serverText.js';

export const CATALOG: Catalog = {
  "Wachten op acht verse, stabiele Fixed-metingen op het dock.": {
    en: "Waiting for eight fresh, stable Fixed readings on the dock.",
    fr: "Attente de huit mesures Fixed fraîches et stables sur la station.",
    de: "Warten auf acht neue, stabile Fixed-Messungen auf der Ladestation.",
  },
  "Rij onder toezicht met de joystick ongeveer één meter van het dock. Wacht op verse RUNNING + RTK Fixed.": {
    en: "Under supervision, use the joystick to drive about one metre away from the dock. Wait for fresh RUNNING + RTK Fixed.",
    fr: "Sous surveillance, éloignez la tondeuse d’environ un mètre avec le joystick. Attendez de nouvelles données RUNNING + RTK Fixed.",
    de: "Fahren Sie unter Aufsicht mit dem Joystick etwa einen Meter von der Ladestation weg. Warten Sie auf neue RUNNING + RTK Fixed-Daten.",
  },
  "Lokalisatie hersteld. Rij met de joystick terug op het dock en druk op Verifieer.": {
    en: "Localization restored. Return onto the dock using the joystick and press Verify.",
    fr: "Localisation rétablie. Revenez sur la station avec le joystick et appuyez sur Vérifier.",
    de: "Lokalisierung wiederhergestellt. Fahren Sie mit dem Joystick auf die Ladestation zurück und drücken Sie Prüfen.",
  },
  "Acht verse dockmetingen en de geladen oorsprong controleren.": {
    en: "Checking eight fresh dock readings and the loaded origin.",
    fr: "Vérification de huit nouvelles mesures sur la station et de l’origine chargée.",
    de: "Acht neue Dockmessungen und den geladenen Ursprung prüfen.",
  },
  "Frame gecontroleerd: {0} m van het vaste dockanker.": {
    en: "Frame verified: {0} m from the fixed dock anchor.",
    fr: "Repère vérifié : {0} m du point fixe de la station.",
    de: "Koordinatenrahmen geprüft: {0} m vom festen Dockanker.",
  },
  "{0}": {
    en: "{0}",
    fr: "{0}",
    de: "{0}",
  },
  "Dockanker en maaierbestanden controleren.": {
    en: "Checking the dock anchor and mower files.",
    fr: "Vérification du point de référence de la station et des fichiers de la tondeuse.",
    de: "Dockanker und Mäherdateien prüfen.",
  },
  "Zet de kaartverschuiving van beide maaiers op nul voordat je een zone kopieert.": {
    en: "Set both mowers’ map offsets to zero before copying a zone.",
    fr: "Remettez les décalages de carte des deux tondeuses à zéro avant de copier une zone.",
    de: "Setzen Sie die Kartenverschiebungen beider Mäher auf null, bevor Sie eine Zone kopieren.",
  },
  "Alleen in de server/app-kopie geïmporteerd. De maaierbestanden zijn niet geschreven; maaien werkt alleen als deze kaarten al op de maaier staan.": {
    en: "Imported into the server/app copy only. Mower files were not written; mowing works only if these maps already exist on the mower.",
    fr: "Importé uniquement dans la copie serveur/app. Les fichiers de la tondeuse n'ont pas été écrits ; la tonte ne fonctionne que si ces cartes existent déjà sur la tondeuse.",
    de: "Nur in die Server-/App-Kopie importiert. Die Mäherdateien wurden nicht geschrieben; Mähen funktioniert nur, wenn diese Karten bereits auf dem Mäher sind.",
  },
  "Alleen obstakels kunnen verwijderd worden": {
    en: "Only obstacles can be deleted",
    fr: "Seuls les obstacles peuvent être supprimés",
    de: "Nur Hindernisse können gelöscht werden",
  },
  "Apparaat heeft geen eigenaar": {
    en: "Equipment has no owner",
    fr: "L'appareil n'a pas de propriétaire",
    de: "Das Gerät hat keinen Besitzer",
  },
  "Apparaat is offline": {
    en: "Device is offline",
    fr: "L'appareil est hors ligne",
    de: "Das Gerät ist offline",
  },
  "Apparaat niet gevonden": {
    en: "Equipment not found",
    fr: "Appareil introuvable",
    de: "Gerät nicht gefunden",
  },
  "Autonoom karteren": {
    en: "Autonomous mapping",
    fr: "La cartographie autonome",
    de: "Das autonome Kartieren",
  },
  "Batterijstatus is '{0}', niet CHARGING. Zet de maaier eerst op het dock, of POST met {\"force\": true} om dit te negeren.": {
    en: "Battery state is '{0}', not CHARGING. Put mower on dock first, or POST with {\"force\": true} to override.",
    fr: "L'état de la batterie est '{0}', pas CHARGING. Placez d'abord la tondeuse sur le dock, ou envoyez un POST avec {\"force\": true} pour passer outre.",
    de: "Der Akkustatus ist '{0}', nicht CHARGING. Stellen Sie den Mäher zuerst auf das Dock oder senden Sie einen POST mit {\"force\": true}, um dies zu übergehen.",
  },
  "Beide uiteinden liggen in map{0}; een kanaal verbindt twee verschillende gebieden. Om het laadstation te verbinden: begin het kanaal bij het station of typ de naam (bv. map0tocharge_unicom).": {
    en: "Both ends lie in map{0}; a channel connects two different areas. To connect the charging station, start the channel at the station or type the name (e.g. map0tocharge_unicom).",
    fr: "Les deux extrémités sont dans map{0} ; un canal relie deux zones différentes. Pour relier la station de charge, commencez le canal à la station ou saisissez le nom (p. ex. map0tocharge_unicom).",
    de: "Beide Enden liegen in map{0}; ein Kanal verbindet zwei verschiedene Bereiche. Um die Ladestation anzubinden, beginnen Sie den Kanal an der Station oder geben Sie den Namen ein (z. B. map0tocharge_unicom).",
  },
  "Beide uiteinden liggen op het laadstation. Teken het kanaal naar een werkgebied.": {
    en: "Both ends lie on the charging station. Draw the channel to a work area.",
    fr: "Les deux extrémités sont sur la station de charge. Tracez le canal jusqu'à une zone de travail.",
    de: "Beide Enden liegen auf der Ladestation. Zeichnen Sie den Kanal zu einem Arbeitsbereich.",
  },
  "Bluetooth is niet beschikbaar op deze server": {
    en: "Bluetooth not available on this server",
    fr: "Bluetooth n'est pas disponible sur ce serveur",
    de: "Bluetooth ist auf diesem Server nicht verfügbar",
  },
  "Camera gaf een leeg frame": {
    en: "Camera returned an empty frame",
    fr: "La caméra a renvoyé une image vide",
    de: "Die Kamera hat ein leeres Bild geliefert",
  },
  "Camera niet bereikbaar": {
    en: "Camera not reachable",
    fr: "Caméra injoignable",
    de: "Kamera nicht erreichbar",
  },
  "Camera niet gereed": {
    en: "Camera not ready",
    fr: "Caméra pas prête",
    de: "Kamera nicht bereit",
  },
  "Certificaat nog niet gegenereerd: herstart de container": {
    en: "Certificate not generated yet: restart the container",
    fr: "Certificat pas encore généré : redémarrez le conteneur",
    de: "Zertifikat noch nicht erstellt: Starten Sie den Container neu",
  },
  "Cloud-resync mislukt": {
    en: "cloud-resync failed",
    fr: "Échec de la resynchronisation cloud",
    de: "Cloud-Resync fehlgeschlagen",
  },
  "De coverage-planner radius": {
    en: "The coverage planner radius",
    fr: "Le rayon du planificateur de couverture",
    de: "Der Radius des Abdeckungsplaners",
  },
  "De kaart verschuiven": {
    en: "Shifting the map",
    fr: "Décaler la carte",
    de: "Das Verschieben der Karte",
  },
  "De laadpositie herijken": {
    en: "Recalibrating the charging position",
    fr: "Recalibrer la position de charge",
    de: "Das Neukalibrieren der Ladeposition",
  },
  "De lokalisatie van de maaier is \"{0}\". De posewaarden zijn nog niet betrouwbaar. Rij de maaier kort van het dock, laat hem terugkeren en probeer het opnieuw.": {
    en: "Mower localization is \"{0}\". Pose values are not trustworthy yet. Drive the mower briefly off the dock, return, then retry.",
    fr: "La localisation de la tondeuse est « {0} ». Les valeurs de pose ne sont pas encore fiables. Éloignez brièvement la tondeuse du dock, laissez-la revenir, puis réessayez.",
    de: "Die Lokalisierung des Mähers ist „{0}“. Die Posenwerte sind noch nicht zuverlässig. Fahren Sie den Mäher kurz vom Dock weg, lassen Sie ihn zurückkehren und versuchen Sie es erneut.",
  },
  "De maaier antwoordde niet (time-out)": {
    en: "Mower did not respond (timeout)",
    fr: "La tondeuse n'a pas répondu (délai dépassé)",
    de: "Der Mäher hat nicht geantwortet (Zeitüberschreitung)",
  },
  "De maaier antwoordde niet binnen 8 s": {
    en: "Mower did not respond within 8s",
    fr: "La tondeuse n'a pas répondu dans les 8 s",
    de: "Der Mäher hat nicht innerhalb von 8 s geantwortet",
  },
  "De maaier antwoordde niet op het wiscommando: {0}": {
    en: "The mower did not respond to the delete command: {0}",
    fr: "La tondeuse n'a pas répondu à la commande de suppression : {0}",
    de: "Der Mäher hat nicht auf den Löschbefehl geantwortet: {0}",
  },
  "De maaier gaf een leeg preview-pad terug": {
    en: "mower returned an empty preview path",
    fr: "La tondeuse a renvoyé un trajet d'aperçu vide",
    de: "Der Mäher hat einen leeren Vorschaupfad geliefert",
  },
  "De maaier heeft map_position nog niet gemeld: er is eerst een report_state_timer_data-bericht nodig. Probeer het over ~5 s opnieuw.": {
    en: "Mower map_position not yet reported: need a report_state_timer_data message first. Try again in ~5s.",
    fr: "La tondeuse n'a pas encore signalé map_position : un message report_state_timer_data est d'abord nécessaire. Réessayez dans ~5 s.",
    de: "Der Mäher hat map_position noch nicht gemeldet: Zuerst ist eine report_state_timer_data-Nachricht nötig. Versuchen Sie es in ~5 s erneut.",
  },
  "De maaier is bezig; stop de taak eerst en probeer het dan opnieuw.": {
    en: "The mower is busy; stop the task first and then try again.",
    fr: "La tondeuse est occupée ; arrêtez d'abord la tâche puis réessayez.",
    de: "Der Mäher ist beschäftigt; beenden Sie zuerst die Aufgabe und versuchen Sie es dann erneut.",
  },
  "De maaier meldde (0, 0, 0): een plaatshouder voor niet-geïnitialiseerde lokalisatie. Rij de maaier een klein stukje van het dock zodat de lokalisatie initialiseert (koersbepaling), laat hem terugkeren naar het dock en probeer het opnieuw.": {
    en: "Mower reported (0, 0, 0): placeholder for uninitialized localization. Drive the mower a short distance off the dock so localization initializes (heading discovery), let it return to dock, then retry.",
    fr: "La tondeuse a signalé (0, 0, 0) : valeur provisoire pour une localisation non initialisée. Éloignez un peu la tondeuse du dock pour que la localisation s'initialise (détermination du cap), laissez-la revenir au dock, puis réessayez.",
    de: "Der Mäher meldete (0, 0, 0): ein Platzhalter für eine nicht initialisierte Lokalisierung. Fahren Sie den Mäher ein kurzes Stück vom Dock weg, damit die Lokalisierung initialisiert (Kursbestimmung), lassen Sie ihn zum Dock zurückkehren und versuchen Sie es erneut.",
  },
  "De maaier weigerde de kaart te wissen.": {
    en: "The mower refused to delete the map.",
    fr: "La tondeuse a refusé de supprimer la carte.",
    de: "Der Mäher hat das Löschen der Karte verweigert.",
  },
  "De mapping-preflight": {
    en: "The mapping preflight",
    fr: "La vérification préalable de cartographie",
    de: "Die Kartierungs-Vorprüfung",
  },
  "De rand-seam-fix": {
    en: "The edge seam fix",
    fr: "La correction de jointure des bords",
    de: "Die Randnaht-Korrektur",
  },
  "De server draait. Verbind met de OpenNova-app.": {
    en: "Server is running. Use the OpenNova app to connect.",
    fr: "Le serveur fonctionne. Connectez-vous avec l'application OpenNova.",
    de: "Der Server läuft. Verbinden Sie sich mit der OpenNova-App.",
  },
  "De verschuiving mag per as hoogstens {0} m zijn": {
    en: "Offset magnitude must be ≤ {0} m per axis",
    fr: "Le décalage doit être au maximum de {0} m par axe",
    de: "Die Verschiebung darf pro Achse höchstens {0} m betragen",
  },
  "Deze firmware kan de gekozen gebiedscode niet maaien. Kies alleen map0–map4 (zones 1–5); latere slots geven firmwarefout 125. Je opgeslagen kaarten blijven ongewijzigd.": {
    en: "This firmware cannot mow the selected area code. Select only map0–map4 (zones 1–5); later slots trigger firmware error 125. Your saved maps are unchanged.",
    fr: "Ce firmware ne peut pas tondre le code de zone choisi. Sélectionnez uniquement map0–map4 (zones 1–5) ; les emplacements suivants déclenchent l'erreur firmware 125. Vos cartes enregistrées ne sont pas modifiées.",
    de: "Diese Firmware kann den gewählten Bereichscode nicht mähen. Wählen Sie nur map0–map4 (Zonen 1–5); spätere Slots lösen Firmware-Fehler 125 aus. Ihre gespeicherten Karten bleiben unverändert.",
  },
  "Dit is het kanaal van de zone naar het laadstation. De maaier schrijft het zelf wanneer de laadpositie wordt opgeslagen en elke andere polygoon is aan het eerste punt ervan verankerd, dus het kan niet worden verwijderd. Is het laadstation verplaatst, gebruik dan Laadpositie herijken of Her-ankeren.": {
    en: "This is the channel from the zone to the charging station. The mower writes it itself when the charge position is saved and every other polygon is anchored to its first point, so it cannot be deleted. If the charging station moved, use Recalibrate charging pose or Re-anchor instead.",
    fr: "Il s'agit du canal entre la zone et la station de charge. La tondeuse l'écrit elle-même lorsque la position de charge est enregistrée et tous les autres polygones sont ancrés à son premier point, il ne peut donc pas être supprimé. Si la station de charge a été déplacée, utilisez plutôt Recalibrer la position de charge ou Réancrer.",
    de: "Dies ist der Kanal von der Zone zur Ladestation. Der Mäher schreibt ihn selbst, wenn die Ladeposition gespeichert wird, und jedes andere Polygon ist an seinem ersten Punkt verankert, daher kann er nicht gelöscht werden. Wurde die Ladestation versetzt, verwenden Sie stattdessen Ladeposition neu kalibrieren oder Neu verankern.",
  },
  "Download mislukt": {
    en: "Download failed",
    fr: "Échec du téléchargement",
    de: "Download fehlgeschlagen",
  },
  "E-mail en wachtwoord zijn verplicht": {
    en: "Email and password required",
    fr: "E-mail et mot de passe requis",
    de: "E-Mail und Passwort erforderlich",
  },
  "Een gebied tekenen": {
    en: "Drawing an area",
    fr: "Dessiner une zone",
    de: "Das Zeichnen eines Bereichs",
  },
  "Een gebied verplaatsen": {
    en: "Moving an area",
    fr: "Déplacer une zone",
    de: "Das Verschieben eines Bereichs",
  },
  "Een kanaal kan map{0} niet met zichzelf verbinden.": {
    en: "A channel cannot connect map{0} to itself.",
    fr: "Un canal ne peut pas relier map{0} à elle-même.",
    de: "Ein Kanal kann map{0} nicht mit sich selbst verbinden.",
  },
  "Een kanaal moet in het ene werkgebied beginnen en in een ander eindigen; een uiteinde ligt nu buiten elk gebied.": {
    en: "A channel must start in one work area and end in another; one end now lies outside every area.",
    fr: "Un canal doit commencer dans une zone de travail et finir dans une autre ; une extrémité est actuellement hors de toute zone.",
    de: "Ein Kanal muss in einem Arbeitsbereich beginnen und in einem anderen enden; ein Ende liegt jetzt außerhalb aller Bereiche.",
  },
  "Email en wachtwoord zijn verplicht": {
    en: "Email and password are required",
    fr: "L'e-mail et le mot de passe sont obligatoires",
    de: "E-Mail und Passwort sind erforderlich",
  },
  "Er bestaat al een gebruiker. Gebruik de inlogpagina.": {
    en: "A user already exists. Use the login page.",
    fr: "Un utilisateur existe déjà. Utilisez la page de connexion.",
    de: "Es gibt bereits einen Benutzer. Verwenden Sie die Anmeldeseite.",
  },
  "Er is geen werkgebied om dit obstakel aan te koppelen.": {
    en: "There is no work area to attach this obstacle to.",
    fr: "Il n'y a pas de zone de travail à laquelle rattacher cet obstacle.",
    de: "Es gibt keinen Arbeitsbereich, dem dieses Hindernis zugeordnet werden kann.",
  },
  "Er is nog geen werkgebied om dit aan te koppelen. Teken eerst een werkgebied.": {
    en: "There is no work area to attach this to yet. Draw a work area first.",
    fr: "Il n'y a pas encore de zone de travail à laquelle rattacher ceci. Dessinez d'abord une zone de travail.",
    de: "Es gibt noch keinen Arbeitsbereich, dem dies zugeordnet werden kann. Zeichnen Sie zuerst einen Arbeitsbereich.",
  },
  "Er loopt een maaitaak: generate_preview zou de maaier error 128 geven": {
    en: "coverage task active: generate_preview would error-128 the mower",
    fr: "Une tâche de tonte est en cours : generate_preview provoquerait l'erreur 128 sur la tondeuse",
    de: "Eine Mähaufgabe läuft: generate_preview würde beim Mäher Fehler 128 auslösen",
  },
  "Er stond geen maaitaak in de weg, dus dit komt van de maaier zelf.": {
    en: "No mowing task was in the way, so this comes from the mower itself.",
    fr: "Aucune tâche de tonte ne bloquait, cela vient donc de la tondeuse elle-même.",
    de: "Es stand keine Mähaufgabe im Weg, dies kommt also vom Mäher selbst.",
  },
  "Fout van de weer-API": {
    en: "Weather API error",
    fr: "Erreur de l'API météo",
    de: "Fehler der Wetter-API",
  },
  "Geen TCP socket voor {0}": {
    en: "No TCP socket for {0}",
    fr: "Aucun socket TCP pour {0}",
    de: "Kein TCP-Socket für {0}",
  },
  "Geen antwoord met het maaipad binnen de tijd": {
    en: "no plan path response within timeout",
    fr: "Aucune réponse avec le trajet de tonte dans le délai imparti",
    de: "Keine Antwort mit dem Mähpfad innerhalb der Zeit",
  },
  "Geen antwoord op mapping_preflight binnen 8 s (stock firmware?)": {
    en: "timeout waiting for mapping_preflight_respond (stock firmware?)",
    fr: "Aucune réponse à mapping_preflight dans les 8 s (firmware d'origine ?)",
    de: "Keine Antwort auf mapping_preflight innerhalb von 8 s (Standard-Firmware?)",
  },
  "Geen certificaat gevonden. Start eerst de container.": {
    en: "No certificate found. Start the container first.",
    fr: "Aucun certificat trouvé. Démarrez d'abord le conteneur.",
    de: "Kein Zertifikat gefunden. Starten Sie zuerst den Container.",
  },
  "Geen download URL geconfigureerd voor deze versie": {
    en: "No download URL configured for this version",
    fr: "Aucune URL de téléchargement configurée pour cette version",
    de: "Keine Download-URL für diese Version konfiguriert",
  },
  "Geen kaarten gevonden voor dit apparaat": {
    en: "No maps found for this device",
    fr: "Aucune carte trouvée pour cet appareil",
    de: "Keine Karten für dieses Gerät gefunden",
  },
  "Geen lokale gebruiker met dat e-mailadres: voer eerst /admin/import uit.": {
    en: "No local user with that email: run /admin/import first.",
    fr: "Aucun utilisateur local avec cet e-mail : exécutez d'abord /admin/import.",
    de: "Kein lokaler Benutzer mit dieser E-Mail: Führen Sie zuerst /admin/import aus.",
  },
  "Geen maaier gekoppeld aan dit account.": {
    en: "No mower bound to this account.",
    fr: "Aucune tondeuse associée à ce compte.",
    de: "Kein Mäher mit diesem Konto verknüpft.",
  },
  "Geen sensordata in de cache voor deze maaier": {
    en: "No sensor data cached for this mower",
    fr: "Aucune donnée de capteur en cache pour cette tondeuse",
    de: "Keine Sensordaten für diesen Mäher im Cache",
  },
  "Genereren van de preview mislukt": {
    en: "preview generation failed",
    fr: "Échec de la génération de l'aperçu",
    de: "Erstellen der Vorschau fehlgeschlagen",
  },
  "Grootte komt niet overeen: verwacht {0}, gekregen {1}": {
    en: "Size mismatch: expected {0}, got {1}",
    fr: "Taille non concordante : attendu {0}, obtenu {1}",
    de: "Größe stimmt nicht überein: erwartet {0}, erhalten {1}",
  },
  "Her-ankeren": {
    en: "Re-anchoring",
    fr: "Le réancrage",
    de: "Das Neuverankern",
  },
  "Het andere uiteinde ligt niet in een werkgebied. Laat het kanaal binnen een gebied eindigen.": {
    en: "The other end does not lie in a work area. Let the channel end inside an area.",
    fr: "L'autre extrémité n'est pas dans une zone de travail. Faites finir le canal à l'intérieur d'une zone.",
    de: "Das andere Ende liegt nicht in einem Arbeitsbereich. Lassen Sie den Kanal innerhalb eines Bereichs enden.",
  },
  "Deze fout vraagt de pincode van de maaier": {
    en: "This error needs the mower's PIN code",
    fr: "Cette erreur nécessite le code PIN de la tondeuse",
    de: "Dieser Fehler erfordert die PIN des Mähers",
  },
  "Deze fout verdwijnt pas na een herstart van de maaier; op stock firmware kan dat niet op afstand": {
    en: "This error only clears after a restart of the mower; on stock firmware that cannot be done remotely",
    fr: "Cette erreur ne disparaît qu'après un redémarrage de la tondeuse ; avec le firmware d'origine, cela ne peut pas se faire à distance",
    de: "Dieser Fehler verschwindet erst nach einem Neustart des Mähers; mit der Original-Firmware geht das nicht aus der Ferne",
  },
  "Naar een punt rijden": {
    en: "Driving to a point",
    fr: "Rouler jusqu'à un point",
    de: "Zu einem Punkt fahren",
  },
  "Het extended commando {0}": {
    en: "The extended command {0}",
    fr: "La commande étendue {0}",
    de: "Der erweiterte Befehl {0}",
  },
  "Het laadstation antwoordde niet (time-out)": {
    en: "Charger did not respond (timeout)",
    fr: "La station de charge n'a pas répondu (délai dépassé)",
    de: "Die Ladestation hat nicht geantwortet (Zeitüberschreitung)",
  },
  "Het wachtwoord moet minstens 6 tekens hebben": {
    en: "Password must be at least 6 characters",
    fr: "Le mot de passe doit comporter au moins 6 caractères",
    de: "Das Passwort muss mindestens 6 Zeichen lang sein",
  },
  "Import mislukt": {
    en: "Import failed",
    fr: "Échec de l'import",
    de: "Import fehlgeschlagen",
  },
  "Inloggen bij de cloud mislukt.": {
    en: "Cloud login failed.",
    fr: "Échec de la connexion au cloud.",
    de: "Anmeldung bei der Cloud fehlgeschlagen.",
  },
  "Inloggen mislukt": {
    en: "Login failed",
    fr: "Échec de la connexion",
    de: "Anmeldung fehlgeschlagen",
  },
  "Je kunt jezelf niet verwijderen": {
    en: "Cannot delete yourself",
    fr: "Vous ne pouvez pas vous supprimer vous-même",
    de: "Sie können sich nicht selbst löschen",
  },
  "Kaart niet gevonden": {
    en: "Map not found",
    fr: "Carte introuvable",
    de: "Karte nicht gefunden",
  },
  "Kaart terugzetten kan alleen als de maaier op het dock staat te laden.": {
    en: "The map can only be reverted while the mower is charging on the dock.",
    fr: "La carte ne peut être restaurée que lorsque la tondeuse est en charge sur le dock.",
    de: "Die Karte kann nur zurückgesetzt werden, während der Mäher auf dem Dock lädt.",
  },
  "Kaart wijzigen kan alleen als de maaier op het dock staat te laden.": {
    en: "The map can only be changed while the mower is charging on the dock.",
    fr: "La carte ne peut être modifiée que lorsque la tondeuse est en charge sur le dock.",
    de: "Die Karte kann nur geändert werden, während der Mäher auf dem Dock lädt.",
  },
  "Kaartbestanden terugzetten op de maaier vereist OpenNova custom firmware. Stock firmware ondersteunt write_map_files niet; gebruik alleen de import in de server-kopie, tenzij dezelfde kaarten al op de maaier staan.": {
    en: "Mower file restore requires OpenNova/custom firmware. Stock firmware does not support write_map_files; use server-copy import only unless the same maps already exist on the mower.",
    fr: "La restauration des fichiers sur la tondeuse nécessite le firmware personnalisé OpenNova. Le firmware d'origine ne prend pas en charge write_map_files ; utilisez uniquement l'import dans la copie du serveur, sauf si les mêmes cartes existent déjà sur la tondeuse.",
    de: "Das Wiederherstellen von Dateien auf dem Mäher erfordert die OpenNova-Custom-Firmware. Die Standard-Firmware unterstützt write_map_files nicht; verwenden Sie nur den Import in die Serverkopie, es sei denn, dieselben Karten sind bereits auf dem Mäher.",
  },
  "Kaartwijzigingen toepassen vereist OpenNova custom firmware. Gebruik op stock firmware \"Kaart bewerken\" in de app.": {
    en: "Applying map changes requires OpenNova custom firmware. On stock firmware, use \"Edit map\" in the app.",
    fr: "L'application des modifications de carte nécessite le firmware personnalisé OpenNova. Avec le firmware d'origine, utilisez « Modifier la carte » dans l'application.",
    de: "Das Anwenden von Kartenänderungen erfordert die OpenNova Custom-Firmware. Verwenden Sie bei der Standard-Firmware „Karte bearbeiten“ in der App.",
  },
  "Kon ZIP niet parsen": {
    en: "Could not parse ZIP",
    fr: "Impossible d'analyser le ZIP",
    de: "ZIP konnte nicht gelesen werden",
  },
  "Kon backup-gate niet uitvoeren": {
    en: "Could not run the backup gate",
    fr: "Impossible d'exécuter la vérification de sauvegarde",
    de: "Die Backup-Prüfung konnte nicht ausgeführt werden",
  },
  "Kon gebruiker niet aanmaken": {
    en: "Could not create user",
    fr: "Impossible de créer l'utilisateur",
    de: "Benutzer konnte nicht erstellt werden",
  },
  "Kon geen backup maken voor {0} terwijl er kaarten zijn, dus het flashen is geblokkeerd. Forceer alleen als je accepteert dat de kaarten niet geback-upt zijn.": {
    en: "Could not make a backup for {0} while there are maps, so flashing is blocked. Force only if you accept that the maps are not backed up.",
    fr: "Impossible de sauvegarder {0} alors qu'il y a des cartes, le flashage est donc bloqué. Ne forcez que si vous acceptez que les cartes ne soient pas sauvegardées.",
    de: "Für {0} konnte kein Backup erstellt werden, obwohl Karten vorhanden sind, daher ist das Flashen blockiert. Erzwingen Sie es nur, wenn Sie akzeptieren, dass die Karten nicht gesichert sind.",
  },
  "Laadstation niet gevonden in de LoRa-cache": {
    en: "Charger not found in LoRa cache",
    fr: "Station de charge introuvable dans le cache LoRa",
    de: "Ladestation nicht im LoRa-Cache gefunden",
  },
  "Laadstation niet gevonden in de LoRa-cache: richt eerst het laadstation in": {
    en: "Charger not found in LoRa cache: provision the charger first",
    fr: "Station de charge introuvable dans le cache LoRa : configurez d'abord la station de charge",
    de: "Ladestation nicht im LoRa-Cache gefunden: Richten Sie zuerst die Ladestation ein",
  },
  "Lijn kruist zichzelf": {
    en: "Line crosses itself",
    fr: "La ligne se croise elle-même",
    de: "Die Linie kreuzt sich selbst",
  },
  "LoRa-instellingen van de maaier uitlezen": {
    en: "Reading the mower's LoRa settings",
    fr: "Lire les paramètres LoRa de la tondeuse",
    de: "Das Auslesen der LoRa-Einstellungen des Mähers",
  },
  "LoRa-instellingen van de maaier zetten": {
    en: "Setting the mower's LoRa settings",
    fr: "Définir les paramètres LoRa de la tondeuse",
    de: "Das Setzen der LoRa-Einstellungen des Mähers",
  },
  "Lokaal account aangemaakt. Koppel je maaier via de Novabot-app.": {
    en: "Local account created. Bind your mower via the Novabot app.",
    fr: "Compte local créé. Associez votre tondeuse via l'application Novabot.",
    de: "Lokales Konto erstellt. Koppeln Sie Ihren Mäher über die Novabot-App.",
  },
  "Lukt het niet, dan kan de kaart alleen in het dashboard worden verwijderd (forceren).": {
    en: "If that does not work, the map can only be removed in the dashboard (force).",
    fr: "Si cela ne fonctionne pas, la carte ne peut être supprimée que dans le tableau de bord (forcer).",
    de: "Wenn das nicht klappt, kann die Karte nur im Dashboard entfernt werden (erzwingen).",
  },
  "MD5 komt niet overeen: verwacht {0}, gekregen {1}": {
    en: "MD5 mismatch: expected {0}, got {1}",
    fr: "MD5 non concordant : attendu {0}, obtenu {1}",
    de: "MD5 stimmt nicht überein: erwartet {0}, erhalten {1}",
  },
  "Maaier IP onbekend": {
    en: "Mower IP unknown",
    fr: "Adresse IP de la tondeuse inconnue",
    de: "IP des Mähers unbekannt",
  },
  "Maaier meldt: {0}": {
    en: "Mower reports: {0}",
    fr: "La tondeuse signale : {0}",
    de: "Der Mäher meldet: {0}",
  },
  "Maaier niet gevonden in equipment": {
    en: "Mower not found in equipment",
    fr: "Tondeuse introuvable dans les équipements",
    de: "Mäher nicht in den Geräten gefunden",
  },
  "Maaier offline: verwijderen vereist een online maaier, zodat die de kaart van zijn schijf kan wissen": {
    en: "mower offline: delete needs an online mower so it can wipe the map from disk",
    fr: "Tondeuse hors ligne : la suppression nécessite une tondeuse en ligne pour effacer la carte de son disque",
    de: "Mäher offline: Zum Löschen muss der Mäher online sein, damit er die Karte von seinem Speicher löschen kann",
  },
  "Manifest ophalen mislukt": {
    en: "Failed to fetch manifest",
    fr: "Échec de la récupération du manifeste",
    de: "Abruf des Manifests fehlgeschlagen",
  },
  "Minimaal 3 punten nodig": {
    en: "At least 3 points needed",
    fr: "Au moins 3 points sont nécessaires",
    de: "Mindestens 3 Punkte erforderlich",
  },
  "Nieuw tekenen kan alleen als obstakel met parentMap": {
    en: "New drawings are only possible as an obstacle with parentMap",
    fr: "Un nouveau tracé n'est possible que comme obstacle avec parentMap",
    de: "Neu zeichnen ist nur als Hindernis mit parentMap möglich",
  },
  "OTA versie niet gevonden": {
    en: "OTA version not found",
    fr: "Version OTA introuvable",
    de: "OTA-Version nicht gefunden",
  },
  "Obstakel steekt buiten {0}": {
    en: "Obstacle extends outside {0}",
    fr: "L'obstacle dépasse de {0}",
    de: "Hindernis ragt über {0} hinaus",
  },
  "Onbekende kaart {0}": {
    en: "Unknown map {0}",
    fr: "Carte inconnue {0}",
    de: "Unbekannte Karte {0}",
  },
  "Onbekende werkkaart {0}": {
    en: "Unknown work map {0}",
    fr: "Carte de travail inconnue {0}",
    de: "Unbekannte Arbeitskarte {0}",
  },
  "Ongeldige maaigebiedcode.": {
    en: "Invalid mowing area code.",
    fr: "Code de zone de tonte non valide.",
    de: "Ungültiger Mähbereichscode.",
  },
  "Ongeldige pose: x={0} y={1} theta={2}": {
    en: "Invalid pose: x={0} y={1} theta={2}",
    fr: "Pose non valide : x={0} y={1} theta={2}",
    de: "Ungültige Pose: x={0} y={1} theta={2}",
  },
  "Ongeldige rol. Geldig: {0}": {
    en: "Invalid role. Valid: {0}",
    fr: "Rôle non valide. Valides : {0}",
    de: "Ungültige Rolle. Gültig: {0}",
  },
  "Ophalen van het preview-pad duurde te lang (15 s): de kaart is misschien groot of traag, of de maaier gaf het pad niet op tijd terug": {
    en: "preview path fetch timed out (15s): the map may be large/slow to serialise, or the mower did not return the path in time",
    fr: "La récupération du trajet d'aperçu a expiré (15 s) : la carte est peut-être grande ou lente, ou la tondeuse n'a pas renvoyé le trajet à temps",
    de: "Abruf des Vorschaupfads hat zu lange gedauert (15 s): Die Karte ist vielleicht groß oder langsam, oder der Mäher hat den Pfad nicht rechtzeitig geliefert",
  },
  "Oppervlak kleiner dan {0} m²": {
    en: "Area smaller than {0} m²",
    fr: "Surface inférieure à {0} m²",
    de: "Fläche kleiner als {0} m²",
  },
  "PIN moet 4 cijfers zijn": {
    en: "PIN must be 4 digits",
    fr: "Le code PIN doit comporter 4 chiffres",
    de: "Die PIN muss 4 Ziffern haben",
  },
  "PIN verifiëren": {
    en: "Verifying the PIN",
    fr: "Vérifier le code PIN",
    de: "Das Überprüfen der PIN",
  },
  "Positie van het laadstation onbekend": {
    en: "Charging station position unknown",
    fr: "Position de la station de charge inconnue",
    de: "Position der Ladestation unbekannt",
  },
  "Positie van het laadstation onbekend: plaats eerst het laadstation op de kaart": {
    en: "Charging station position unknown: place the charging station on the map first",
    fr: "Position de la station de charge inconnue : placez d'abord la station de charge sur la carte",
    de: "Position der Ladestation unbekannt: Platzieren Sie zuerst die Ladestation auf der Karte",
  },
  "Provisioning is al bezig": {
    en: "Provisioning already in progress",
    fr: "Un provisionnement est déjà en cours",
    de: "Die Einrichtung läuft bereits",
  },
  "RTK FIX vereist op het dock: loc_quality={0}": {
    en: "RTK FIX required at dock: loc_quality={0}",
    fr: "RTK FIX requis sur le dock : loc_quality={0}",
    de: "RTK FIX im Dock erforderlich: loc_quality={0}",
  },
  "Randmaaien op schemadagen": {
    en: "Edge cutting on schedule days",
    fr: "La coupe des bordures les jours planifiés",
    de: "Das Kantenmähen an geplanten Tagen",
  },
  "SHA256 komt niet overeen: verwacht {0}, gekregen {1}": {
    en: "SHA256 mismatch: expected {0}, got {1}",
    fr: "SHA256 non concordant : attendu {0}, obtenu {1}",
    de: "SHA256 stimmt nicht überein: erwartet {0}, erhalten {1}",
  },
  "Schedule en parameters verstuurd naar maaier": {
    en: "Schedule and parameters sent to mower",
    fr: "Planning et paramètres envoyés à la tondeuse",
    de: "Zeitplan und Parameter an den Mäher gesendet",
  },
  "Schedule niet gevonden": {
    en: "Schedule not found",
    fr: "Planning introuvable",
    de: "Zeitplan nicht gefunden",
  },
  "Soft restart": {
    en: "Soft restart",
    fr: "Le redémarrage logiciel",
    de: "Der Soft-Neustart",
  },
  "Soft restart verstuurd; de maaier gaat ~30-60 s offline en komt dan terug": {
    en: "soft restart dispatched; the mower goes offline ~30-60s then returns",
    fr: "Redémarrage logiciel envoyé ; la tondeuse passe hors ligne ~30-60 s puis revient",
    de: "Soft-Neustart gesendet; der Mäher geht ~30-60 s offline und kommt dann zurück",
  },
  "Stock firmware heeft een rit van het dock en terug nodig voordat de lokalisatie geldig is. Zolang de maaier bij het opstarten gedockt staat, is map_position altijd nul.": {
    en: "Stock firmware needs a drive-back cycle before localization is valid. While docked at boot, map_position is always zero.",
    fr: "Le firmware d'origine a besoin d'un aller-retour depuis le dock avant que la localisation soit valide. Tant que la tondeuse est sur le dock au démarrage, map_position vaut toujours zéro.",
    de: "Die Standard-Firmware braucht eine Fahrt vom Dock weg und zurück, bevor die Lokalisierung gültig ist. Solange der Mäher beim Start angedockt ist, ist map_position immer null.",
  },
  "Stop de lopende of gepauzeerde maaitaak en probeer het opnieuw.": {
    en: "Stop the running or paused mowing task and try again.",
    fr: "Arrêtez la tâche de tonte en cours ou en pause et réessayez.",
    de: "Beenden Sie die laufende oder pausierte Mähaufgabe und versuchen Sie es erneut.",
  },
  "Unicom-paden zijn niet bewerkbaar": {
    en: "Unicom paths cannot be edited",
    fr: "Les chemins unicom ne sont pas modifiables",
    de: "Unicom-Pfade können nicht bearbeitet werden",
  },
  "Updatecontrole mislukt": {
    en: "update check failed",
    fr: "Échec de la vérification des mises à jour",
    de: "Update-Prüfung fehlgeschlagen",
  },
  "Upload import mislukt": {
    en: "Upload import failed",
    fr: "Échec de l'import du fichier envoyé",
    de: "Import des Uploads fehlgeschlagen",
  },
  "Verdachte pose: x en y zijn exact gelijk ({0}). De firmware van de maaier meldt een onjuiste lokalisatie. Wacht op een verse timer_data-update en probeer het opnieuw.": {
    en: "Suspicious pose: x and y are exactly equal ({0}). Mower firmware is reporting bogus localization. Wait for a fresh timer_data update and retry.",
    fr: "Pose suspecte : x et y sont exactement égaux ({0}). Le firmware de la tondeuse signale une localisation erronée. Attendez une nouvelle mise à jour timer_data et réessayez.",
    de: "Verdächtige Pose: x und y sind exakt gleich ({0}). Die Firmware des Mähers meldet eine fehlerhafte Lokalisierung. Warten Sie auf ein neues timer_data-Update und versuchen Sie es erneut.",
  },
  "Verschuiving groter dan {0} m: buiten ooit gescand gebied is het navigatiegedrag onbewezen": {
    en: "Displacement larger than {0} m: outside the area that was ever scanned, navigation behaviour is unproven",
    fr: "Déplacement supérieur à {0} m : hors de la zone déjà scannée, le comportement de navigation n'est pas éprouvé",
    de: "Verschiebung größer als {0} m: außerhalb des jemals gescannten Bereichs ist das Navigationsverhalten unerprobt",
  },
  "Weerdata ophalen mislukt": {
    en: "Weather fetch failed",
    fr: "Échec de la récupération de la météo",
    de: "Abruf der Wetterdaten fehlgeschlagen",
  },
  "ZIP-generatie mislukt": {
    en: "ZIP generation failed",
    fr: "Échec de la génération du ZIP",
    de: "ZIP-Erstellung fehlgeschlagen",
  },
  "apparaat niet online": {
    en: "device not online",
    fr: "appareil hors ligne",
    de: "Gerät nicht online",
  },
  "apparaat offline": {
    en: "device offline",
    fr: "appareil hors ligne",
    de: "Gerät offline",
  },
  "backup niet gevonden": {
    en: "backup not found",
    fr: "sauvegarde introuvable",
    de: "Backup nicht gefunden",
  },
  "backup-ZIP kon niet worden gelezen": {
    en: "failed to parse backup ZIP",
    fr: "impossible de lire le ZIP de sauvegarde",
    de: "Backup-ZIP konnte nicht gelesen werden",
  },
  "bundel lezen mislukt: {0}": {
    en: "failed to read bundle: {0}",
    fr: "échec de la lecture du bundle : {0}",
    de: "Bundle konnte nicht gelesen werden: {0}",
  },
  "bundel niet gevonden": {
    en: "bundle not found",
    fr: "bundle introuvable",
    de: "Bundle nicht gefunden",
  },
  "bundelbestand ontbreekt op schijf": {
    en: "bundle file missing on disk",
    fr: "fichier du bundle absent du disque",
    de: "Bundle-Datei fehlt auf dem Datenträger",
  },
  "cfg_value (number) is vereist": {
    en: "cfg_value (number) is required",
    fr: "cfg_value (nombre) est requis",
    de: "cfg_value (Zahl) ist erforderlich",
  },
  "cluster niet gevonden": {
    en: "cluster not found",
    fr: "cluster introuvable",
    de: "Cluster nicht gefunden",
  },
  "command is vereist": {
    en: "command is required",
    fr: "command est requis",
    de: "command ist erforderlich",
  },
  "command object is vereist": {
    en: "command object is required",
    fr: "l'objet command est requis",
    de: "command-Objekt ist erforderlich",
  },
  "data (base64 ZIP) is vereist": {
    en: "data (base64 ZIP) is required",
    fr: "data (ZIP en base64) est requis",
    de: "data (Base64-ZIP) ist erforderlich",
  },
  "de fabriekstabel met MAC-prefixen is leeg, dus apparaten zijn niet te herkennen": {
    en: "the factory table with MAC prefixes is empty, so devices cannot be recognised",
    fr: "la table d'usine des préfixes MAC est vide, les appareils ne peuvent donc pas être reconnus",
    de: "die Werkstabelle mit MAC-Präfixen ist leer, daher können Geräte nicht erkannt werden",
  },
  "de maaier is bezig (work_status {0}); een soft restart mag alleen als hij stilstaat of laadt": {
    en: "mower is busy (work_status {0}); soft restart is only allowed when idle or charging",
    fr: "la tondeuse est occupée (work_status {0}) ; un redémarrage logiciel n'est autorisé qu'à l'arrêt ou en charge",
    de: "der Mäher ist beschäftigt (work_status {0}); ein Soft-Restart ist nur im Leerlauf oder beim Laden erlaubt",
  },
  "de server draaide niet om {0}": {
    en: "server was not running at {0}",
    fr: "le serveur ne tournait pas à {0}",
    de: "der Server lief um {0} nicht",
  },
  "de straal moet een getal tussen {0} en {1} meter zijn": {
    en: "radius must be a number between {0} and {1} meters",
    fr: "le rayon doit être un nombre entre {0} et {1} mètres",
    de: "der Radius muss eine Zahl zwischen {0} und {1} Metern sein",
  },
  "de zip bevat geen .csv- of map_info.json-bestanden": {
    en: "zip contains no .csv / map_info.json files",
    fr: "le zip ne contient aucun fichier .csv ou map_info.json",
    de: "die ZIP enthält keine .csv- oder map_info.json-Dateien",
  },
  "deze container zit achter een Docker-bridge en kan het thuisnetwerk niet inzien": {
    en: "this container sits behind a Docker bridge and cannot see the home network",
    fr: "ce conteneur est derrière un Docker bridge et ne peut pas voir le réseau domestique",
    de: "dieser Container läuft hinter einer Docker-bridge und kann das Heimnetzwerk nicht sehen",
  },
  "direction, origin, en points zijn vereist": {
    en: "direction, origin and points are required",
    fr: "direction, origin et points sont requis",
    de: "direction, origin und points sind erforderlich",
  },
  "dnsmasq stopte niet (draait nog na SIGKILL).": {
    en: "dnsmasq did not stop (still running after SIGKILL).",
    fr: "dnsmasq ne s'est pas arrêté (toujours actif après SIGKILL).",
    de: "dnsmasq wurde nicht beendet (läuft nach SIGKILL noch).",
  },
  "een walker-bundel vereist een live map_position van de maaier (online en gedockt)": {
    en: "walker bundle requires a live map_position from the mower (online and docked)",
    fr: "un bundle walker nécessite une map_position en direct de la tondeuse (en ligne et sur le dock)",
    de: "ein Walker-Bundle erfordert eine Live-map_position vom Mäher (online und angedockt)",
  },
  "email, password en charger.sn zijn verplicht": {
    en: "email, password and charger.sn are required",
    fr: "email, password et charger.sn sont obligatoires",
    de: "email, password und charger.sn sind erforderlich",
  },
  "er loopt al een import": {
    en: "active import already in progress",
    fr: "un import est déjà en cours",
    de: "es läuft bereits ein Import",
  },
  "er loopt al een import ({0})": {
    en: "active import already in progress ({0})",
    fr: "un import est déjà en cours ({0})",
    de: "es läuft bereits ein Import ({0})",
  },
  "er loopt al een import voor die maaier": {
    en: "active import already in progress for that mower",
    fr: "un import est déjà en cours pour cette tondeuse",
    de: "für diesen Mäher läuft bereits ein Import",
  },
  "foto niet gevonden": {
    en: "photo not found",
    fr: "photo introuvable",
    de: "Foto nicht gefunden",
  },
  "geen GPS in de sensorcache": {
    en: "no GPS in sensor cache",
    fr: "pas de GPS dans le cache des capteurs",
    de: "kein GPS im Sensor-Cache",
  },
  "geen JPEG of PNG": {
    en: "not a JPEG or PNG",
    fr: "ce n'est pas un JPEG ni un PNG",
    de: "kein JPEG oder PNG",
  },
  "geen enkel apparaat zichtbaar op het lokale netwerk": {
    en: "no device at all visible on the local network",
    fr: "aucun appareil visible sur le réseau local",
    de: "kein einziges Gerät im lokalen Netzwerk sichtbar",
  },
  "geen geldig GLB-bestand": {
    en: "not a valid GLB file",
    fr: "fichier GLB non valide",
    de: "keine gültige GLB-Datei",
  },
  "geen grasrand gevonden op startpunt": {
    en: "no lawn edge found at the starting point",
    fr: "aucune bordure de pelouse trouvée au point de départ",
    de: "keine Rasenkante am Startpunkt gefunden",
  },
  "geen kaarten": {
    en: "no maps",
    fr: "aucune carte",
    de: "keine Karten",
  },
  "geen live map_position in de sensorcache; is de maaier online en gedockt?": {
    en: "no live map_position in sensor cache; is the mower online and docked?",
    fr: "aucune map_position en direct dans le cache des capteurs ; la tondeuse est-elle en ligne et sur le dock ?",
    de: "keine Live-map_position im Sensor-Cache; ist der Mäher online und angedockt?",
  },
  "geen luchtfoto op de bronmaaier": {
    en: "no overlay on the source mower",
    fr: "aucune photo aérienne sur la tondeuse source",
    de: "kein Luftbild auf dem Quellmäher",
  },
  "geen luchtfoto voor deze maaier": {
    en: "no overlay for this mower",
    fr: "aucune photo aérienne pour cette tondeuse",
    de: "kein Luftbild für diesen Mäher",
  },
  "geen map*_work.csv gevonden in de zip": {
    en: "no map*_work.csv found in zip",
    fr: "aucun map*_work.csv trouvé dans le zip",
    de: "keine map*_work.csv in der ZIP gefunden",
  },
  "geen map_position in de sensorcache": {
    en: "no map_position in sensor cache",
    fr: "pas de map_position dans le cache des capteurs",
    de: "keine map_position im Sensor-Cache",
  },
  "geen netwerkadres op deze server": {
    en: "no network address on this server",
    fr: "aucune adresse réseau sur ce serveur",
    de: "keine Netzwerkadresse auf diesem Server",
  },
  "geen objecten voor deze maaier": {
    en: "no objects for this mower",
    fr: "aucun objet pour cette tondeuse",
    de: "keine Objekte für diesen Mäher",
  },
  "geen terrein voor deze maaier": {
    en: "no terrain for this mower",
    fr: "aucun terrain pour cette tondeuse",
    de: "kein Gelände für diesen Mäher",
  },
  "get_map_list gestuurd naar {0}": {
    en: "get_map_list sent to {0}",
    fr: "get_map_list envoyé à {0}",
    de: "get_map_list an {0} gesendet",
  },
  "get_map_outline gestuurd naar {0} voor kaart {1}": {
    en: "get_map_outline sent to {0} for map {1}",
    fr: "get_map_outline envoyé à {0} pour la carte {1}",
    de: "get_map_outline an {0} für Karte {1} gesendet",
  },
  "import in de server-kopie mislukt: {0}": {
    en: "server-copy import failed: {0}",
    fr: "échec de l'import dans la copie serveur : {0}",
    de: "Import in die Serverkopie fehlgeschlagen: {0}",
  },
  "maaier bezig: er loopt al een taak": {
    en: "mower busy: already in a task",
    fr: "tondeuse occupée : une tâche est déjà en cours",
    de: "Mäher beschäftigt: es läuft bereits eine Aufgabe",
  },
  "maaier offline": {
    en: "mower offline",
    fr: "tondeuse hors ligne",
    de: "Mäher offline",
  },
  "maaier offline: het masker wordt live van de maaier gelezen": {
    en: "mower offline: the mask is read live from the mower",
    fr: "tondeuse hors ligne : le masque est lu en direct sur la tondeuse",
    de: "Mäher offline: die Maske wird live vom Mäher gelesen",
  },
  "maaier staat niet op het dock: battery_state={0} (CHARGING nodig)": {
    en: "mower not on dock: battery_state={0} (need CHARGING)",
    fr: "la tondeuse n'est pas sur le dock : battery_state={0} (CHARGING requis)",
    de: "der Mäher steht nicht im Dock: battery_state={0} (CHARGING erforderlich)",
  },
  "maaier {0} is niet gekoppeld op deze server": {
    en: "mower {0} not bound on this server",
    fr: "la tondeuse {0} n'est pas associée sur ce serveur",
    de: "Mäher {0} ist auf diesem Server nicht gekoppelt",
  },
  "macAddress moet het formaat AA:BB:CC:DD:EE:FF hebben": {
    en: "macAddress must be in format AA:BB:CC:DD:EE:FF",
    fr: "macAddress doit être au format AA:BB:CC:DD:EE:FF",
    de: "macAddress muss das Format AA:BB:CC:DD:EE:FF haben",
  },
  "mapArea met minimaal {0} punten is vereist": {
    en: "mapArea with at least {0} points is required",
    fr: "mapArea avec au moins {0} points est requis",
    de: "mapArea mit mindestens {0} Punkten ist erforderlich",
  },
  "mapId is vereist": {
    en: "mapId is required",
    fr: "mapId est requis",
    de: "mapId ist erforderlich",
  },
  "map{0} bestaat al.": {
    en: "map{0} already exists.",
    fr: "map{0} existe déjà.",
    de: "map{0} existiert bereits.",
  },
  "map{0} bestaat niet.": {
    en: "map{0} does not exist.",
    fr: "map{0} n'existe pas.",
    de: "map{0} existiert nicht.",
  },
  "model niet gevonden": {
    en: "model not found",
    fr: "modèle introuvable",
    de: "Modell nicht gefunden",
  },
  "naam bestaat al": {
    en: "name already exists",
    fr: "ce nom existe déjà",
    de: "Name existiert bereits",
  },
  "naam vereist": {
    en: "name required",
    fr: "nom requis",
    de: "Name erforderlich",
  },
  "nachtbewaking: tussen zonsondergang en zonsopgang": {
    en: "night guard: between sunset and sunrise",
    fr: "protection nocturne : entre le coucher et le lever du soleil",
    de: "Nachtschutz: zwischen Sonnenuntergang und Sonnenaufgang",
  },
  "objectdata corrupt": {
    en: "object data corrupt",
    fr: "données d'objets corrompues",
    de: "Objektdaten beschädigt",
  },
  "onbekend model": {
    en: "unknown model",
    fr: "modèle inconnu",
    de: "unbekanntes Modell",
  },
  "onbekende className": {
    en: "unknown className",
    fr: "className inconnu",
    de: "unbekannter className",
  },
  "onbekende staging-sessie": {
    en: "unknown staging session",
    fr: "session de staging inconnue",
    de: "unbekannte Staging-Sitzung",
  },
  "opnieuw opbouwen mislukt (geen werkpolygoon of laadstation-anker in de database)": {
    en: "rebuild failed (no work polygon or charger anchor in DB)",
    fr: "échec de la reconstruction (aucun polygone de travail ni ancre de station de charge dans la base)",
    de: "Neuaufbau fehlgeschlagen (kein Arbeitspolygon oder Ladestations-Anker in der Datenbank)",
  },
  "overgeslagen door de gebruiker ({0})": {
    en: "user skipped {0}",
    fr: "ignoré par l'utilisateur ({0})",
    de: "vom Benutzer übersprungen ({0})",
  },
  "plaatsing vereist hoeken (4 x lat/lng, 1 tot 3000 m uit elkaar) en dekking (0 tot 1)": {
    en: "placement needs corners (4 x lat/lng, 1 to 3000 m apart) and opacity (0 to 1)",
    fr: "le placement nécessite des coins (4 x lat/lng, espacés de 1 à 3000 m) et une opacité (0 à 1)",
    de: "die Platzierung benötigt Ecken (4 x lat/lng, 1 bis 3000 m auseinander) und eine Deckkraft (0 bis 1)",
  },
  "regen verwacht (weercheck voor de start)": {
    en: "rain expected (pre-start weather check)",
    fr: "pluie prévue (vérification météo avant le départ)",
    de: "Regen erwartet (Wetterprüfung vor dem Start)",
  },
  "staging-bundel lezen mislukt: {0}": {
    en: "failed to read staging bundle: {0}",
    fr: "échec de la lecture du bundle de staging : {0}",
    de: "Staging-Bundle konnte nicht gelesen werden: {0}",
  },
  "startTime is vereist": {
    en: "startTime is required",
    fr: "startTime est requis",
    de: "startTime ist erforderlich",
  },
  "stuur de afbeelding als ruwe request-body": {
    en: "send the image as the raw request body",
    fr: "envoyez l'image comme corps brut de la requête",
    de: "senden Sie das Bild als rohen Request-Body",
  },
  "targetMac moet het formaat AA:BB:CC:DD:EE:FF hebben": {
    en: "targetMac must be in format AA:BB:CC:DD:EE:FF",
    fr: "targetMac doit être au format AA:BB:CC:DD:EE:FF",
    de: "targetMac muss das Format AA:BB:CC:DD:EE:FF haben",
  },
  "targetMac, wifiSsid en wifiPassword zijn verplicht": {
    en: "targetMac, wifiSsid, and wifiPassword are required",
    fr: "targetMac, wifiSsid et wifiPassword sont requis",
    de: "targetMac, wifiSsid und wifiPassword sind erforderlich",
  },
  "terreindata corrupt": {
    en: "terrain data corrupt",
    fr: "données de terrain corrompues",
    de: "Geländedaten beschädigt",
  },
  "upload eerst een foto": {
    en: "upload a photo first",
    fr: "téléversez d'abord une photo",
    de: "laden Sie zuerst ein Foto hoch",
  },
  "vereist OpenNova custom firmware": {
    en: "requires OpenNova custom firmware",
    fr: "nécessite le firmware personnalisé OpenNova",
    de: "erfordert die OpenNova-Custom-Firmware",
  },
  "verkeerde status {0}": {
    en: "wrong state {0}",
    fr: "état incorrect {0}",
    de: "falscher Status {0}",
  },
  "version is vereist (of upload een firmware bestand met versie-info)": {
    en: "version is required (or upload a firmware file with version info)",
    fr: "version est requis (ou envoyez un fichier firmware avec des informations de version)",
    de: "version ist erforderlich (oder laden Sie eine Firmware-Datei mit Versionsinfo hoch)",
  },
  "version_id is vereist": {
    en: "version_id is required",
    fr: "version_id est requis",
    de: "version_id ist erforderlich",
  },
  "vorstbewaking: onder {0}°C": {
    en: "frost guard: below {0}°C",
    fr: "protection antigel : en dessous de {0} °C",
    de: "Frostschutz: unter {0} °C",
  },
  "walker-bundel omzetten mislukt: {0}": {
    en: "walker bundle synth failed: {0}",
    fr: "échec de la conversion du bundle walker : {0}",
    de: "Umwandlung des Walker-Bundles fehlgeschlagen: {0}",
  },
  "zipPath is vereist": {
    en: "zipPath is required",
    fr: "zipPath est requis",
    de: "zipPath ist erforderlich",
  },
  "{0} (gebied={1} hoogte={2} cm)": {
    en: "{0} (area={1} height={2}cm)",
    fr: "{0} (zone={1} hauteur={2} cm)",
    de: "{0} (Bereich={1} Höhe={2} cm)",
  },
  "{0} bestaat al.": {
    en: "{0} already exists.",
    fr: "{0} existe déjà.",
    de: "{0} existiert bereits.",
  },
  "{0} vereist OpenNova custom firmware; stock firmware kan dit commando niet ontvangen.": {
    en: "{0} requires OpenNova custom firmware; stock firmware cannot receive this command.",
    fr: "{0} nécessite le firmware personnalisé OpenNova ; le firmware d'origine ne peut pas recevoir cette commande.",
    de: "{0} erfordert die OpenNova Custom-Firmware; die Standard-Firmware kann diesen Befehl nicht empfangen.",
  },
  "De aangewezen plek ligt meer dan {0} m van het dock van deze maaier.": {
    en: "The chosen spot is more than {0} m from this mower's dock.",
    fr: "L'emplacement choisi est à plus de {0} m de la station de cette tondeuse.",
    de: "Die gewählte Stelle liegt mehr als {0} m vom Dock dieses Mähers entfernt.",
  },
  "De bronmaaier heeft geen dock-anker (geen map0tocharge_unicom en niet gedockt online); zonder anker is de zone niet te plaatsen.": {
    en: "The source mower has no dock anchor (no map0tocharge_unicom and not docked online); without an anchor the zone cannot be placed.",
    fr: "La tondeuse source n'a pas d'ancre de station (pas de map0tocharge_unicom et pas amarrée en ligne) ; sans ancre la zone ne peut pas être placée.",
    de: "Der Quellmäher hat keinen Dock-Anker (kein map0tocharge_unicom und nicht online angedockt); ohne Anker lässt sich die Zone nicht platzieren.",
  },
  "Geef de positie van het laadstation van de bronmaaier op deze kaart (dockAtB.x/y).": {
    en: "Give the position of the source mower's charging station on this map (dockAtB.x/y).",
    fr: "Indiquez la position de la station de charge de la tondeuse source sur cette carte (dockAtB.x/y).",
    de: "Geben Sie die Position der Ladestation des Quellmähers auf dieser Karte an (dockAtB.x/y).",
  },
  "Het dock van deze maaier is onbekend: zet de maaier op het dock of teken eerst een dockkanaal.": {
    en: "This mower's dock is unknown: put the mower on the dock or draw a dock channel first.",
    fr: "La station de cette tondeuse est inconnue : placez la tondeuse sur la station ou tracez d'abord un couloir vers la station.",
    de: "Das Dock dieses Mähers ist unbekannt: Mäher aufs Dock stellen oder zuerst einen Dockkanal zeichnen.",
  },
  "Het werkgebied is kleiner dan {0} m².": {
    en: "The work area is smaller than {0} m².",
    fr: "La zone de travail fait moins de {0} m².",
    de: "Der Arbeitsbereich ist kleiner als {0} m².",
  },
  "Kies een werkgebied (map0, map1, ...) om te kopiëren.": {
    en: "Choose a work area (map0, map1, ...) to copy.",
    fr: "Choisissez une zone de travail (map0, map1, ...) à copier.",
    de: "Wählen Sie einen Arbeitsbereich (map0, map1, ...) zum Kopieren.",
  },
  "Werkgebied {0} van maaier {1} niet gevonden.": {
    en: "Work area {0} of mower {1} not found.",
    fr: "Zone de travail {0} de la tondeuse {1} introuvable.",
    de: "Arbeitsbereich {0} von Mäher {1} nicht gefunden.",
  },
  "De zone ligt meer dan {0} m van het dock; als eerste zone moet ze bij het dock liggen, anders kan er geen dockkanaal gemaakt worden.": {
    en: "The zone is more than {0} m from the dock; as the first zone it must sit near the dock, otherwise no dock channel can be made.",
    fr: "La zone est à plus de {0} m de la station ; en tant que première zone elle doit être proche de la station, sinon aucun couloir vers la station ne peut être créé.",
    de: "Die Zone liegt mehr als {0} m vom Dock entfernt; als erste Zone muss sie nahe am Dock liegen, sonst kann kein Dockkanal angelegt werden.",
  },
  "Deze maaier heeft al vijf werkgebieden (map0 t/m map4); de firmware kan er niet meer aan.": {
    en: "This mower already has five work areas (map0 to map4); the firmware cannot run more.",
    fr: "Cette tondeuse a déjà cinq zones de travail (map0 à map4) ; le firmware n'en gère pas davantage.",
    de: "Dieser Mäher hat bereits fünf Arbeitsbereiche (map0 bis map4); die Firmware kann nicht mehr verarbeiten.",
  },
  "Een zone kopiëren": {
    en: "Copying a zone",
    fr: "Copier une zone",
    de: "Eine Zone kopieren",
  },
  "Het dockkanaal zou door een obstakel lopen; verwijder dat obstakel na het kopiëren of kies een andere zone.": {
    en: "The dock channel would run through an obstacle; remove that obstacle after copying or choose another zone.",
    fr: "Le couloir vers la station traverserait un obstacle ; supprimez cet obstacle après la copie ou choisissez une autre zone.",
    de: "Der Dockkanal würde durch ein Hindernis verlaufen; entfernen Sie das Hindernis nach dem Kopieren oder wählen Sie eine andere Zone.",
  },
  "kopie": {
    en: "copy",
    fr: "copie",
    de: "Kopie",
  },
  "Maaier offline: kopiëren vereist een online maaier, zodat die de nieuwe zone meteen ontvangt.": {
    en: "Mower offline: copying needs an online mower so it receives the new zone right away.",
    fr: "Tondeuse hors ligne : la copie nécessite une tondeuse en ligne pour qu'elle reçoive la nouvelle zone immédiatement.",
    de: "Mäher offline: Kopieren braucht einen Online-Mäher, damit er die neue Zone sofort erhält.",
  },
  "De kaart op de maaier zetten": {
    en: "Applying the map on the mower",
    fr: "Appliquer la carte sur la tondeuse",
    de: "Die Karte auf den Mäher übertragen",
  },
  "Maaier offline: de kaart kan pas op de maaier gezet worden als die online is.": {
    en: "Mower offline: the map can only be applied once the mower is online.",
    fr: "Tondeuse hors ligne : la carte ne peut être appliquée qu'une fois la tondeuse en ligne.",
    de: "Mäher offline: Die Karte kann erst übertragen werden, wenn der Mäher online ist.",
  },
};
