# Herstelplan voor kaartbackup, zonekopie en geografische projectie

Opgesteld op 25 september 2026 tegen `master` op `742dca0b`, op basis van het [auditrapport](../../reviews/2026-09-25-frames-gps-utm-audit.md) en de tweede beoordeling. Dit document beschrijft het ontwerp en de acceptatie. Uitvoering, voortgang en afhankelijkheden worden uitsluitend bijgehouden in Beads onder `Novabot-55f`.

Aanvulling op dezelfde datum, gecontroleerd tegen `aaf98513`: expliciete keuze en validatie van de herankerprocedure, plus de betekenis van de dockpin bij tekenen op beeld. Nieuwe tekortkomingen in de actuele wizard staan in `Novabot-55f.19`.

Het resultaat moet drie dingen aantoonbaar goed doen: dezelfde kaartset later terugzetten, een zone naar het frame en dock van een andere maaier overbrengen, en beeldpunten betrouwbaar naar echte grondposities vertalen. Softwarecorrectheid en gemeten nauwkeurigheid op de grond krijgen afzonderlijke acceptatie.

## Volgorde en werkpakketten

| Stap | Resultaat | Beads-issues |
|---|---|---|
| 0. Uitgangssituatie vastleggen | Herstelbaar bronmateriaal en verse diagnose van de ankerstrijd op .244 | `.5` |
| 1. Framecontrole sluiten | Eén herstelprocedure, betrouwbare metingen en één gecontroleerd dockanker | `.3`, `.4`, `.5`, `.6`, `.7`, `.19` |
| 2. Backup en restore betrouwbaar maken | Consistente snapshot, bevestigde toepassing, geen gegevensverlies of vals succes | `.1`, `.2`, `.12`, `.14`, `.15` |
| 3. Zonekopie controleren | Geldige referentiemeting en bereikbare verbinding met het doeldock | `.8`, `.10`, `.11` |
| 4. Alle kaartbewerkingen dezelfde conversie geven | Tekenen, penseel, export en import komen overeen met de opgeslagen geometrie | `.9`, `.13` |
| 5. Documentatie gelijk trekken | Uitleg en beperkingen passen bij de opgeleverde code | `.16` |
| 6. Op de grond valideren | Backup, kopie en getekende grenzen na herstart fysiek gecontroleerd | `.17` en fysieke acceptatie van eerdere issues |

Dit is een oplevervolgorde, geen reden om alle implementatie serieel te doen. De ID/transactiefix, planner-timeout, sluiting van oude herstelroutes en metadataverzameling kunnen direct parallel worden ontwikkeld. De verse meting op .244 blokkeert kaart- en oorsprongwijzigingen op die maaier, niet het softwarewerk.

## 0. Diagnose vóór wijzigingen aan .244

Bewaar eerst de originele kaartbestanden, `pos.json`, dock-YAML, beschikbare ZIP, servergeometrie en kalibratie als afzonderlijke bronnen, met tijdstip en hashes. De huidige backupimplementatie wordt daarbij niet als bewezen consistente snapshot behandeld. Lees via de bestaande API/MQTT-bestandsfuncties; eventuele diagnostische SSH-toegang blijft alleen-lezen.

Leg vervolgens tijdens aantoonbaar docken meerdere nieuw ontvangen GPS- en `map_position`-berichten vast, met Fixed-status, lokalisatiestatus en ontvangstmoment. Controleer hetzelfde fysieke voertuigreferentiepunt. Vergelijk die pose met CSV, ZIP/map_info, YAML en DB. De eerder gevonden waarden `(-1.67, 1.19)` en `(0.03, 0.73)` zijn diagnosegegevens, geen automatisch te kiezen waarheid.

Een match met YAML kan aanleiding zijn de serverreferentie via de gerepareerde toepassing te corrigeren. Een match met de CSV rechtvaardigt niet vanzelf herankeren: eerst vaststellen welke relatie met de onverplaatste grondkaart behouden moet worden. Bij een andere uitkomst blijven kaartschrijven en herankeren geblokkeerd. Geen handmatige DB-inserts of edits op de maaier als hersteloplossing.

