# Controle van FRAMES-GPS-UTM, backup/herstel en zonekopie

Onderzocht op 25 september 2026, lokale broncode op `a8acf7ab`. Dit is een beoordeling, geen implementatie van de voorgestelde reparaties. De server-API en bestanden op beide maaiers zijn alleen gelezen; er zijn geen rij-, herstel-, synchronisatie- of firmwarecommando’s verstuurd. De gelijkheid van alle gedeployde uitvoerbare bestanden met deze lokale broncode is niet vastgesteld.

**Oordeel:** de kern van de UTM-uitleg klopt. De bestaande code biedt de benodigde bouwstenen, maar heeft concrete fouten in herstel, ankerkeuze, offsets en validatie. Een garantie van enkele centimeters op de grond volgt niet uit het document of de huidige controles.

## Direct op beide maaiers gecontroleerd

| Referentie | .244 / LFIN2230700238 | .100 / LFIN1231000211 |
|---|---|---|
| `pos.json.utm_origin` | (310532.558503, 5780319.396454), zone 32 | (310524.467898, 5780324.788907), zone 32 |
| Eerste regel dock-CSV | (-1.67, 1.19) | (0.13, -0.52) |
| `charging_station.yaml` | (0.03, 0.73), heading -1.518115 | (0.125029, -0.516909), heading 1.575185 |
| Dashboard `chargingPose` | (-1.667940, 1.192457), heading 1.5 | (0.125029, -0.516909), heading 1.575185 |
| Handmatige kaartoffset | 0 | 0 |

Op .244 liggen de twee dockreferenties **1.760 m** uit elkaar. Dit is het in het document genoemde probleem, nu opnieuw rechtstreeks vastgesteld. Het dashboard gebruikt de afwijkende CSV/ZIP-referentie. Dat beide waarden bestaan is bewezen; welke waarde nu fysiek correct is, vereist een verse dockmeting met dezelfde voertuigreferentie. Niet blind de ene waarde over de andere schrijven.

De dock-drift-API meldt als laatste dag 24 september: .100 circa 6 cm afwijking, .244 circa 11.07 m. Die .244-waarde is een historische aggregatie, geen nieuwe meting van een huidige dockpositie. Een oorzaak kan hieruit niet worden vastgesteld.

## Belangrijkste fouten

### 1. P1 - Herstel van de tweede maaier kan zijn serverkaarten wissen

