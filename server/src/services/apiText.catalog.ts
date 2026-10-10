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
  "Ongeldig serienummer": {
    en: "Invalid serial number",
    fr: "Numéro de série invalide",
    de: "Ungültige Seriennummer",
  },
  "Ongeldig IP-adres": {
    en: "Invalid IP address",
    fr: "Adresse IP invalide",
    de: "Ungültige IP-Adresse",
  },
  "Zet de maaier eerst op het laadstation. De update wordt alleen gedownload terwijl de maaier laadt; daarbuiten blijft hij op 0% staan.": {
    en: "Put the mower on its charging station first. The update is only downloaded while the mower charges; anywhere else it stays at 0%.",
    fr: "Placez d'abord la tondeuse sur sa station de charge. La mise à jour n'est téléchargée que pendant la charge ; ailleurs elle reste à 0 %.",
    de: "Stellen Sie den Mäher zuerst auf die Ladestation. Das Update wird nur geladen, während der Mäher lädt; sonst bleibt es bei 0 %.",
  },
  "Herankeren vereist een gelokaliseerde maaier (RUNNING) met acht verse, stabiele RTK Fixed-metingen op het dock. Rij zo nodig eerst een stukje met de joystick en dock opnieuw.": {
    en: "Re-anchoring requires a localized mower (RUNNING) with eight fresh, stable RTK Fixed readings on the dock. If needed, drive a short distance with the joystick first and dock again.",
    fr: "Le ré-ancrage nécessite une tondeuse localisée (RUNNING) avec huit mesures RTK Fixed fraîches et stables sur la station. Si nécessaire, roulez d’abord un peu avec le joystick puis revenez sur la station.",
    de: "Das Neuverankern erfordert einen lokalisierten Mäher (RUNNING) mit acht neuen, stabilen RTK-Fixed-Messungen auf der Ladestation. Fahren Sie bei Bedarf zuerst ein Stück mit dem Joystick und docken Sie erneut an.",
  },
  "Herankeren": {
    en: "Re-anchoring",
    fr: "Réancrage",
    de: "Neu verankern",
  },
  "De maaier rijdt begrensd achteruit om de richting te initialiseren. Blijf bij de maaier.": {
    en: "The mower reverses a limited distance to initialize its heading. Stay with the mower.",
    fr: "La tondeuse recule sur une distance limitée pour initialiser son cap. Restez à proximité.",
    de: "Der Mäher fährt begrenzt rückwärts, um seine Richtung zu initialisieren. Bleiben Sie beim Mäher.",
  },
  "De maaier keert met de camera terug op het eigen dock. Blijf toezicht houden.": {
    en: "The mower returns to its own dock using the camera. Keep supervising.",
    fr: "La tondeuse retourne à sa propre station avec la caméra. Continuez à surveiller.",
    de: "Der Mäher kehrt mithilfe der Kamera zu seiner eigenen Ladestation zurück. Beaufsichtigen Sie ihn weiterhin.",
  },
  "De gemeten GPS-oorsprong herstellen; dockanker en zones blijven vast.": {
    en: "Restoring the measured GPS origin; the dock reference and zones remain fixed.",
    fr: "Rétablissement de l’origine GPS mesurée ; la référence de la station et les zones restent fixes.",
    de: "Gemessenen GPS-Ursprung wiederherstellen; Dockreferenz und Zonen bleiben unverändert.",
  },
  "Dockanker en maaierbestanden controleren. Bevestiging van toezicht afwachten.": {
    en: "Checking the dock reference and mower files. Waiting for supervision confirmation.",
    fr: "Vérification de la référence de la station et des fichiers. En attente de confirmation de la surveillance.",
    de: "Dockreferenz und Mäherdateien prüfen. Auf Bestätigung der Aufsicht warten.",
  },
  "Procedure gestopt: toezicht, verbinding of kaartreferentie ontbreekt. Zet de maaier op zijn eigen dock en probeer opnieuw.": {
    en: "Procedure stopped: supervision, connection or map reference is unavailable. Return the mower to its own dock and retry.",
    fr: "Procédure arrêtée : surveillance, connexion ou référence de carte indisponible. Replacez la tondeuse sur sa propre station et réessayez.",
    de: "Vorgang gestoppt: Aufsicht, Verbindung oder Kartenreferenz fehlt. Stellen Sie den Mäher auf seine eigene Ladestation und versuchen Sie es erneut.",
  },
  "Dockanker ontbreekt of dockkanalen spreken elkaar tegen.": {
    en: "The dock reference is missing or dock channels disagree.",
    fr: "La référence de la station manque ou les passages vers la station se contredisent.",
    de: "Die Dockreferenz fehlt oder die Dockkanäle widersprechen sich.",
  },
  "De dockankers in server, kanalen en maaierbestanden spreken elkaar tegen. Eerst onderzoeken; niets gewijzigd.": {
    en: "Dock references in the server, channels and mower files disagree. Investigate first; nothing was changed.",
    fr: "Les références de station du serveur, des passages et des fichiers sont contradictoires. Vérifiez d’abord ; aucune modification effectuée.",
    de: "Dockreferenzen in Server, Kanälen und Mäherdateien widersprechen sich. Zuerst untersuchen; nichts geändert.",
  },
  "Kanaalanker en opgeslagen dockpositie moeten hetzelfde punt zijn.": {
    en: "The channel reference and saved dock position must be the same point.",
    fr: "La référence du passage et la position enregistrée de la station doivent être le même point.",
    de: "Kanalreferenz und gespeicherte Dockposition müssen derselbe Punkt sein.",
  },
  "Herankerbackup hoort bij een andere maaier.": {
    en: "The re-anchor backup belongs to a different mower.",
    fr: "La sauvegarde de réancrage appartient à une autre tondeuse.",
    de: "Die Sicherung der Neuverankerung gehört zu einem anderen Mäher.",
  },
  "De oorsprong wijkt af van zowel de backup als het voorgestelde herstel. Eerst onderzoeken.": {
    en: "The origin differs from both the backup and the proposed correction. Investigate first.",
    fr: "L’origine diffère de la sauvegarde et de la correction proposée. Vérifiez d’abord.",
    de: "Der Ursprung weicht sowohl von der Sicherung als auch von der vorgeschlagenen Korrektur ab. Zuerst untersuchen.",
  },
  "Begin stilstaand op het eigen dock met vers laadcontact en lokalisatie.": {
    en: "Start stationary on the own dock with fresh charging contact and localization.",
    fr: "Commencez à l’arrêt sur la station d’origine avec un contact de charge récent et la localisation active.",
    de: "Starten Sie im Stillstand auf der eigenen Ladestation mit aktuellem Ladekontakt und aktiver Lokalisierung.",
  },
  "Na de oorsprongwijziging is geen verse gelokaliseerde positie minstens 40 cm van het dock gemeten.": {
    en: "After changing the origin, no fresh localized position at least 40 cm from the dock was measured.",
    fr: "Après modification de l’origine, aucune position localisée récente à au moins 40 cm de la station n’a été mesurée.",
    de: "Nach der Ursprungsänderung wurde keine neue lokalisierte Position mindestens 40 cm vom Dock entfernt gemessen.",
  },
  "De kaartreferentie is tijdens de dockrit gewijzigd.": {
    en: "The map reference changed during the dock trip.",
    fr: "La référence de carte a changé pendant le trajet vers la station.",
    de: "Die Kartenreferenz hat sich während der Dockfahrt geändert.",
  },
  "Dockanker gewijzigd tijdens de procedure.": {
    en: "The dock reference changed during the procedure.",
    fr: "La référence de la station a changé pendant la procédure.",
    de: "Die Dockreferenz hat sich während des Vorgangs geändert.",
  },
  "De eerdere oorsprongwijziging is nog niet bevestigd binnen 5 cm. Eerst de meetkwaliteit en het vaste dock onderzoeken.": {
    en: "The previous origin change has not been verified within 5 cm. Check measurement quality and the fixed dock first.",
    fr: "La modification précédente de l’origine n’est pas confirmée à 5 cm près. Vérifiez d’abord la qualité des mesures et la station fixe.",
    de: "Die vorherige Ursprungsänderung ist noch nicht innerhalb von 5 cm bestätigt. Zuerst Messqualität und feste Ladestation prüfen.",
  },
  "Oorsprong niet aantoonbaar geladen. De vervolgcontrole blijft opgeslagen; opnieuw starten leest eerst de uitkomst terug.": {
    en: "Loading the origin was not confirmed. The pending verification is saved; restarting first reads back the outcome.",
    fr: "Le chargement de l’origine n’est pas confirmé. La vérification reste enregistrée ; le redémarrage relit d’abord le résultat.",
    de: "Das Laden des Ursprungs wurde nicht bestätigt. Die ausstehende Prüfung bleibt gespeichert; ein Neustart liest zuerst das Ergebnis zurück.",
  },
  "Geladen oorsprong wijkt af van de bevestigde voertuigmeting.": {
    en: "The loaded origin differs from the confirmed vehicle measurement.",
    fr: "L’origine chargée diffère de la mesure confirmée du véhicule.",
    de: "Der geladene Ursprung weicht von der bestätigten Fahrzeugmessung ab.",
  },
  "Gedockte voertuigpositie wijkt meer dan 5 cm af van het vaste dockanker.": {
    en: "The docked vehicle position differs by more than 5 cm from the fixed dock reference.",
    fr: "La position du véhicule sur la station diffère de plus de 5 cm de la référence fixe.",
    de: "Die angedockte Fahrzeugposition weicht um mehr als 5 cm von der festen Dockreferenz ab.",
  },
  "Onbekende herankercyclus.": {
    en: "Unknown re-anchor cycle.",
    fr: "Cycle de réancrage inconnu.",
    de: "Unbekannter Neuverankerungszyklus.",
  },
  "Toezicht verlopen. Start een nieuwe cyclus.": {
    en: "Operator supervision expired. Start a new cycle.",
    fr: "La surveillance a expiré. Démarrez un nouveau cycle.",
    de: "Die Aufsicht ist abgelaufen. Starten Sie einen neuen Zyklus.",
  },
  "Open de actuele herankerwizard en start de volledige controle.": {
    en: "Open the current re-anchor wizard and start the full check.",
    fr: "Ouvrez l’assistant de réancrage actuel et lancez la vérification complète.",
    de: "Öffnen Sie den aktuellen Assistenten zur Neuverankerung und starten Sie die vollständige Prüfung.",
  },
  "Er loopt al een kaart- of herankeractie.": {
    en: "A map or re-anchor operation is already running.",
    fr: "Une opération de carte ou de réancrage est déjà en cours.",
    de: "Ein Karten- oder Neuverankerungsvorgang läuft bereits.",
  },
  "Onbekende actie": {
    en: "Unknown action",
    fr: "Action inconnue",
    de: "Unbekannte Aktion",
  },
  "Open de bijgewerkte wizard en bevestig dat de maaier op zijn eigen onverplaatste dock staat. Deze procedure omvat rijden onder toezicht.": {
    en: "Open the updated wizard and confirm the mower is on its own unmoved dock. This procedure includes supervised movement.",
    fr: "Ouvrez l’assistant à jour et confirmez que la tondeuse est sur sa propre station non déplacée. Cette procédure comprend des déplacements sous surveillance.",
    de: "Öffnen Sie den aktualisierten Assistenten und bestätigen Sie, dass der Mäher auf seiner eigenen unverrückten Ladestation steht. Dieser Vorgang umfasst beaufsichtigte Fahrten.",
  },
  "Een kaartinstallatie is niet bevestigd. Herstel die installatie eerst; herankeren kan deze fout niet oplossen.": {
    en: "A map installation is unconfirmed. Recover that installation first; re-anchoring cannot fix it.",
    fr: "Une installation de carte n’est pas confirmée. Rétablissez d’abord cette installation ; le réancrage ne peut pas la réparer.",
    de: "Eine Karteninstallation ist unbestätigt. Stellen Sie diese Installation zuerst wieder her; Neuverankerung kann diesen Fehler nicht beheben.",
  },
  "Herankeren vereist een online maaier op zijn eigen dock, verse RTK Fixed en een eenduidig dockanker.": {
    en: "Re-anchoring requires an online mower on its own dock, fresh RTK Fixed and a consistent dock reference.",
    fr: "Le réancrage nécessite une tondeuse en ligne sur sa propre station, des données RTK Fixed récentes et une référence de station cohérente.",
    de: "Neuverankerung erfordert einen verbundenen Mäher auf seiner eigenen Ladestation, aktuelle RTK Fixed-Daten und eine eindeutige Dockreferenz.",
  },
  "Verse gedockte voertuigpositie en antennetransformatie meten.": {
    en: "Measuring the fresh docked vehicle position and the antenna transform.",
    fr: "Mesure de la position actuelle du véhicule sur la station et de la transformation de l’antenne.",
    de: "Neue angedockte Fahrzeugposition und Antennentransformation messen.",
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
  "Zet de kaartverschuiving van beide maaiers op nul voordat je een zone kopieert.": {
    en: "Set both mowers’ map offsets to zero before copying a zone.",
    fr: "Remettez les décalages de carte des deux tondeuses à zéro avant de copier une zone.",
    de: "Setzen Sie die Kartenverschiebungen beider Mäher auf null, bevor Sie eine Zone kopieren.",
  },
  "De gekozen doelzone bestaat niet meer; kies opnieuw welke zone je wilt vervangen.": {
    en: "The selected target zone no longer exists; choose the zone to replace again.",
    fr: "La zone cible sélectionnée n’existe plus ; choisissez à nouveau la zone à remplacer.",
    de: "Die ausgewählte Zielzone existiert nicht mehr; wählen Sie erneut die zu ersetzende Zone.",
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
  "De maaier antwoordde niet (time-out)": {
    en: "Mower did not respond (timeout)",
    fr: "La tondeuse n'a pas répondu (délai dépassé)",
    de: "Der Mäher hat nicht geantwortet (Zeitüberschreitung)",
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
  "De maaier is bezig; stop de taak eerst en probeer het dan opnieuw.": {
    en: "The mower is busy; stop the task first and then try again.",
    fr: "La tondeuse est occupée ; arrêtez d'abord la tâche puis réessayez.",
    de: "Der Mäher ist beschäftigt; beenden Sie zuerst die Aufgabe und versuchen Sie es dann erneut.",
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
  "Deze zone draagt het kanaal naar het laadstation. Wie de zone wist, wist ook dat kanaal, en daaraan is de hele kaart verankerd. Pas de zone aan in plaats van haar te wissen.": {
    en: "This zone carries the channel to the charging station. Deleting the zone deletes that channel too, and the whole map is anchored to it. Edit the zone instead of deleting it.",
    fr: "Cette zone porte le passage vers la station de charge. Supprimer la zone supprime aussi ce passage, auquel toute la carte est ancrée. Modifiez la zone au lieu de la supprimer.",
    de: "Diese Zone trägt den Kanal zur Ladestation. Wer die Zone löscht, löscht auch diesen Kanal, und an ihm ist die ganze Karte verankert. Bearbeiten Sie die Zone, statt sie zu löschen.",
  },
  "Er is geen dockkanaal, dus de server heeft geen dockanker om op te herankeren. Herstel eerst het dockkanaal onder Instellingen, Herstel.": {
    en: "There is no dock channel, so the server has no dock reference to re-anchor on. Repair the dock channel first under Settings, Recovery.",
    fr: "Il n'y a pas de passage vers la station, le serveur n'a donc pas de référence de station pour le réancrage. Réparez d'abord le passage vers la station sous Réglages, Récupération.",
    de: "Es gibt keinen Dockkanal, daher hat der Server keine Dockreferenz zum Neuverankern. Reparieren Sie zuerst den Dockkanal unter Einstellungen, Wiederherstellung.",
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
  "Dit obstakel ligt in de uitrijbaan van het dock (1,4 m breed, ook langs het dockkanaal). Bij het uitrijden of uitwijken kan de maaier er deels overheen rijden; houd die baan vrij of verplaats het obstakel.": {
    en: "This obstacle lies in the dock exit lane (1.4 m wide, also along the dock channel). When leaving the dock or avoiding, the mower may drive partly over it; keep that lane clear or move the obstacle.",
    fr: "Cet obstacle se trouve dans la voie de sortie de la station (1,4 m de large, aussi le long du canal de la station). En sortant ou en contournant, la tondeuse peut rouler en partie dessus ; gardez cette voie libre ou déplacez l'obstacle.",
    de: "Dieses Hindernis liegt in der Ausfahrspur der Ladestation (1,4 m breit, auch entlang des Dockkanals). Beim Ausfahren oder Ausweichen kann der Mäher teilweise darüberfahren; halten Sie diese Spur frei oder verschieben Sie das Hindernis.",
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
  "De motorprint van de maaier gaf geen antwoord op de PIN-controle. Oudere MCU-firmware ondersteunt dat mogelijk niet: stock v3.6.0 antwoordt er niet op, PIN-controle op afstand kwam met de gepatchte MCU-versies (v3.6.2 en later). Voer de PIN in op het scherm van de maaier.": {
    en: "The mower's motor board did not answer the PIN check. Older MCU firmware may not support it: stock v3.6.0 does not answer it, remote PIN checking came with the patched MCU builds (v3.6.2 and later). Enter the PIN on the mower's screen.",
    fr: "La carte moteur de la tondeuse n'a pas répondu à la vérification du code PIN. Un firmware MCU plus ancien ne la prend peut-être pas en charge : la version d'origine v3.6.0 n'y répond pas, la vérification du code PIN à distance est arrivée avec les versions MCU modifiées (v3.6.2 et ultérieures). Saisissez le code PIN sur l'écran de la tondeuse.",
    de: "Die Motorplatine des Mähers hat auf die PIN-Prüfung nicht geantwortet. Ältere MCU-Firmware unterstützt sie möglicherweise nicht: Die Original-Version v3.6.0 antwortet nicht darauf, die PIN-Prüfung aus der Ferne kam mit den gepatchten MCU-Versionen (v3.6.2 und neuer). Geben Sie die PIN am Display des Mähers ein.",
  },
  "Onjuiste PIN": {
    en: "Wrong PIN",
    fr: "Code PIN incorrect",
    de: "Falsche PIN",
  },
  "De maaier kon de motorprint niet bereiken via de seriële poort": {
    en: "The mower could not reach its motor board over the serial port",
    fr: "La tondeuse n'a pas pu joindre sa carte moteur via le port série",
    de: "Der Mäher konnte seine Motorplatine über die serielle Schnittstelle nicht erreichen",
  },
  "De motorprint gaf een onverwacht antwoord op de PIN-controle": {
    en: "The motor board gave an unexpected answer to the PIN check",
    fr: "La carte moteur a donné une réponse inattendue à la vérification du code PIN",
    de: "Die Motorplatine hat auf die PIN-Prüfung unerwartet geantwortet",
  },
  "De maaier gaf geen antwoord op de PIN-controle": {
    en: "The mower did not answer the PIN check",
    fr: "La tondeuse n'a pas répondu à la vérification du code PIN",
    de: "Der Mäher hat auf die PIN-Prüfung nicht geantwortet",
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
  "zonder nacht-, vorst- of regencheck: geen GPS-positie van het laadstation": {
    en: "without the night, frost or rain check: the charging station has no GPS position",
    fr: "sans contrôle nuit, gel ou pluie : la station de charge n'a pas de position GPS",
    de: "ohne Nacht-, Frost- oder Regenprüfung: die Ladestation hat keine GPS-Position",
  },
  "zonder nacht-, vorst- of regencheck: weerbericht niet opgehaald ({0})": {
    en: "without the night, frost or rain check: weather forecast not fetched ({0})",
    fr: "sans contrôle nuit, gel ou pluie : prévisions météo non récupérées ({0})",
    de: "ohne Nacht-, Frost- oder Regenprüfung: Wettervorhersage nicht abgerufen ({0})",
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
  "Terugkeren naar het dock": {
    en: "Returning to the dock",
    fr: "Retourner à la station de charge",
    de: "Zur Ladestation zurückkehren",
  },
  "Er is geen vrije dockaanloop naar deze zone. Controleer obstakels en de ligging van het werkgebied.": {
    en: "There is no clear dock approach to this zone. Check the obstacles and the work area's position.",
    fr: "Il n’y a pas d’approche dégagée depuis la station vers cette zone. Vérifiez les obstacles et la position de la zone de travail.",
    de: "Es gibt keine freie Dockzufahrt zu dieser Zone. Prüfen Sie die Hindernisse und die Lage des Arbeitsbereichs.",
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
  // Zone copy, dock-channel repair, dock photo and re-anchor errors (2026-10-04).
  "Rond eerst de kaart- of herankerprocedure af.": {
    en: "Finish the map or re-anchor procedure first.",
    fr: "Terminez d'abord la procédure de carte ou de ré-ancrage.",
    de: "Schließen Sie zuerst den Karten- oder Neuverankerungsvorgang ab.",
  },
  "Een eenduidig dockanker is vereist voor GPS-coördinaten.": {
    en: "A single, unambiguous dock anchor is required for GPS coordinates.",
    fr: "Une ancre de station sans ambiguïté est requise pour les coordonnées GPS.",
    de: "Für GPS-Koordinaten ist ein eindeutiger Dockanker erforderlich.",
  },
  "Vraag eerst een reparatievoorbeeld op.": {
    en: "Request a repair preview first.",
    fr: "Demandez d'abord un aperçu de la réparation.",
    de: "Fordern Sie zuerst eine Reparaturvorschau an.",
  },
  "Meten vereist een gevalideerd frame en acht verse, stabiele RUNNING + RTK Fixed-posities.": {
    en: "Measuring requires a validated frame and eight fresh, stable RUNNING + RTK Fixed positions.",
    fr: "La mesure nécessite un repère validé et huit positions RUNNING + RTK Fixed récentes et stables.",
    de: "Die Messung erfordert einen validierten Koordinatenrahmen und acht neue, stabile RUNNING- + RTK-Fixed-Positionen.",
  },
  "Bevestig dat je bij de bronmaaier staat en de rechte uitrit vrij is.": {
    en: "Confirm that you are standing by the source mower and the straight exit is clear.",
    fr: "Confirmez que vous êtes près de la tondeuse source et que la sortie en ligne droite est dégagée.",
    de: "Bestätigen Sie, dass Sie beim Quellmäher stehen und die gerade Ausfahrt frei ist.",
  },
  "Bevestig toezicht en dat de maaier vlak voor zijn eigen dock staat.": {
    en: "Confirm that you are supervising and that the mower stands just in front of its own dock.",
    fr: "Confirmez que vous surveillez et que la tondeuse se trouve juste devant sa propre station.",
    de: "Bestätigen Sie, dass Sie beaufsichtigen und der Mäher direkt vor seiner eigenen Ladestation steht.",
  },
  "Bevestig dat de te meten maaier stilstaat voor het gekozen bronlaadstation.": {
    en: "Confirm that the mower to be measured is standing still in front of the chosen source charging station.",
    fr: "Confirmez que la tondeuse à mesurer est immobile devant la station de charge source choisie.",
    de: "Bestätigen Sie, dass der zu messende Mäher still vor der gewählten Quell-Ladestation steht.",
  },
  "Een kopieerverzoek moet een JSON-object zijn.": {
    en: "A copy request must be a JSON object.",
    fr: "Une demande de copie doit être un objet JSON.",
    de: "Eine Kopieranfrage muss ein JSON-Objekt sein.",
  },
  "Ongeldige zone of kopieeropties.": {
    en: "Invalid zone or copy options.",
    fr: "Zone ou options de copie non valides.",
    de: "Ungültige Zone oder Kopieroptionen.",
  },
  "Meet het bronlaadstation met beide maaiers of wijs het aan op de kaart van de doelmaaier. Een losse positiemeting kan deze stap niet vervangen.": {
    en: "Measure the source charging station with both mowers, or point it out on the target mower's map. A single position measurement cannot replace this step.",
    fr: "Mesurez la station de charge source avec les deux tondeuses, ou indiquez-la sur la carte de la tondeuse cible. Une simple mesure de position ne peut pas remplacer cette étape.",
    de: "Messen Sie die Quell-Ladestation mit beiden Mähern oder zeigen Sie sie auf der Karte des Zielmähers an. Eine einzelne Positionsmessung kann diesen Schritt nicht ersetzen.",
  },
  "Kies óf de meting óf het aangewezen laadstation, niet beide.": {
    en: "Choose either the measurement or the pointed charging station, not both.",
    fr: "Choisissez soit la mesure, soit la station de charge indiquée, pas les deux.",
    de: "Wählen Sie entweder die Messung oder die angezeigte Ladestation, nicht beides.",
  },
  "Geef de positie van het laadstation van de bronmaaier als eindige x/y in meters.": {
    en: "Give the position of the source mower's charging station as finite x/y in meters.",
    fr: "Indiquez la position de la station de charge de la tondeuse source sous forme de x/y finis en mètres.",
    de: "Geben Sie die Position der Ladestation des Quellmähers als endliche x/y-Werte in Metern an.",
  },
  "Frame gewijzigd, meting verlopen of bronmaaier bezig; meet opnieuw.": {
    en: "Frame changed, measurement expired or source mower busy; measure again.",
    fr: "Repère modifié, mesure expirée ou tondeuse source occupée ; mesurez à nouveau.",
    de: "Koordinatenrahmen geändert, Messung abgelaufen oder Quellmäher beschäftigt; messen Sie erneut.",
  },
  "Meet het bronlaadstation eerst tweemaal met iedere maaier.": {
    en: "First measure the source charging station twice with each mower.",
    fr: "Mesurez d'abord deux fois la station de charge source avec chaque tondeuse.",
    de: "Messen Sie die Quell-Ladestation zuerst zweimal mit jedem Mäher.",
  },
  "Zet de doelmaaier op zijn eigen dock en wacht op stabiele RTK Fixed-lokalisatie binnen {0} cm van de opgeslagen dockpositie.": {
    en: "Put the target mower on its own dock and wait for stable RTK Fixed localization within {0} cm of the saved dock position.",
    fr: "Placez la tondeuse cible sur sa propre station et attendez une localisation RTK Fixed stable à moins de {0} cm de la position de station enregistrée.",
    de: "Stellen Sie den Zielmäher auf seine eigene Ladestation und warten Sie auf eine stabile RTK-Fixed-Lokalisierung innerhalb von {0} cm der gespeicherten Dockposition.",
  },
  "Ongeldige kaartbestanden van de maaier.": {
    en: "Invalid map files from the mower.",
    fr: "Fichiers de carte de la tondeuse non valides.",
    de: "Ungültige Kartendateien vom Mäher.",
  },
  "Server en maaier bevatten verschillende kaarten; synchroniseer die eerst.": {
    en: "Server and mower hold different maps; sync them first.",
    fr: "Le serveur et la tondeuse contiennent des cartes différentes ; synchronisez-les d'abord.",
    de: "Server und Mäher enthalten unterschiedliche Karten; synchronisieren Sie diese zuerst.",
  },
  "Server en maaier verschillen voor {0}.": {
    en: "Server and mower differ for {0}.",
    fr: "Le serveur et la tondeuse diffèrent pour {0}.",
    de: "Server und Mäher unterscheiden sich bei {0}.",
  },
  "Een online OpenNova-maaier met gevalideerd frame is vereist.": {
    en: "An online OpenNova mower with a validated frame is required.",
    fr: "Une tondeuse OpenNova en ligne avec un repère validé est requise.",
    de: "Ein Online-OpenNova-Mäher mit validiertem Koordinatenrahmen ist erforderlich.",
  },
  "De dockbestanden van de maaier komen niet overeen.": {
    en: "The mower's dock files do not match.",
    fr: "Les fichiers de station de la tondeuse ne correspondent pas.",
    de: "Die Dockdateien des Mähers stimmen nicht überein.",
  },
  "Kies een andere bronmaaier.": {
    en: "Choose a different source mower.",
    fr: "Choisissez une autre tondeuse source.",
    de: "Wählen Sie einen anderen Quellmäher.",
  },
  "Het dockkanaal van de bronmaaier wijkt af van zijn opgeslagen dock.": {
    en: "The source mower's dock channel differs from its saved dock.",
    fr: "Le canal de station de la tondeuse source diffère de sa station enregistrée.",
    de: "Der Dockkanal des Quellmähers weicht von seiner gespeicherten Ladestation ab.",
  },
  "Herstel eerst het bestaande dockkanaal van de doelmaaier.": {
    en: "Repair the target mower's existing dock channel first.",
    fr: "Réparez d'abord le canal de station existant de la tondeuse cible.",
    de: "Reparieren Sie zuerst den vorhandenen Dockkanal des Zielmähers.",
  },
  "Geen eenduidige opgeslagen dockpositie.": {
    en: "No unambiguous saved dock position.",
    fr: "Aucune position de station enregistrée sans ambiguïté.",
    de: "Keine eindeutige gespeicherte Dockposition.",
  },
  "De twee kaartkopieën op de maaier verschillen; geen automatische kanaalreparatie mogelijk.": {
    en: "The two map copies on the mower differ; automatic channel repair is not possible.",
    fr: "Les deux copies de carte sur la tondeuse diffèrent ; aucune réparation automatique du canal n'est possible.",
    de: "Die beiden Kartenkopien auf dem Mäher unterscheiden sich; eine automatische Kanalreparatur ist nicht möglich.",
  },
  "Ongeldige tweede dockverwijzing.": {
    en: "Invalid second dock reference.",
    fr: "Seconde référence de station non valide.",
    de: "Ungültige zweite Dockreferenz.",
  },
  "Onbekend kaartbestand: {0}": {
    en: "Unknown map file: {0}",
    fr: "Fichier de carte inconnu : {0}",
    de: "Unbekannte Kartendatei: {0}",
  },
  "Ongeldig obstakel.": {
    en: "Invalid obstacle.",
    fr: "Obstacle non valide.",
    de: "Ungültiges Hindernis.",
  },
  "Werkgebied ontbreekt voor {0}.": {
    en: "Work area missing for {0}.",
    fr: "Zone de travail manquante pour {0}.",
    de: "Arbeitsbereich fehlt für {0}.",
  },
  "Ongeldig werkgebied: {0}": {
    en: "Invalid work area: {0}",
    fr: "Zone de travail non valide : {0}",
    de: "Ungültiger Arbeitsbereich: {0}",
  },
  "Het opgeslagen dock ligt verder dan {0} m van elke zone; er is geen dockkanaal aan te maken.": {
    en: "The saved dock lies more than {0} m from every zone; no dock channel can be created.",
    fr: "La station enregistrée se trouve à plus de {0} m de chaque zone ; aucun passage vers la station ne peut être créé.",
    de: "Das gespeicherte Dock liegt mehr als {0} m von jeder Zone entfernt; es kann kein Dockkanal angelegt werden.",
  },
  "Het dockkanaal begint al op het opgeslagen dock; er is niets te herstellen.": {
    en: "The dock channel already starts at the saved dock; there is nothing to repair.",
    fr: "Le passage vers la station commence déjà à la station enregistrée ; il n'y a rien à réparer.",
    de: "Der Dockkanal beginnt bereits am gespeicherten Dock; es gibt nichts zu reparieren.",
  },
  "Geen vrije dockaanloop binnen {0}; teken een gecontroleerde doorgang.": {
    en: "No clear dock approach within {0}; draw a checked passage.",
    fr: "Aucune approche de station dégagée dans {0} ; tracez un passage vérifié.",
    de: "Keine freie Dockanfahrt innerhalb von {0}; zeichnen Sie einen geprüften Durchgang.",
  },
  "Kanaalreparatie vereist een kaart zonder fysieke verschuiving.": {
    en: "Channel repair requires a map without a physical offset.",
    fr: "La réparation du canal nécessite une carte sans décalage physique.",
    de: "Die Kanalreparatur erfordert eine Karte ohne physische Verschiebung.",
  },
  "Kaart of kalibratie gewijzigd; vraag een nieuw voorbeeld op.": {
    en: "Map or calibration changed; request a new preview.",
    fr: "Carte ou calibrage modifié ; demandez un nouvel aperçu.",
    de: "Karte oder Kalibrierung geändert; fordern Sie eine neue Vorschau an.",
  },
  "Kaart gewijzigd tijdens voorbereiding.": {
    en: "Map changed during preparation.",
    fr: "Carte modifiée pendant la préparation.",
    de: "Karte während der Vorbereitung geändert.",
  },
  "Kanaaloverdracht niet bevestigd; frame blijft geblokkeerd.": {
    en: "Channel transfer not confirmed; the frame stays blocked.",
    fr: "Transfert du canal non confirmé ; le repère reste bloqué.",
    de: "Kanalübertragung nicht bestätigt; der Koordinatenrahmen bleibt gesperrt.",
  },
  "Navigatiekaarten zijn niet geldig opgebouwd.": {
    en: "Navigation maps were not built correctly.",
    fr: "Les cartes de navigation n'ont pas été construites correctement.",
    de: "Die Navigationskarten wurden nicht korrekt erstellt.",
  },
  "Dockkanaal verdwenen tijdens reparatie.": {
    en: "Dock channel disappeared during repair.",
    fr: "Le canal de station a disparu pendant la réparation.",
    de: "Dockkanal während der Reparatur verschwunden.",
  },
  "Kies een geldig punt op de foto.": {
    en: "Choose a valid point on the photo.",
    fr: "Choisissez un point valide sur la photo.",
    de: "Wählen Sie einen gültigen Punkt auf dem Foto.",
  },
  "Deze kaart heeft al een verschuiving, rotatie of schaalcorrectie. Controleer die eerst.": {
    en: "This map already has an offset, rotation or scale correction. Check that first.",
    fr: "Cette carte a déjà un décalage, une rotation ou une correction d'échelle. Vérifiez-la d'abord.",
    de: "Diese Karte hat bereits eine Verschiebung, Drehung oder Skalierungskorrektur. Prüfen Sie diese zuerst.",
  },
  "Zet de maaier op het dock en wacht op verse, stabiele RTK Fixed-posities.": {
    en: "Put the mower on the dock and wait for fresh, stable RTK Fixed positions.",
    fr: "Placez la tondeuse sur la station et attendez des positions RTK Fixed récentes et stables.",
    de: "Stellen Sie den Mäher auf die Ladestation und warten Sie auf neue, stabile RTK-Fixed-Positionen.",
  },
  "Dockmeting en opgeslagen dockpositie zijn niet bevestigd. Er is niets gewijzigd.": {
    en: "Dock measurement and saved dock position were not confirmed. Nothing was changed.",
    fr: "La mesure de la station et la position de station enregistrée n'ont pas été confirmées. Rien n'a été modifié.",
    de: "Dockmessung und gespeicherte Dockposition wurden nicht bestätigt. Es wurde nichts geändert.",
  },
  "Zet de doelmaaier op zijn eigen dock met stabiele RTK Fixed-lokalisatie binnen {0} cm van de opgeslagen dockpositie.": {
    en: "Put the target mower on its own dock with stable RTK Fixed localization within {0} cm of the saved dock position.",
    fr: "Placez la tondeuse cible sur sa propre station avec une localisation RTK Fixed stable à moins de {0} cm de la position de station enregistrée.",
    de: "Stellen Sie den Zielmäher mit stabiler RTK-Fixed-Lokalisierung innerhalb von {0} cm der gespeicherten Dockposition auf seine eigene Ladestation.",
  },
  "De kopie of het kaartframe is niet bevestigd.": {
    en: "The copy or the map frame is not confirmed.",
    fr: "La copie ou le repère de la carte n'est pas confirmé.",
    de: "Die Kopie oder der Kartenrahmen ist nicht bestätigt.",
  },
  "De twee kaartkopieën op de doelmaaier verschillen; synchroniseer die eerst.": {
    en: "The two map copies on the target mower differ; sync them first.",
    fr: "Les deux copies de carte sur la tondeuse cible diffèrent ; synchronisez-les d'abord.",
    de: "Die beiden Kartenkopien auf dem Zielmäher unterscheiden sich; synchronisieren Sie diese zuerst.",
  },
  "Het gekozen kaartslot is niet meer vrij.": {
    en: "The chosen map slot is no longer free.",
    fr: "L'emplacement de carte choisi n'est plus libre.",
    de: "Der gewählte Kartenplatz ist nicht mehr frei.",
  },
  "De doelkaart is tijdens de voorbereiding gewijzigd.": {
    en: "The target map changed during preparation.",
    fr: "La carte cible a été modifiée pendant la préparation.",
    de: "Die Zielkarte wurde während der Vorbereitung geändert.",
  },
  "Kaartoverdracht niet bevestigd; de kopie is niet opgeslagen.": {
    en: "Map transfer not confirmed; the copy was not saved.",
    fr: "Transfert de carte non confirmé ; la copie n'a pas été enregistrée.",
    de: "Kartenübertragung nicht bestätigt; die Kopie wurde nicht gespeichert.",
  },
  "De navigatiekaarten zijn niet geldig opgebouwd.": {
    en: "The navigation maps were not built correctly.",
    fr: "Les cartes de navigation n'ont pas été construites correctement.",
    de: "Die Navigationskarten wurden nicht korrekt erstellt.",
  },
  "De kaartreferentie is tijdens de eindcontrole gewijzigd.": {
    en: "The map reference changed during the final check.",
    fr: "La référence de carte a été modifiée pendant le contrôle final.",
    de: "Die Kartenreferenz wurde während der Endkontrolle geändert.",
  },
  "De kaartbestanden zijn tijdens de eindcontrole gewijzigd.": {
    en: "The map files changed during the final check.",
    fr: "Les fichiers de carte ont été modifiés pendant le contrôle final.",
    de: "Die Kartendateien wurden während der Endkontrolle geändert.",
  },
  "De navigatiekaarten zijn tijdens de eindcontrole gewijzigd.": {
    en: "The navigation maps changed during the final check.",
    fr: "Les cartes de navigation ont été modifiées pendant le contrôle final.",
    de: "Die Navigationskarten wurden während der Endkontrolle geändert.",
  },
  "De doelkaart is tijdens de overdracht gewijzigd.": {
    en: "The target map changed during the transfer.",
    fr: "La carte cible a été modifiée pendant le transfert.",
    de: "Die Zielkarte wurde während der Übertragung geändert.",
  },
  "Kaart- of dockbestanden zijn tijdens het herankeren gewijzigd of ontbreken.": {
    en: "Map or dock files changed or went missing during re-anchoring.",
    fr: "Des fichiers de carte ou de station ont été modifiés ou manquent pendant le ré-ancrage.",
    de: "Karten- oder Dockdateien wurden während des Neuverankerns geändert oder fehlen.",
  },
  "Geen bevestigde voertuigmeting ontvangen. Controleer de versie van extended_commands.py en de meetkwaliteit.": {
    en: "No confirmed vehicle measurement received. Check the extended_commands.py version and the measurement quality.",
    fr: "Aucune mesure du véhicule confirmée reçue. Vérifiez la version d'extended_commands.py et la qualité de la mesure.",
    de: "Keine bestätigte Fahrzeugmessung empfangen. Prüfen Sie die Version von extended_commands.py und die Messqualität.",
  },
  "Geen stabiele voertuigmeting met laadcontact en passende dockrichting.": {
    en: "No stable vehicle measurement with charging contact and a matching dock heading.",
    fr: "Aucune mesure stable du véhicule avec contact de charge et orientation de station correspondante.",
    de: "Keine stabile Fahrzeugmessung mit Ladekontakt und passender Dockausrichtung.",
  },
  "Oorsprong gewijzigd tijdens de meting.": {
    en: "Origin changed during the measurement.",
    fr: "Origine modifiée pendant la mesure.",
    de: "Ursprung während der Messung geändert.",
  },
  "Laadcontact, meetkwaliteit of voertuigpositie gewijzigd tijdens de meting.": {
    en: "Charging contact, measurement quality or vehicle position changed during the measurement.",
    fr: "Contact de charge, qualité de mesure ou position du véhicule modifiés pendant la mesure.",
    de: "Ladekontakt, Messqualität oder Fahrzeugposition während der Messung geändert.",
  },
  "De gekozen doelzone bestaat niet meer.": {
    en: "The chosen target zone no longer exists.",
    fr: "La zone cible choisie n'existe plus.",
    de: "Die gewählte Zielzone existiert nicht mehr.",
  },
};