Acceptatie: reproduceerbaar meetverslag met bron, tijd, spreiding, voertuigpunt en gemotiveerd gekozen anker. De oorspronkelijke bestanden blijven beschikbaar.

## 1. Eén gecontroleerde frame- en herstelprocedure

Werk in de bestaande `frameValidation.ts`, `anchor.ts`, MQTT-ingang en reanchor-wizard. Hergebruik `checkDockedFrame`, `medianGps` en `gpsSpreadMeters`; voeg geen tweede herstelwizard toe.

- Verwijder de oude “Automatic (1m drive)” en “Restore + Realign”-uitvoeringspaden. UI verwijst naar de actuele wizard; oude API-aanroepen geven een duidelijke fout/verwijzing en voeren geen oude neveneffecten uit.
- Verwijder vrijgave via alleen `noteAutoRecharge()` plus een docked-bericht. Alle aanroepers van `clearFrameUnvalidated` moeten aan dezelfde expliciete eindcontrole voldoen. Een beweging of serverherstart mag de blokkade niet stil opheffen.
- Registreer ontvangsttijd en sample-identiteit voor GPS, lokale pose en kwaliteitsstatus, ook als de numerieke waarde ongewijzigd blijft. De huidige `lastPoseAt` voor wifi-historie bewijst geen verse GPS. Een cache-uitlezing is geen nieuw meetbericht.
- Laat de stabiliteitscontrole acht daadwerkelijk nieuwe Fixed-metingen gebruiken. Behoud aanvankelijk de bestaande 10 cm spreidingsgrens als herstelvoorwaarde; dit is geen centimetergarantie. Bepaal maximale sampleleeftijd en timeout uit de gemeten berichtcadans. Bij onvoldoende verse gegevens volgt een zichtbare fout, nooit acceptatie van herhaalde cachewaarden.
- Controleer tijdens het meetvenster opnieuw dockstatus en kwaliteit. Voor de eindvrijgave zijn daarnaast verse pose, gezonde lokalisatie en de benodigde relock na oorsprongwijziging vereist.
- Laat DB, ZIP en maaierbestanden dezelfde gecontroleerde dockreferentie gebruiken. Behoud de vastgelegde heading met herkomst; de fallback `1.5` is geen gemeten dockoriëntatie. Bij ontbrekend of tegenstrijdig anker weigeren functies die dat anker nodig hebben.
- Stuur bij `reanchor_pos` expliciet `anchor_x` en `anchor_y` mee. De firmware accepteert alleen eindige waarden en valt bij een ontbrekend anker niet stil terug op `(0,0)` of uitsluitend map0.

De beeldpin, navigatie-oorsprong en fysieke dockpose blijven afzonderlijke gegevens. Een werkelijk verplaatst dock krijgt een nieuwe gemeten koppeling met de bestaande grondkaart. De formule voor basisdrift mag die kaart niet ongemerkt met het dock laten meeverhuizen.

Acceptatie: losse dockberichten, Float, oude pose, ontbrekend anker, map1 zonder map0 en een onderbroken relock kunnen geen geldige eindstatus opleveren. De bestaande 0,4 m-grens blijft uitsluitend de herstelcontrole; strengere grondnauwkeurigheid wordt apart gemeten.

### 1a. Wanneer herankeren nodig is en hoe de procedure beter wordt

Het principe is passend voor een verschoven GNSS-/UTM-oorsprong bij een onverplaatst fysiek referentiepunt. Het is geen algemene oplossing voor iedere kaartafwijking. De keuze wordt:

| Vastgestelde situatie | Handeling |
|---|---|
| Zelfde maaier/dock en herstelde kaart past nog in het huidige frame | Eerst vers verifiëren; geen oorsprong herschrijven en geen verplichte rit |
| Dock staat fysiek hetzelfde, oorsprong/basiscoördinaten zijn verschoven | Herankeren met behoud van het opgeslagen dockanker en de lokale polygonen |
| Alleen maaierkaart versus foto staat verkeerd | Beeldkoppeling corrigeren; geen `pos.json`-wijziging |
| Dock is werkelijk verplaatst | Nieuwe dockpose in het bestaande kaartframe meten en dockkanaal aanpassen; de grondkaart behouden |
| Zone komt van een andere maaier | Eerst de fysieke correspondentie tussen de twee frames vaststellen via de kopieprocedure |

De huidige `settleRestoredFrame` biedt al een controle zonder herschrijven, maar mist verse meetgegevens. De wizard schrijft daarna wel de oorsprong en de Python-handler controleert dat de ROS-load succes meldt. Die basis blijft bruikbaar; het volledige bewijs rond die handelingen moet sterker.

De aangeklikte foto-pin is geen bron voor deze oorsprongberekening. Herankeren gebruikt de actuele GNSS-metingen in het referentiestelsel van de maaier; de beeldpin koppelt dat lokale frame afzonderlijk aan de foto. Een nauwkeurig aangewezen beeldpunt en een GNSS-positie met basisbias mogen niet als uitwisselbare metingen worden behandeld.

De verbeterde herankercyclus gebruikt de bestaande wizard en heeft deze volgorde:

1. Stel het juiste kaartanker, de kaartversie en het fysieke referentiepunt vast en zet ze voor deze cyclus vast. Blokkeer overlappende kaart-/herankeroperaties. Laat latere dockcommando's de meetreferentie niet ongemerkt vervangen.
2. Meet verse, stabiele Fixed-GPS terwijl de maaier aantoonbaar gedockt is. Verifieer of GPS het antennepunt of hetzelfde voertuigpunt als `map_position` beschrijft. Pas een antenne-offset alleen toe als bewezen is dat de actieve firmware die nog niet verwerkt.
3. Bereken de oorsprong uit die meting en het expliciete kaartanker. Bewaar de oude oorsprong; schrijf en laad de nieuwe. Vergelijk de teruggegeven origin/anchor met het doel en controleer de toegepaste oorsprong. Gebruik één operatie-ID; start geen nieuwe write omdat de server eerder uit zijn wachttijd loopt dan de firmware.
4. Laat alleen indien nodig gecontroleerd bewegen om opnieuw te lokaliseren. Toon de operator de vereiste vrije ruimte; begrens beweging en stop bij verlies van verse telemetrie. Bewijs werkelijk verlaten van het dock, verplaatsing en verse RUNNING+Fixed na de origin-load. Een getimede achteruitopdracht plus oude status is onvoldoende.
5. Laat de gebruiker de maaier voor het dock positioneren en voer de visuele dockprocedure uit. `continue_dock` vereist op de server de juiste fase en bewezen relock. Controleer de echte uitkomst van `save_recharge_pos`; bij onbekende uitkomst eerst vaststellen wat is gebeurd. Onderzoek op de gebruikte firmware of het tijdelijke dockinformatie of blijvende ankers wijzigt; controleer die vóór/na en gebruik het juiste mapN.
6. Controleer na terugkeer meerdere verse gedockte Fixed/RUNNING-posities tegen het oorspronkelijke vastgezette anker, met onveranderde bedoelde oorsprong. Geen anker betekent fout, geen `(0,0)`-fallback. Alleen deze eindcontrole mag vrijgeven.
7. Toets voor nauwkeurigheidsclaims ook een onafhankelijk bekend grondpunt verder van het dock. Een passend dockpunt controleert vooral translatie; het bewijst geen juiste beeldrotatie, schaal of geringe fout elders.