[adminStatus.ts:3308](../../server/src/routes/adminStatus.ts#L3308) verwijdert eerst alle kaarten van de doelmaaier. Daarna worden vaste IDs zoals `imp_work_0` gebruikt. [database.ts:64](../../server/src/db/database.ts#L64) maakt `map_id` globaal uniek, dus niet alleen per maaier.

Reproductie: herstel A en vervolgens B. De tweede insert botst met A. De delete van B is dan al uitgevoerd, buiten een transactie; bovendien is de opdracht aan B al verstuurd. Een geïsoleerde SQLite-reproductie eindigde met `UNIQUE constraint failed: maps.map_id` en nul kaarten voor B.

Nodig: unieke IDs en één DB-transactie. Eerst een complete herstelset valideren en het toepassen bevestigen; een gedeeltelijke fout mag niet als voltooide restore zichtbaar worden.

### 2. P1 - Gewoon backupherstel meldt succes zonder bevestiging van de maaier

Het normale snapshotherstel gaat via staging naar `apply-verbatim`. [mapSync.ts:687](../../server/src/mqtt/mapSync.ts#L687) publiceert `write_map_files`; dezelfde functie retourneert onmiddellijk `pushed: true`. [adminStatus.ts:3339](../../server/src/routes/adminStatus.ts#L3339) zet de import op `APPLIED`. De gerapporteerde aantallen geschreven bestanden zijn aantallen uit het aangeboden pakket, geen teruggelezen resultaat.

Dit pad wacht niet op `write_map_files_respond`, controleert hier niet of de maaier online en in rust is en verifieert de geïnstalleerde bestanden niet. Een offline maaier of schrijffout kan dus dezelfde succesmelding geven. De Python-handler heeft wel foutantwoorden; deze aanroeper benut ze niet.

Nodig: navigatie vooraf blokkeren, online/rustvoorwaarden, bevestiging afwachten en een onzekere uitkomst zichtbaar houden. Daarna de bestanden/inhoud controleren en pas vervolgens `APPLIED` melden. De gewone verbatim-restore herstelt bewust **geen `pos.json`**; een veranderde oorsprong vraagt afzonderlijke, gevalideerde herankering.

### 3. P1 - Er bestaat nog een oude herstelprocedure die de nieuwe veiligheidscontrole omzeilt

Het adminscherm biedt na herstel nog “Automatic (1m drive)” aan via [adminPage.ts:4940](../../server/src/routes/adminPage.ts#L4940). Die route gebruikt [adminStatus.ts:3468](../../server/src/routes/adminStatus.ts#L3468): `go_to_charge` met `bypassFrameGuard: true`. De codecomment veronderstelt dat docken `pos.json` opnieuw schrijft, terwijl de nieuwe documentatie dat juist ontkracht. Deze route voert geen `reanchor_pos` uit.

Daarnaast wist [frameValidation.ts:134](../../server/src/services/frameValidation.ts#L134) de blokkade zodra na `noteAutoRecharge()` een docked-bericht komt. Vertrek van het dock, RTK Fixed, opnieuw gelokaliseerd zijn en afstand tot het anker worden daar niet gecontroleerd. Een geïsoleerde aanroep van de daadwerkelijke functies bevestigde dat alleen deze twee berichten de blokkade wissen.

Nodig: alle herstelknoppen naar dezelfde actuele procedure laten verwijzen. Alleen expliciete eindvalidatie mag de blokkade opheffen. De documentclaim dat dit uitsluitend na de 0.4 m-controle gebeurt, klopt momenteel niet voor alle codepaden.

### 4. P1 - De oude “Restore + Realign” accepteert een ongeschikte GPS-positie

[adminStatus.ts:1473](../../server/src/routes/adminStatus.ts#L1473) leest gecachte GPS en controleert alleen eindige, niet-nul waarden. Dockstatus, Fixed-status en versheid zijn geen voorwaarden. Het pad overschrijft bovendien de handmatig geplaatste beeldpin met deze GPS en autoriseert daarna het schrijven van `pos.json`.

Als de maaier elders staat, wordt die plek de nieuwe referentie voor het oude dockanker. Zelfs bij correct docken kan de absolute GNSS-bias de zorgvuldig geplaatste beeldpin opnieuw meters verzetten.

Nodig: deze dubbele procedure samenvoegen met de actuele herankering; beeldpin en navigatie-oorsprong afzonderlijk bewaren.

### 5. P1 - Tegenstrijdige dockankers worden niet geweigerd

[anchor.ts:122](../../server/src/services/anchor.ts#L122) en [canonicalNaming.ts:108](../../server/src/services/canonicalNaming.ts#L108) vertrouwen het DB-dockkanaal. [dashboard.ts:752](../../server/src/routes/dashboard.ts#L752) haalt de projectiereferentie uit de nieuwste ZIP. Gewone sync houdt een bestaande geldige dock-YAML bewust intact, zie [extended_commands.py:5126](../../research/extended_commands.py#L5126).

Daarmee blijft de live aangetroffen tegenspraak op .244 bestaan en kan zij volgende kopieën, getekende zones en herankeringen beïnvloeden. Nodig: één gevalideerd dockanker, met consistentiecontrole tussen CSV, map_info, YAML en verse dockpositie. Bij tegenspraak geen automatische nieuwe geometrie of oorsprong toepassen.

### 6. P2 - Server en maaier zoeken verschillende dockkanalen bij herankeren

De server accepteert iedere `mapNtocharge_unicom`. [extended_commands.py:4605](../../research/extended_commands.py#L4605) leest alleen `map0tocharge_unicom` en valt anders stil terug op `(0,0)`. [dashboard.ts:3504](../../server/src/routes/dashboard.ts#L3504) geeft geen expliciet anker mee, hoewel Python `anchor_x/y` ondersteunt.

Na verwijderen van map0 terwijl map1 met dockkanaal overblijft, kan de firmware rond nul herankeren terwijl de server tegen een ander anker valideert. Nodig: het gevalideerde anker expliciet meesturen en een onbekend anker weigeren.

### 7. P2 - Acht “stabiele GPS-metingen” kunnen één oud cachebericht zijn

[dashboard.ts:3413](../../server/src/routes/dashboard.ts#L3413) leest elke seconde dezelfde cache en telt elke uitlezing als nieuw sample. Er is geen ontvangsttijd- of sequencecontrole. Dezelfde GPS-waarde wordt na zeven seconden als acht samples met nul spreiding geaccepteerd; dit is met de daadwerkelijke functie geïsoleerd gereproduceerd.

Dat bewijst geen stabiliteit. Als de cache nog een positie van vóór het docken bevat, kan de nieuwe oorsprong daarop worden gebaseerd. Nodig: afzonderlijke verse GPS-berichten tellen, met bijbehorende kwaliteit en dockstatus. De timeout moet bij de echte berichtfrequentie passen. De genoemde circa 50 s GPS-cadans is in deze audit niet opnieuw gemeten.

### 8. P1 - Zonekopie verliest bestaande polygonverschuivingen

[zoneCopy.ts:284](../../server/src/services/zoneCopy.ts#L284) transformeert ruwe DB-punten. A’s ingestelde polygon-offset ontbreekt. [mapConverter.ts:356](../../server/src/mqtt/mapConverter.ts#L356) voegt B’s offset bij het maken van de ZIP alsnog toe.

Bij een correct gemeten correspondentie is de fysieke fout daardoor `offset_B − offset_A`. Bijvoorbeeld: A heeft de zone 50 cm verschoven, B niet; de kopie verliest die 50 cm. Dit is een fout ook als de meetknop een perfecte meting levert. De huidige nuloffsets op beide live maaiers activeren dit specifieke geval niet.

Voor dezelfde UTM-assen hoort het opslagmodel te zijn:

```
pDB_B = pDB_A + offset_A − dockA_in_A + dockA_in_B − offset_B
```

Kanaalplanning moet de uiteindelijke geometrie gebruiken, met behoud van het niet-meeschuivende dockanker.

### 9. P2 - Tekenen en penseelbewerking draaien de weergavetransformatie niet volledig terug

Weergave gebruikt `calibratePoints`, maar [MowerMap.tsx:2587](../../dashboard/src/components/map/MowerMap.tsx#L2587) en [MowerMap.tsx:3083](../../dashboard/src/components/map/MowerMap.tsx#L3083) trekken de actieve weergave-offset niet van de klik af. Kopiëren en navigeren doen dat wel. Rotatie/schaal zijn bovendien nog aanwezig in de weergave zonder overal dezelfde inverse.

Numerieke reproductie met de actuele `coords.ts`: bij een bestaande +1 m verschuifinstelling wordt een nieuw aangeklikt punt op x=10 m na opslaan op x=11 m getoond en in het effectieve maaierbestand gezet. De penseelbewerking kan op de onverschoven locatie ingrijpen.

Dezelfde instelling wordt ook bij live maaierposities opgeteld, terwijl een fysieke polygonverschuiving de live voertuigpose niet opnieuw mag verschuiven. Het document noemt de oude beeldcorrectie en fysieke polygonverschuiving afzonderlijk, maar `applyShift` bewaart beide samen ([MowerMap.tsx:3710](../../dashboard/src/components/map/MowerMap.tsx#L3710)). Nodig: expliciet onderscheid en één heen/terugconversie voor alle kaartacties.

### 10. P1 - Meetknop dwingt de beloofde meetkwaliteit niet af

[MowerMap.tsx:2106](../../dashboard/src/components/map/MowerMap.tsx#L2106) controleert alleen of `mapX/mapY` eindig zijn. Online, verse pose, RTK Fixed, stabiele stilstand en een gevalideerd kaartframe ontbreken als voorwaarden. De server ontvangt alleen x/y en kent de kwaliteit van deze referentiemeting niet.

Nodig: verse metingen met kwaliteitsstatus opslaan en slechte metingen weigeren. B moet bovendien met hetzelfde fysieke voertuigreferentiepunt op de plaats staan waar A’s dockanker is opgenomen; “de maaier staat bij het dock” is geen centimetermeting.

### 11. P2 - Automatisch voorgestelde verbindingen zijn niet bewezen berijdbaar

[zoneCopy.ts:190](../../server/src/services/zoneCopy.ts#L190) controleert bij het dockkanaal alleen gekopieerde obstakels, niet bestaande obstakels van B. Een geïsoleerd voorbeeld met een bekend B-obstakel dwars over de lijn geeft toch `ok:true, needsChannel:false`. De firmware kan dat obstakel vervolgens wel blokkeren; het resultaat is een onbruikbare verbinding, geen bewezen rit door het obstakel.

[zoneCopy.ts:165](../../server/src/services/zoneCopy.ts#L165) noemt elke overlap met een bestaande zone verbonden, zonder na te gaan of die zone vanaf het dock bereikbaar is. Een kopie naast een geïsoleerde zone op 94 m van het dock werd zonder kanaalwaarschuwing geaccepteerd. Ook puntcontact is geen passage met voldoende breedte.

Nodig: alle betrokken obstakels, corridorbreedte en de vanaf het dock bereikbare zones controleren. Een korte rechte lijn garandeert evenmin dat onbekende fysieke barrières ontbreken.

### 12. P2 - Een backup kan tegelijk twee verschillende kaarttoestanden bevatten

[portableBackup.ts:346](../../server/src/services/portableBackup.ts#L346) haalt geometrie uit de DB en neemt daarnaast onafhankelijk live maaierbestanden op. Bij herstel gaan de CSV’s naar de maaier; de JSON-geometrie vult de DB. Er is geen vergelijking die bewijst dat beide dezelfde kaart voorstellen. Dit kan ook ontstaan wanneer de server al is gewijzigd maar de maaier de wijziging nog niet heeft ontvangen.

Nodig: één consistente snapshot van maaierbestanden als basis, daaruit de servergeometrie afleiden en labels apart bewaren. Bij een backup zonder complete live bestanden moet de beperking herkenbaar zijn. Een volledige bestandsmanifestatie met hashes helpt aantonen welke set daadwerkelijk is teruggezet.

### 13. P2 - Niet alle GPS-conversies gebruiken de nieuwe UTM-projectie

Het dashboard en `gridLocalToGps/gridGpsToLocal` zijn gelijk en de referentiechecks slagen. Maar [portableMap.ts:98](../../server/src/services/portableMap.ts#L98) maakt GeoJSON nog met de oude vlakke `111320`-formule, zonder aftrek van `chargingPose`. De metadata noemt de punten charger-relatief met anker nul, terwijl de meegegeven punten kaartframecoördinaten kunnen zijn.

Ook de GPS-input van [dashboard.ts:1826](../../server/src/routes/dashboard.ts#L1826) en 2018 gebruikt de oude `gpsToLocal`, zonder UTM-convergentie en dockpose. Het moderne dashboard stuurt lokale punten en omzeilt dat specifieke API-pad; andere GPS-aanroepers niet.

Nodig: alle export/import/API-conversies aan hetzelfde expliciete framecontract laten voldoen. De circa 0.95 m fout op 25 m afstand is alleen in de bijgewerkte paden opgelost.

## Andere uitvoeringsrisico’s

De gedeelde automatische push start per aanvraag onafhankelijk. [dashboard.ts:2712](../../server/src/routes/dashboard.ts#L2712) herkent antwoorden alleen op commandonaam; twee gelijktijdige pushes kunnen hetzelfde antwoord accepteren. De Python-sync gebruikt gedeelde tijdelijke paden en schrijft dezelfde directories. Dit is een uit de code afgeleid risico, niet live uitgelokt. Serialiseer toepassen per maaier en koppel antwoord aan operatie.

Na een planner-timeout meldt [dashboard.ts:2696](../../server/src/routes/dashboard.ts#L2696) toch `apply.done()`. Dat moet onvoltooid/mislukt blijven zolang de planner niet klaar is.

## Beoordeling van de documentbeweringen

| Bewering | Beoordeling |
|---|---|
| GPS wordt via UTM minus oorsprong naar kaartmeters gebracht | Bevestigd voor het GNSS-meetpunt in lokaal firmwarebinary v6.0.2; `updateFromGps` trekt de opgeslagen oorsprong af. Gepubliceerde voertuigpose is daarnaast onderdeel van de lokalisatieketen. |
| Correctie voor meridiaanconvergentie is hier nodig | Juist; circa 2.2° en circa 0.95 m dwarsafwijking op 25 m. De huidige dashboardcheck tegen PROJ-referentiewaarden slaagt. |
| Het frame heet ENU | Technisch onnauwkeurig: lokaal UTM-grid, niet waar oost/noord. Juist het verschil verklaart de convergentiecorrectie. |
| Charger gebruikt altijd autonome zelf-inmeting | Te stellig in de samenvatting. AUTO, MOVING en FIXED komen in firmware voor; de actuele modus is niet vastgesteld. |
| 24 m en 1.9 m afwijking bewijzen uitsluitend basisfout | Plausibele verklaring, geen sluitend bewijs: pins en foto zijn niet onafhankelijk landmeetkundig gecontroleerd. Ankerfouten, beeldplaatsing en voertuigreferentie zijn alternatieve bijdragen. |
| Basisfout is alleen translatie | Bruikbare lokale benadering voor dezelfde tuin/UTM-zone, geen universele exacte garantie. De rotatie/schaalaanname moet bij overdracht met extra controlepunten worden getoetst. |
| Alle posities zijn centimeter-consistent zodra RTK Fixed | Te absoluut. Ontvangst, multipath, lokalisatie, referentiepunt en mechanische herhaalbaarheid blijven bijdragen. Het document noemt zelf 10–20 cm interne afwijking. |
| Herankeren na basisdrift en na fysiek dockverplaatsen is hetzelfde | Onjuist als de zones op dezelfde grond moeten blijven. `origin = UTM(nieuwDock) − oudAnker` laat de oude zones meeverhuizen met het dock. Een gemeten fysieke koppeling/nieuwe dockpose is dan nodig. |
| Na `reanchor_pos` is er geen oorsprong tot de eerste fix | Onjuist geformuleerd: deze handler schrijft juist een berekende oorsprong en laadt die live. |
| Alle dockankers bevatten hetzelfde getal | Op .100 praktisch waar; op .244 nu aantoonbaar onwaar. |
| De beeldpin verandert de navigatie-oorsprong niet bij gewone sync | Dit is de huidige bedoelde gate; de oude restore-and-realign is een uitzondering met gebrekkige voorwaarden. |
| Alle kaartacties gebruiken exact dezelfde inverse | Onwaar bij offsets en de oude GPS-API/exportpaden. |
| Droneplaatsing kan alleen worden gedeeld als beide basisfouten gelijk zijn | Niet algemeen juist. De opgeslagen hoeken zijn lat/lng. Een correct geografisch geplaatste foto kan worden gedeeld ongeacht RTK-bias als beide lokale frames correct naar datzelfde beeldreferentiestelsel worden gekoppeld. Een foto die is passend gemaakt op een foutief maaierframe neemt die fout wel mee. |
| Eén correspondentie is de enige geldige koppeling | Eén punt volstaat bij vooraf bekende gelijke assen/schaal. Meerdere punten of gezamenlijk ingemeten absolute referenties zijn ook geldig en maken controle mogelijk. |
| Na restore alleen vrijgeven bij gecontroleerd docken binnen 0.4 m | Onwaar voor de achtergebleven oudere codepaden; bovendien is 40 cm geen bewijs van enkele centimeters. |

Firmwarebewijs: `research/firmware/mower_firmware_v6.0.2/install/robot_combination_localization/lib/robot_combination_localization/robot_combination_localization` (lokaal firmwarebinary, niet in Git opgenomen), `latlonToUtmXY`/`proj_trans` bij 0x83600/0x83674, aanroep bij 0x87a08 en oorsprongaftrek bij 0x87a4c–0x87a58. Geen nieuwe volledige analyse van alle abonnementen/firmwareversies uitgevoerd. De stelling over het ontbreken van ArUco in lokalisatie wordt ondersteund door het onderzochte binary, maar is hier niet opnieuw voor iedere versie bewezen.

## Wat nodig is voor enkele centimeters op de grond

WGS84 zegt welke coördinaten worden gebruikt, niet hoe nauwkeurig het beeld of de maaier is. Leaflet krijgt lat/lng; de gebruikte achtergrondtiles worden onder meer in Web Mercator/EPSG:3857 geleverd. Dat is een normale weergaveketen, geen centimetergarantie.

PDOK beschrijft voor winterbeelden 8 cm en deels 5 cm pixels. Pixelgrootte is geen garantie van absolute positienauwkeurigheid; verder inzoomen voegt geen detail toe. De huidige kaartlaag is daarom een nuttige achtergrond, maar onvoldoende bewijs voor een grens op 2–3 cm. [PDOK datasetinformatie](https://www.pdok.nl/introductie/-/article/pdok-luchtfoto-rgb-open-).

Een gewone dronefoto met GPS/hoogte/heading is evenmin voldoende. De bestaande homografie is bruikbaar voor een ongeveer vlakke ondergrond, met goede grondpunten en gecorrigeerde lensvervorming. Hoogteverschillen, daken, bomen en lensvervorming worden niet door vier hoekpunten opgelost. Vier perfect passende punten kunnen nul restfout geven zonder de nauwkeurigheid elders te bewijzen. [OpenCV homografie](https://docs.opencv.org/4.5.1/d9/dab/tutorial_homography.html).

Een praktische route voor deze tuin:

1. **Eerst consistente frames.** Los de .244-ankerstrijd op via een gecontroleerde meting. Behoud onderscheid tussen oorspronkelijke navigatie-oorsprong, dockpose, fysieke zoneoffset en beeldplaatsing.
2. **Meet meerdere herkenbare grondpunten verspreid over de tuin.** Gebruik verse stabiele Fixed-metingen met hetzelfde fysieke voertuigpunt, of onafhankelijke landmeetkundige RTK. Gebruik extra punten om de translatie/rotatieaanname te toetsen, niet alleen het dock.
3. **Gebruik voldoende nauwkeurig beeld.** Voor een vlakke tuin kan een gecontroleerde, scherpe droneopname met goede grondreferenties volstaan. Bij reliëf is een orthomosaïek met hoogtecorrectie nodig. RTK/PPK of ingemeten grondpunten bepaalt de absolute koppeling; gewone drone-GPS kan meters fout zijn. [Pix4D nauwkeurigheid](https://support.pix4d.com/hc/en-us/articles/202558889).
4. **Houd onafhankelijke controlepunten over.** Punten die niet in de passing zijn gebruikt moeten verspreid over het terrein binnen de gekozen tolerantie vallen. Rapporteer maximale fout en spreiding, niet alleen gemiddelde pasfout.
5. **Definieer welk punt moet kloppen.** GNSS-antenne, voertuigreferentie en maairand zijn verschillende plaatsen. De onderzochte firmwarebeschrijvingen bevatten antenne-offsets van 0.325 m en in een variant 0.186 m; welke live geldt is niet vastgesteld. [extended_commands.py:4538](../../research/extended_commands.py#L4538) erkent zelf circa 10 cm restfout. Deze geometrie moet expliciet in de meting en acceptatie zitten.
6. **Verifieer de hele uitvoering.** Na herstel/kopie bestanden en ankers vergelijken, relokalisatie controleren en de getekende grens op onafhankelijke grondpunten toetsen. Herhaal na reboot/basisherstart. Een goede projectie bewijst nog geen overeenkomst van maaimes of gereden grens met de tekening.

Voor uitsluitend dezelfde tuin is een nauwkeurige lokale beeld↔maaierkoppeling mogelijk zonder eerst de absolute RTK-bias weg te werken. Voor uitwisseling met externe landmeetkundige WGS84/ETRS89-data moeten ook datum, realisatie en epoch bekend zijn; alleen het label EPSG:4326 is voor centimeters onvoldoende. [NSGI coördinatenstelsels](https://www.nsgi.nl/faq). De scheiding tussen relatieve RTK-precisie en absolute basisnauwkeurigheid wordt ook beschreven door [Emlid](https://docs.emlid.com/reachrs/rtk-quickstart/placing-the-base/).

## Verificatie en grenzen van deze audit

- Zonecopy service/routes: 49 tests geslaagd.
- Restore/reanchor/portable-map: 51 geslaagd, 12 overgeslagen.
- MapConverter, dronewiskunde/-routes en gardenRender: 58 geslaagd.
- Dashboard PROJ-referentiecheck: 2 geslaagd.
- Aanvullend geïsoleerd gereproduceerd: globale import-ID-botsing, voortijdige framevrijgave, achtmaal hetzelfde GPS-cachebericht, fout bij tekenen met +1 m offset, genegeerd B-obstakel en verbinding met een geïsoleerde zone.
- Live alleen-lezen gecontroleerd: `pos.json`, dock-CSV, dock-YAML en server-calibratie/maps/dock-drift voor beide maaiers.

Totaal **160 bestaande checks geslaagd, 12 overgeslagen**. Die groene checks dekken de aangetoonde fouten dus niet volledig af. Er is geen fysieke herstel- of maaitest uitgevoerd en geen functionele broncode gewijzigd.

Op verzoek is dit rapport opgeslagen in de Novabot-repository en is Beads 1.3.0 geïnstalleerd. De bevindingen staan onder epic `Novabot-55f`: `.1` tot en met `.13` volgen de genummerde bevindingen hierboven; `.14` en `.15` behandelen gelijktijdige pushes en de planner-timeout; `.16` betreft documentcorrecties en `.17` onafhankelijke grondpuntvalidatie. Bestaand herstelwerk is via Beads-relaties gekoppeld. Deze issues staan open; de beschreven fouten zijn in deze sessie niet gerepareerd.
