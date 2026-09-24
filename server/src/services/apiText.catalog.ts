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
  "Achteruit rijden om te re-locken...": {
    en: "Reversing to re-lock...",
    fr: "Marche arrière pour se reverrouiller...",
    de: "Rückwärtsfahrt zum erneuten Einrasten...",
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
  "Automatisch her-ankeren moet beginnen met de maaier op het dock (laden).": {
    en: "auto re-anchor must start with the mower on the dock (charging).",
    fr: "Le réancrage automatique doit commencer avec la tondeuse sur le dock (en charge).",
    de: "Das automatische Neuverankern muss mit dem Mäher auf dem Dock (Laden) beginnen.",
  },
  "Automatisch her-ankeren vereist een echte RTK Fixed; wacht tot de fix Fixed is.": {
    en: "auto re-anchor needs a real RTK Fixed; wait for the fix to go Fixed.",
    fr: "Le réancrage automatique nécessite un vrai RTK Fixed ; attendez que le fix soit Fixed.",
    de: "Das automatische Neuverankern erfordert ein echtes RTK Fixed; warten Sie, bis der Fix Fixed ist.",
  },
  "Autonoom karteren": {
    en: "Autonomous mapping",
    fr: "La cartographie autonome",
    de: "Das autonome Kartieren",
  },
  "Backup heeft geen mapNtocharge_unicom, dus de laadpositie kan niet verankerd worden": {
    en: "Backup has no mapNtocharge_unicom: cannot anchor charger pose",
    fr: "La sauvegarde n'a pas de mapNtocharge_unicom : impossible d'ancrer la position de charge",
    de: "Das Backup hat kein mapNtocharge_unicom: die Ladeposition kann nicht verankert werden",
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
  "Buiten tolerantie: dock op ({0}, {1}) m, {2} m van origin.": {
    en: "Out of tolerance: dock at ({0}, {1}) m, {2} m from origin.",
    fr: "Hors tolérance : dock à ({0}, {1}) m, à {2} m de l'origine.",
    de: "Außerhalb der Toleranz: Dock bei ({0}, {1}) m, {2} m vom Ursprung.",
  },
  "Buiten tolerantie: dock op ({0}, {1}) m, {2} m van origin. Probeer opnieuw.": {
    en: "Out of tolerance: dock at ({0}, {1}) m, {2} m from origin. Try again.",
    fr: "Hors tolérance : dock à ({0}, {1}) m, à {2} m de l'origine. Réessayez.",
    de: "Außerhalb der Toleranz: Dock bei ({0}, {1}) m, {2} m vom Ursprung. Versuchen Sie es erneut.",
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
  "Controle: gedockt op de origin?": {
    en: "Check: docked on the origin?",
    fr: "Vérification : amarrée sur l'origine ?",
    de: "Prüfung: am Ursprung angedockt?",
  },
  "Controle: maaier op de dock en RTK Fixed?": {
    en: "Check: mower on the dock and RTK Fixed?",
    fr: "Vérification : tondeuse sur le dock et RTK Fixed ?",
    de: "Prüfung: Mäher auf dem Dock und RTK Fixed?",
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
  "De maaier antwoordde niet binnen 30 s; de synchronisatie kan op de achtergrond nog afronden": {
    en: "Mower did not respond within 30s; sync may still complete in background",
    fr: "La tondeuse n'a pas répondu dans les 30 s ; la synchronisation peut encore se terminer en arrière-plan",
    de: "Der Mäher hat nicht innerhalb von 30 s geantwortet; die Synchronisierung kann im Hintergrund noch abgeschlossen werden",
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
  "De maaier bevestigde de nieuwe dockpositie niet op tijd. Probeer opnieuw.": {
    en: "The mower did not confirm the new dock position in time. Try again.",
    fr: "La tondeuse n'a pas confirmé la nouvelle position du dock à temps. Réessayez.",
    de: "Der Mäher hat die neue Dockposition nicht rechtzeitig bestätigt. Versuchen Sie es erneut.",
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
  "De serverstatus is al hersteld; de maaier neemt het over bij de volgende sync_map": {
    en: "Server-side state already restored; the mower will pick it up on the next sync_map",
    fr: "L'état côté serveur est déjà restauré ; la tondeuse le reprendra au prochain sync_map",
    de: "Der serverseitige Zustand ist bereits wiederhergestellt; der Mäher übernimmt ihn beim nächsten sync_map",
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
  "Docken (visuele ArUco)...": {
    en: "Docking (visual ArUco)...",
    fr: "Amarrage (ArUco visuel)...",
    de: "Andocken (visuelles ArUco)...",
  },
  "Docken duurde te lang. Dok handmatig met de joystick en druk Verifieer.": {
    en: "Docking took too long. Dock manually with the joystick and press Verify.",
    fr: "L'amarrage a pris trop de temps. Amarrez manuellement avec le joystick et appuyez sur Vérifier.",
    de: "Das Andocken hat zu lange gedauert. Docken Sie manuell mit dem Joystick an und drücken Sie Überprüfen.",
  },
  "Dockpositie opslaan (poging {0})...": {
    en: "Saving dock position (attempt {0})...",
    fr: "Enregistrement de la position du dock (tentative {0})...",
    de: "Dockposition wird gespeichert (Versuch {0})...",
  },
  "Dockpositie opslaan...": {
    en: "Saving dock position...",
    fr: "Enregistrement de la position du dock...",
    de: "Dockposition wird gespeichert...",
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
  "Geen geldige GPS-coordinaten van de maaier.": {
    en: "No valid GPS coordinates from the mower.",
    fr: "Aucune coordonnée GPS valide de la tondeuse.",
    de: "Keine gültigen GPS-Koordinaten vom Mäher.",
  },
  "Geen kaarten gevonden voor dit apparaat": {
    en: "No maps found for this device",
    fr: "Aucune carte trouvée pour cet appareil",
    de: "Keine Karten für dieses Gerät gefunden",
  },
  "Geen kaartgegevens gevonden voor deze maaier: breng het gebied eerst in kaart.": {
    en: "No map data found for this mower: map the area first.",
    fr: "Aucune donnée de carte trouvée pour cette tondeuse : cartographiez d'abord la zone.",
    de: "Keine Kartendaten für diesen Mäher gefunden: Kartieren Sie zuerst den Bereich.",
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
  "Geslaagd. Gedockt op ({0}, {1}) m.": {
    en: "Succeeded. Docked at ({0}, {1}) m.",
    fr: "Réussi. Amarrée à ({0}, {1}) m.",
    de: "Erfolgreich. Angedockt bei ({0}, {1}) m.",
  },
  "Geweigerd: de te herstellen kaart is structureel kapot (losgekoppelde zones of inconsistente afmetingen). De maaier is NIET aangeraakt.": {
    en: "Refused: the map to restore is structurally broken (disconnected zones or inconsistent dimensions). The mower was NOT touched.",
    fr: "Refusé : la carte à restaurer est structurellement cassée (zones déconnectées ou dimensions incohérentes). La tondeuse n'a PAS été modifiée.",
    de: "Abgelehnt: die wiederherzustellende Karte ist strukturell defekt (getrennte Zonen oder inkonsistente Abmessungen). Der Mäher wurde NICHT verändert.",
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
  "Het frame is al gevalideerd; her-ankeren is niet nodig": {
    en: "frame is already validated; no re-anchor needed",
    fr: "Le repère est déjà validé ; aucun réancrage nécessaire",
    de: "Der Bezugsrahmen ist bereits validiert; Neuverankern ist nicht nötig",
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
  "Kon <SN>_latest.zip niet opnieuw genereren": {
    en: "Failed to regenerate <SN>_latest.zip",
    fr: "Impossible de régénérer <SN>_latest.zip",
    de: "<SN>_latest.zip konnte nicht neu erzeugt werden",
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
  "Maaier offline: sync_map kan niet draaien": {
    en: "Mower offline: sync_map cannot run",
    fr: "Tondeuse hors ligne : sync_map ne peut pas s'exécuter",
    de: "Mäher offline: sync_map kann nicht ausgeführt werden",
  },
  "Maaier offline: sync_map niet verstuurd; de maaier neemt de verschuiving over bij de volgende verbinding": {
    en: "Mower offline: sync_map not pushed; mower will pick up offset on next reconnect",
    fr: "Tondeuse hors ligne : sync_map non envoyé ; la tondeuse appliquera le décalage à la prochaine connexion",
    de: "Mäher offline: sync_map nicht gesendet; der Mäher übernimmt die Verschiebung bei der nächsten Verbindung",
  },
  "Maaier offline: verwijderen vereist een online maaier, zodat die de kaart van zijn schijf kan wissen": {
    en: "mower offline: delete needs an online mower so it can wipe the map from disk",
    fr: "Tondeuse hors ligne : la suppression nécessite une tondeuse en ligne pour effacer la carte de son disque",
    de: "Mäher offline: Zum Löschen muss der Mäher online sein, damit er die Karte von seinem Speicher löschen kann",
  },
  "Maaier reageerde niet binnen 30 s; de synchronisatie kan op de achtergrond nog afronden": {
    en: "Mower did not respond within 30s; sync may still complete in the background",
    fr: "La tondeuse n'a pas répondu en 30 s ; la synchronisation peut encore se terminer en arrière-plan",
    de: "Der Mäher hat nicht innerhalb von 30 s geantwortet; die Synchronisierung kann im Hintergrund noch abgeschlossen werden",
  },
  "Maaier reageerde niet binnen 8 s": {
    en: "Mower did not respond within 8s",
    fr: "La tondeuse n'a pas répondu en 8 s",
    de: "Der Mäher hat nicht innerhalb von 8 s geantwortet",
  },
  "Maaier staat niet op de dock (laden). Dok hem eerst, dan opnieuw.": {
    en: "Mower is not on the dock (charging). Dock it first, then try again.",
    fr: "La tondeuse n'est pas sur le dock (en charge). Placez-la d'abord sur le dock, puis réessayez.",
    de: "Der Mäher steht nicht auf dem Dock (Laden). Docken Sie ihn zuerst an und versuchen Sie es dann erneut.",
  },
  "Maaier staat niet op de dock. Dok hem eerst.": {
    en: "Mower is not on the dock. Dock it first.",
    fr: "La tondeuse n'est pas sur le dock. Placez-la d'abord sur le dock.",
    de: "Der Mäher steht nicht auf dem Dock. Docken Sie ihn zuerst an.",
  },
  "Maaier-GPS niet gemeld: wacht tot de maaier online is, op het dock staat en RTK FIX heeft": {
    en: "Mower GPS not reported: wait for the mower to be online, on the dock and at RTK FIX",
    fr: "GPS de la tondeuse non signalé : attendez que la tondeuse soit en ligne, sur le dock et en RTK FIX",
    de: "Mäher-GPS nicht gemeldet: warten Sie, bis der Mäher online ist, im Dock steht und RTK FIX hat",
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
  "Nog geen RTK Fixed. Wacht tot de fix Fixed is en probeer opnieuw.": {
    en: "No RTK Fixed yet. Wait until the fix is Fixed and try again.",
    fr: "Pas encore de RTK Fixed. Attendez que le fix soit Fixed et réessayez.",
    de: "Noch kein RTK Fixed. Warten Sie, bis der Fix Fixed ist, und versuchen Sie es erneut.",
  },
  "Nog niet gelockt. Rij met de joystick nog ~1 m recht achteruit; ik ga automatisch verder zodra de localisatie lockt.": {
    en: "Not locked yet. Drive straight back another ~1 m with the joystick; I will continue automatically as soon as localization locks.",
    fr: "Pas encore verrouillé. Reculez encore de ~1 m en ligne droite avec le joystick ; je continuerai automatiquement dès que la localisation sera verrouillée.",
    de: "Noch nicht eingerastet. Fahren Sie mit dem Joystick noch ~1 m gerade rückwärts; es geht automatisch weiter, sobald die Lokalisierung einrastet.",
  },
  "Nog steeds geen lock na extra achteruit rijden. Rij handmatig met de joystick terug naar de dock en start de automatische re-anchor opnieuw.": {
    en: "Still no lock after extra reversing. Drive back to the dock manually with the joystick and start the automatic re-anchor again.",
    fr: "Toujours pas de verrouillage après la marche arrière supplémentaire. Ramenez la tondeuse au dock manuellement avec le joystick et relancez le réancrage automatique.",
    de: "Immer noch nicht eingerastet nach zusätzlicher Rückwärtsfahrt. Fahren Sie manuell mit dem Joystick zurück zum Dock und starten Sie die automatische Neuverankerung erneut.",
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
  "Onverwachte fout: {0}": {
    en: "Unexpected error: {0}",
    fr: "Erreur inattendue : {0}",
    de: "Unerwarteter Fehler: {0}",
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
  "RTK FIX niet bereikt na {0} s wachten (loc_quality={1})": {
    en: "RTK FIX never reached after {0}s wait (loc_quality={1})",
    fr: "RTK FIX non atteint après {0} s d'attente (loc_quality={1})",
    de: "RTK FIX nach {0} s Wartezeit nicht erreicht (loc_quality={1})",
  },
  "RTK FIX vereist op het dock: loc_quality={0}": {
    en: "RTK FIX required at dock: loc_quality={0}",
    fr: "RTK FIX requis sur le dock : loc_quality={0}",
    de: "RTK FIX im Dock erforderlich: loc_quality={0}",
  },
  "RTK te onrustig op de dock (zwabbert ±{0} cm). Wacht op een rustige Fixed en probeer opnieuw.": {
    en: "RTK too unstable on the dock (wobbling ±{0} cm). Wait for a steady Fixed and try again.",
    fr: "RTK trop instable sur le dock (oscille de ±{0} cm). Attendez un Fixed stable et réessayez.",
    de: "RTK auf dem Dock zu unruhig (schwankt ±{0} cm). Warten Sie auf ein ruhiges Fixed und versuchen Sie es erneut.",
  },
  "Randmaaien op schemadagen": {
    en: "Edge cutting on schedule days",
    fr: "La coupe des bordures les jours planifiés",
    de: "Das Kantenmähen an geplanten Tagen",
  },
  "Re-anchor gestart...": {
    en: "Re-anchor started...",
    fr: "Réancrage démarré...",
    de: "Neuverankerung gestartet...",
  },
  "Re-lock gelukt. Rij de maaier nu zelf recht voor de dock, op ~50 cm afstand. Druk daarna op \"Start docken\".": {
    en: "Re-lock succeeded. Now drive the mower yourself straight in front of the dock, about 50 cm away. Then press \"Start docking\".",
    fr: "Reverrouillage réussi. Placez maintenant vous-même la tondeuse bien en face du dock, à environ 50 cm. Appuyez ensuite sur « Démarrer l'amarrage ».",
    de: "Erneutes Einrasten erfolgreich. Fahren Sie den Mäher jetzt selbst gerade vor das Dock, etwa 50 cm entfernt. Drücken Sie dann auf „Andocken starten“.",
  },
  "Rijden moet beginnen met de maaier op het dock (laden). Rij hem eerst op het dock.": {
    en: "drive must start with the mower on the dock (charging). Drive it onto the dock first.",
    fr: "La conduite doit commencer avec la tondeuse sur le dock (en charge). Amenez-la d'abord sur le dock.",
    de: "Die Fahrt muss mit dem Mäher auf dem Dock (Laden) beginnen. Fahren Sie ihn zuerst auf das Dock.",
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
  "Stabiliteit controleren op de dock (±{0} cm)...": {
    en: "Checking stability on the dock (±{0} cm)...",
    fr: "Vérification de la stabilité sur le dock (±{0} cm)...",
    de: "Stabilität auf dem Dock wird geprüft (±{0} cm)...",
  },
  "Stabiliteit controleren op de dock...": {
    en: "Checking stability on the dock...",
    fr: "Vérification de la stabilité sur le dock...",
    de: "Stabilität auf dem Dock wird geprüft...",
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
  "Verifiëren moet gebeuren met de maaier terug op het dock.": {
    en: "verify must run with the mower back on the dock.",
    fr: "La vérification doit se faire avec la tondeuse de retour sur le dock.",
    de: "Die Überprüfung muss mit dem Mäher zurück auf dem Dock erfolgen.",
  },
  "Verifiëren vereist eerst de her-ankercyclus: de maaier moet het dock hebben verlaten, RUNNING + RTK Fixed hebben bereikt en daarna opnieuw gedockt zijn.": {
    en: "verify needs the re-anchor cycle first: the mower must have left the dock, reached RUNNING + RTK Fixed, then re-docked.",
    fr: "La vérification nécessite d'abord le cycle de réancrage : la tondeuse doit avoir quitté le dock, atteint RUNNING + RTK Fixed, puis être revenue sur le dock.",
    de: "Die Überprüfung erfordert zuerst den Neuverankerungszyklus: Der Mäher muss das Dock verlassen, RUNNING + RTK Fixed erreicht haben und danach wieder angedockt sein.",
  },
  "Verschuiving groter dan {0} m: buiten ooit gescand gebied is het navigatiegedrag onbewezen": {
    en: "Displacement larger than {0} m: outside the area that was ever scanned, navigation behaviour is unproven",
    fr: "Déplacement supérieur à {0} m : hors de la zone déjà scannée, le comportement de navigation n'est pas éprouvé",
    de: "Verschiebung größer als {0} m: außerhalb des jemals gescannten Bereichs ist das Navigationsverhalten unerprobt",
  },
  "Wachten op re-lock (RUNNING + Fixed)...": {
    en: "Waiting for re-lock (RUNNING + Fixed)...",
    fr: "Attente du reverrouillage (RUNNING + Fixed)...",
    de: "Warten auf erneutes Einrasten (RUNNING + Fixed)...",
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
  "automatische her-dockreeks gestart: 1 m achteruit → stop → go_to_charge. Volg battery_state in /devices tot Charging.": {
    en: "auto-redock sequence started: back 1m → stop → go_to_charge. Poll /devices for battery_state → Charging.",
    fr: "séquence de ré-amarrage automatique lancée : 1 m en arrière → arrêt → go_to_charge. Suivez battery_state dans /devices jusqu'à Charging.",
    de: "automatische Re-Dock-Sequenz gestartet: 1 m zurück → Stopp → go_to_charge. Verfolgen Sie battery_state in /devices bis Charging.",
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
  "de automatische modus vereist dat de maaier nu op het dock staat (laden). battery_state='{0}', recharge_status='{1}'": {
    en: "auto mode requires mower currently on dock (charging). battery_state='{0}', recharge_status='{1}'",
    fr: "le mode automatique exige que la tondeuse soit actuellement sur le dock (en charge). battery_state='{0}', recharge_status='{1}'",
    de: "der Automatikmodus erfordert, dass der Mäher gerade im Dock steht (lädt). battery_state='{0}', recharge_status='{1}'",
  },
  "de bundel heeft geen mowerFiles: hij is geëxporteerd voordat de verbatim-functie bestond": {
    en: "bundle has no mowerFiles: it was exported before the verbatim feature shipped",
    fr: "le bundle n'a pas de mowerFiles : il a été exporté avant l'arrivée de la fonction verbatim",
    de: "das Bundle hat keine mowerFiles: es wurde exportiert, bevor es die Verbatim-Funktion gab",
  },
  "de bundel is geëxporteerd van {0}, niet van {1}. De kaart is relatief aan het laadstation en pos.json blijft ongemoeid, dus dit is meestal veilig (de dock-cyclus verankert het frame opnieuw). Geef force=1 mee om te bevestigen.": {
    en: "bundle was exported from {0}, not {1}. The map is charger-relative and pos.json is left untouched, so this is generally safe (the dock-cycle re-anchors the frame). Pass force=1 to confirm.",
    fr: "le bundle a été exporté depuis {0}, pas {1}. La carte est relative à la station de charge et pos.json n'est pas modifié, c'est donc généralement sans risque (le cycle de dock réancre le repère). Passez force=1 pour confirmer.",
    de: "das Bundle wurde von {0} exportiert, nicht von {1}. Die Karte ist relativ zur Ladestation und pos.json bleibt unverändert, daher ist dies in der Regel sicher (der Dock-Zyklus verankert den Rahmen neu). Übergeben Sie force=1 zur Bestätigung.",
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
  "geen GPS voor start_pose": {
    en: "no GPS for start_pose",
    fr: "pas de GPS pour start_pose",
    de: "kein GPS für start_pose",
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
  "geen laadstation-anker in de database: eerst sync_map": {
    en: "no charger anchor in DB: sync_map first",
    fr: "aucune ancre de station de charge dans la base : faites d'abord sync_map",
    de: "kein Ladestations-Anker in der Datenbank: zuerst sync_map",
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
  "geen werkpolygoon": {
    en: "no work polygon",
    fr: "aucun polygone de travail",
    de: "kein Arbeitspolygon",
  },
  "gereden afstand {0} m ligt onder de drempel van 0,3 m": {
    en: "drive distance {0}m below 0.3m threshold",
    fr: "distance parcourue de {0} m inférieure au seuil de 0,3 m",
    de: "gefahrene Strecke {0} m liegt unter der Schwelle von 0,3 m",
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
};