Concrete tekortkomingen van de huidige wizard: [eindvrijgave](../../../server/src/routes/dashboard.ts#L3399) gebruikt alleen één gecachte afstand en een nulanker-fallback; [relock](../../../server/src/routes/dashboard.ts#L3525) controleert alleen gecachte RUNNING+Fixed; [continue_dock](../../../server/src/routes/dashboard.ts#L3792) mist de fase-/relockvoorwaarde. De server negeert de origin/anchor uit het reanchor-antwoord en zijn timeout is korter dan het totale retrybudget van de Python-handler. Dit valt onder `.19`, naast de al vastgestelde metings- en ankerproblemen.

Visueel docken brengt de maaier naar dezelfde fysieke plek; het corrigeert niet vanzelf een fout in de GNSS-antennegeometrie of kaartprojectie. De comment dat visueel docken de resterende antenne-offset corrigeert mag daarom geen centimeternauwkeurigheid onderbouwen.

## 2. Consistente backup en aantoonbaar herstel

### Eén toepassing per maaier

Hergebruik `applyVerbatimToMower`, de bestaande extended-command-wachtfunctie, import-staging en `mapApplyStatus`. Breng gedeelde wacht- en serialisatielogica onder bij de MQTT/toepassingslaag. Alle aanroepers, inclusief cloud-import, adminrestore, automatische kaartpush en snapshotlezen, gebruiken deze grens.

Er mag per serienummer één kaartoperatie lopen. Een tweede interactieve restore krijgt `409 busy`; opeenvolgende gewone kaartbewerkingen mogen hoogstens een volgende push van de nieuwste versie verzamelen. Leg voor een actieve operatie de exacte payload of ZIP met hash vast, zodat een veranderend `_latest.zip` de inhoud niet tijdens overdracht vervangt.

Geef commando's een `operation_id` en laat de firmware die in antwoorden teruggeven. Alleen dezelfde maaier, commandonaam en operatie-ID mogen de wachtende operatie afronden. Voeg op de maaier een gedeelde lock toe voor de betrokken kaartschrijvers en snapshotreads. Oude firmware zonder aantoonbare ondersteuning krijgt geen bevestigde herstelroute aangeboden.

### Eén snapshotbron

Neem de live CSV's, YAML en rasterbestanden als één gecontroleerde set op. Leid de backupgeometrie daarvan af; gebruik DB-inhoud voor namen en aliassen, niet als tweede onafhankelijke geometriebron. Leg bestandsnamen, hashes, volledigheid en capturetijd vast. Houd een gegenereerde kaartbundel herkenbaar verschillend van een live snapshot.

Hergebruik de bestaande CSV-parser en naamherkenning, met behoud van lege of uitsluitend via metadata bestaande kanalen en de volledige `x3_csv_file`-kanalen waar van toepassing. Normaliseer reeds toegepaste polygon-offsets precies één keer; een restore mag een oude offset niet opnieuw optellen.

Een firmwarelock beschermt niet tegen iedere stock ROS-schrijver. Maak de snapshot daarom buiten mapping/maaien, controleer bronmanifesten vóór en na capture en weiger een veranderde of incomplete set. Oude backups blijven leesbaar, maar ontbrekend bewijs van consistentie wordt niet verzwegen.

### Volgorde van restore

1. Valideer bundel, bestandsnamen, inhoud, doelmaaier en ondersteunde firmware volledig. Toon welke kaartset wordt vervangen. Een volledige snapshotrestore mag niet worden gepresenteerd als het terugzetten van uitsluitend één zone.
2. Bereid serverrijen en een herstelkopie voor. Gebruik `crypto.randomUUID()` voor interne `map_id`; behoud canonical names als firmware-identiteit. Laat zowel `importParsedBundleServerCopy` als apply-verbatim één transactionele importhelper gebruiken.
3. Controleer online/ruststatus, pak de operatielock en bewaar operatie-ID, manifest en status in de bestaande staging. Blokkeer navigatie vóór de eerste apparaatwrite.
4. Laat de firmware alle bytes en de herstelkopie controleren vóór bestaande bestanden worden verwijderd. Ongeldige base64, ontbrekende verplichte bestanden of een mislukte backup zijn fouten vóór die verwijdering.
5. Wacht op het antwoord op `write_map_files`. Lees vervolgens de bestanden terug en vergelijk inhoud en bestandsset, inclusief bestanden die verwijderd moesten worden. Een ACK of bestandsaantal alleen is onvoldoende.
6. Commit de voorbereide serverkaart, oriëntatie en offsetinstellingen in één korte SQLite-transactie. Houd die transactie niet open tijdens MQTT-wachten.
7. Markeer de import pas daarna als `APPLIED`. Toon framevalidatie en maaiergereedheid afzonderlijk. Een planner-timeout blijft een fout/onvoltooide toepassing en mag niet eindigen in `done()`; oude of ontbrekende telemetrie bewijst geen teruggekeerde planner.

Bij een apparaatwrite gevolgd door een DB-fout blijft zichtbaar dat het apparaat mogelijk al veranderd is. De blokkade en gevalideerde staging blijven bestaan om de servertoestand te kunnen herstellen. Bij timeout is de uitkomst **onbekend** totdat read-back die vaststelt. Na herstart of reconnect eerst reconciliëren; geen blinde herhaling van writes en geen herinschakeling van de momenteel uitgezette automatische reconnect-push.

Dit is gecontroleerd, herstelbaar toepassen. SQLite en de maaier vormen geen gezamenlijke atomaire transactie. Bij een onderbroken installatie mogen gedeeltelijke bestanden nooit leiden tot “klaar” of navigatievrijgave.

Acceptatie: restore naar A en daarna B behoudt beide serverkaarten; een insertfout rolt de hele DB-wijziging terug; geen antwoord, verkeerd antwoord, corrupte rasterinhoud, bestandsverschil, gelijktijdige push of planner-timeout levert vals succes op. Een herstart midden in toepassen blijft herkenbaar en herstelbaar.

## 3. Zonekopie met betrouwbare referentie en doeldock

Laat de meetknop een door de server gecontroleerde meting gebruiken: verse pose, Fixed, gezonde lokalisatie, gevalideerd frame en stabiele stilstand. Bewaar bron, sample-identiteit en kwaliteit bij de gekozen referentie. Controleer bij toepassen opnieuw of die meting nog bij de betreffende frames en ankers hoort. Een foto-klik blijft bruikbaar als handmatige plaatsing, maar krijgt niet de nauwkeurigheidsstatus van een meting.

Voor de eerste veilige oplevering weigert de gedeelde kopieerfunctie niet-nul polygon-offsets, vóór enige wijziging. Voor volledige ondersteuning wordt daarna voor zones, obstakels en kanalen dezelfde transformatie gebruikt:

```text
pDB_B = pDB_A + offset_A - dockA_in_A + dockA_in_B - offset_B
```

Dit veronderstelt dezelfde UTM-gridassen en schaal; bij een onbekende of afwijkende framebasis wordt die aanname niet stil toegepast. Het bestaande dock van B blijft het doeldock. De kopie krijgt een verbinding naar B of naar een aantoonbaar vanaf B bereikbaar gebied; het eerste dockpunt schuift niet mee met een polygon-offset.

Controleer bestaande én gekopieerde obstakels, doorgangsbreedte en bereikbaarheid vanaf het doeldock. Hergebruik de bestaande geometriehelpers en aanwezige polygonbibliotheek. Bouw geen nieuwe algemene routeplanner: als een bruikbare verbinding niet bewezen kan worden, vraag via de bestaande kanaalflow om een expliciet kanaal. Puntcontact of overlap met een geïsoleerde zone is onvoldoende.

Acceptatie: ongeschikte metingen worden ook via directe API-aanroepen geweigerd; preview, DB en uiteindelijke CSV komen overeen; B houdt zijn dock; bestaande B-obstakels en geïsoleerde zones leiden niet tot een onterecht “verbonden”. Controleer na opnieuw laden dat dock en kanalen behouden zijn.

## 4. Hetzelfde coördinatencontract voor alle kaartacties

Leg voor ieder bestaand veld vast of het ruwe kaartmeters, een fysieke polygonverschuiving of uitsluitend beeldplaatsing betreft. Een fysieke zoneverschuiving verandert de live voertuigpose niet. Bestaande kalibraties mogen bij migratie niet zonder controle een andere betekenis krijgen.

Gebruik de al aanwezige gridconversies in `mapConverter.ts` en `coords.ts`; maak geen nieuwe GIS-laag. Laat tekenen, penseel, marker, kopiepreview, navigatie, GPS-API en GeoJSON hetzelfde dockanker en dezelfde heen/terugtransformatie gebruiken. Neem ook reeds ondersteunde rotatie en schaal mee in de inverse. Corrigeer de oude GPS-paden in `portableMap.ts` en de dashboardroutes.

Laat de normale appkaart met lokale meters en `dockPose` intact. De slapende GPS-patrooncode is geen reden voor een app-herschrijving; als die later weer wordt geactiveerd, moet zij ditzelfde contract gebruiken. Geografisch geplaatste dronehoeken mogen tussen maaiers worden gedeeld, mits elk maaierframe afzonderlijk correct op dat beeld is aangesloten.

Acceptatie: klik → opslag → CSV → kaart komt terug op hetzelfde punt, ook met niet-nul offsets, niet-nul dockanker en aanwezige rotatie/schaal. Een verandering van alleen beeldplaatsing wijzigt geen maaierbestanden. De bestaande PROJ-referentiechecks blijven slagen.

### 4a. Wat een verplaatste dockpin daadwerkelijk betekent

Er zijn twee afzonderlijke koppelingen: de maaier rekent zijn GNSS-metingen via `pos.json` om naar lokale kaartmeters; het dashboard rekent lokale kaartmeters via dockanker en beeldpin om naar de foto. Bij tekenen en navigeren wordt die tweede koppeling andersom gebruikt.

| Actie | Direct gevolg voor bestaande kaart/maaier | Gevolg voor latere kaartklikken |
|---|---|---|
| Dockpin op het beeld verplaatsen | Kalibratiereferentie verandert. Zones en lokale maaiermarker schuiven op het scherm; bestaande lokale punten en oorsprong blijven gelijk | Dezelfde beeldklik wordt andere lokale meters en kan na opslaan/push een andere fysieke grens of rijbestemming opleveren |
| Dronefoto verplaatsen/vervormen | Alleen de foto-overlay verandert; maaierbestanden blijven gelijk | Een herkenbaar detail in de verplaatste foto ligt op een andere kaartpositie en leidt bij aanklikken tot andere lokale meters |
| Fysieke polygonverschuiving toepassen | Effectieve CSV-zonepunten veranderen na push; het maaigebied verandert daadwerkelijk | Volgende bewerkingen moeten die verschuiving correct meenemen |
| Herankeren | `pos.json` en de geladen GNSS-naar-kaartkoppeling veranderen; daarmee verandert de fysieke betekenis van dezelfde lokale punten | Eerst opnieuw frameconsistentie vaststellen |

De pin is dus een **kalibratie-invoer**: de gebruiker verklaart waar het bekende dockpunt op het beeld thuishoort. Het is geen nieuwe GPS-meting, maar de juistheid ervan beïnvloedt wel de fysieke uitkomst van tekenen. De bekende antenne-/voertuigreferentie moet op het juiste beeldpunt worden gezet; zomaar het midden van de chargerafbeelding kan een ander punt voorstellen.

Voorbeeld bij nul overige offsets: de pin 1 m oostwaarts zetten laat een bestaande zone op het scherm ongeveer 1 m oostwaarts schuiven. De bestaande maaierroute blijft fysiek gelijk. Vervolgens dezelfde vaste hoek op de foto aanklikken levert ongeveer 1 m westelijker lokale geometrie op. Een onjuist geplaatste pin kan zo nieuwe zones verkeerd plaatsen, ook al wordt bij het verslepen zelf niets naar de maaier gestuurd.

Geverifieerd pad: [handlePlaceCharger](../../../dashboard/src/components/map/MowerMap.tsx#L3545) → [calibration PUT](../../../server/src/routes/dashboard.ts#L3229). Dat pad schrijft geen lokale polygonen, CSV of `pos.json`. Het zet de visuele offsets wel op nul, terwijl [setCalibration](../../../server/src/db/repositories/maps.ts#L532) fysieke polygon-offsets bewaart. De combinatie na een eerdere polygonverschuiving valt daarom onder `.9`; de tabel maakt dat bestaande probleem niet correct.

Gewenste bediening: benoem afzonderlijk “kaart op foto uitlijnen”, “maaigebied fysiek verschuiven” en “navigatie opnieuw ankeren”. Toon bij uitlijnen dat bestaande routes gelijk blijven, maar nieuwe tekening/navigatie de gewijzigde koppeling gebruikt. Heranker nooit automatisch als reactie op het verplaatsen van de beeldpin.

## 5. Documentatie bij de opgeleverde code

Werk `FRAMES-GPS-UTM.md`, `REANCHOR.md`, herstelteksten en relevante codecomments samen met de betrokken fixes bij. Beschrijf grid-ENU, basisdrift versus fysiek dockverplaatsen, de daadwerkelijke werking van `reanchor_pos`, de aanwezige `gps_latitude`-velden, deelbare geografische dronehoeken en de beperkte betekenis van de 0,4 m-controle.

Documenteer noodzakelijke server-/firmwareversies en beperkingen van oudere backups. Presenteer gewenst gedrag pas als bestaand gedrag nadat de betreffende fix aantoonbaar werkt. De nauwkeurigheidswens blijft apart van herstelvoorwaarden en RTK-status.

## 6. Testen, uitrollen en op de grond meten

| Onderdeel | Gerichte regressie en bestaande plek |
|---|---|
| Framecontrole | `frameValidation.test.ts`, `dashboardReanchorAuto.test.ts`, `reanchorGps.test.ts`: passieve dockvrijgave, dubbele cachewaarde, Float, ongeldige pose, ontbrekend anker, map1 zonder map0, oude RUNNING-status, onjuiste continue_dock-fase en een gewijzigd referentieanker |
| Restore | `portableMapImport.test.ts`, `adminMapBackupRestore.test.ts`, `importStaging.test.ts`: twee maaiers, DB-rollback, offline/busy, verkeerde/late ACK, read-back mismatch en herstart tijdens toepassen |
| Snapshot | `portableBackupInitial.test.ts`, `portableBackupChargingPose.test.ts`, `portableMap.test.ts`: afwijkende DB/live-data, lege kanalen, offsets en wijzigingen tijdens capture |
| Toepassing | `mapApplyStatus.test.ts` en MQTT-tests: één writer per maaier, vaste payload, operation-ID en blijvende timeoutfout |
| Kopie en tekenen | Bestaande zoneCopy-tests en `coords.check.ts`: bron/doeloffset, doeldock, bestaande obstakels, bereikbaarheid en heen/terugconversies |
| Firmware | Kleine checks met tijdelijke bestanden en threads: prevalidatie vóór delete, serialisatie, volledige read-back en operation-ID in antwoorden |

Breid de bestaande suites uit met de aangetoonde foutgevallen. Bij relevante wijzigingen volgen server-TypeScriptcontrole/build, dashboardbuild en Pythonchecks. Daarna de samenhangende backup/herstel/kopie/projectietests; groen op losse wiskunde is onvoldoende. De eerder geslaagde 160 checks zijn een historische uitgangsmeting, geen validatie van toekomstige fixes.

Lever server- en firmwarewijzigingen via de bestaande release- en firmwarebuildscripts op. Eerst de gecontroleerde firmwareondersteuning beschikbaar maken, daarna de afhankelijke schrijfroute activeren. Verifieer de werkelijk draaiende versies. Gebruik geen handmatige patch op een maaier als eindoplossing. Dit plan start zelf geen build, deployment of rit.

Voer na de softwarecontroles een begeleide proef uit met vooraf bewaarde herstelbestanden. Begin met bestandsvergelijking, framecontrole en stilstaande herkenbare grondpunten. Test vervolgens restore op dezelfde maaier en zonekopie naar de andere maaier, met controle van doeldock en kanalen na opnieuw laden en reboot. Een doelgebied geldt pas als bruikbaar na een gecontroleerde fysieke proef.

Voor tekenen op beeld is het voorgestelde werkdoel maximaal **3 cm horizontale afwijking op onafhankelijke grondcontrolepunten**. Dit is een acceptatiedoel, geen toegezegde haalbaarheid met de huidige hardware of foto. Leg eerst vast of de getekende grens het voertuigreferentiepunt of de maairand bedoelt, en verifieer antenne-offset, heading en mechanische herhaalbaarheid. Meet herkenbare grondpunten verspreid over het terrein; houd afzonderlijke punten over die niet voor de passing worden gebruikt. Rapporteer maximum en spreiding, ook na herstart/basisherstart.

De gebruikelijke luchtfoto kan als achtergrond dienen, maar ondersteunt op zichzelf geen claim dat een aangeklikte grasrand op 3 cm klopt. PDOK noemt 5/8 cm pixels voor winterbeelden en 25 cm voor zomerbeelden; dat is beeldresolutie, geen gegarandeerde grondnauwkeurigheid. Een scherpe, geometrisch gecorrigeerde droneopname met ingemeten grondreferenties biedt meer mogelijkheden. Gewone drone-GPS of WGS84-labels alleen volstaan niet. [PDOK](https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-), [Pix4D over relatieve en absolute nauwkeurigheid](https://support.pix4d.com/hc/en-us/articles/202558889).

Voor maaien in dezelfde tuin kan een gecontroleerde lokale foto-naar-maaierkoppeling voldoende zijn, ook als de absolute GNSS-coördinaten een gezamenlijke verschuiving hebben. Dat vereist een stabiel maaierframe, passende beeldgeometrie en meerdere herkenbare grondreferenties met onafhankelijke controlepunten. Een passend dockpunt alleen bewijst niet de hele tuin. Externe WGS84-data delen vraagt daarnaast een correcte absolute georeferentie.

Vergelijk opgeslagen/geprojecteerde grens en werkelijk gereden grens afzonderlijk. Als beeldresolutie, georeferentie of voertuiggedrag het doel niet halen, blijft de gemeten grotere fout zichtbaar. Gebruik het nauwkeurigheidsdeel van het auditrapport om dan een betere droneopname, grondreferenties of orthorectificatie te kiezen; extra inzoomen of een extra offset is geen bewijs van verbetering.

## Afhankelijkheden in Beads

Voor bevestigde restore `.2` zijn de transactionele import `.1` en gecorreleerde toepassing `.14` nodig. Consistente live backup `.12` bouwt op dezelfde beschermde snapshotread uit `.14`. De betrouwbare meetknop `.10` vereist verse meetmetadata uit `.7`.

De actuele herankercyclus `.19` bouwt op het gecontroleerde anker `.5`, verse meetmetadata `.7` en gecorreleerde/geserialiseerde uitvoering `.14`. De uiteindelijke grondvalidatie `.17` volgt pas na de technische herstelissues `.1` tot en met `.15` en `.19`. Voorbereidende grondmetingen mogen eerder; de afhankelijkheden betekenen dat de eindacceptatie nog niet gereed kan worden verklaard. Documentcorrecties `.16` lopen met de fixes mee. Er worden geen extra afhankelijkheden toegevoegd alleen omdat werkpakketten na elkaar in de tabel staan.
