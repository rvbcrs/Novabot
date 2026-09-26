# Kaart- en frameherstel: softwarecontrole en fysieke acceptatie

Deze wijziging voert het [herstelplan](../superpowers/plans/2026-09-25-frames-gps-utm-fixes.md) uit. De software is lokaal gecontroleerd. Dockmetingen zijn inmiddels op het fysieke apparaat gecontroleerd; volledige acceptatie van restore, kopie en herankering is nog niet afgerond. Uitrolstatus en resterend werk staan in Beads onder `Novabot-55f`.

## Herstellen en kaarttoepassing

Een volledige restore bewaart de aangeleverde maaierbestanden, inclusief aparte CSV- en x3-CSV-versies. Voor schrijven worden rasterreferenties, volledigheid en overeenstemming van dockkanaal, `map_info.json` en dock-YAML gecontroleerd. Er moet een verse dockmelding zijn. Een gecorreleerde snapshot bewijst protocolondersteuning voordat de write begint.

De server meldt toepassing pas na een positief antwoord, exact teruglezen van de bestanden en een transactionele DB-vervanging met wereldwijd unieke kaart-ID's. `pos.json` blijft bij restore ongewijzigd. Een onzekere uitkomst blijft `RECONCILE_REQUIRED`: een volgende poging leest terug in plaats van opnieuw te schrijven. De frameblokkade overleeft een serverherstart.

Gewone kaartpush en fysieke polygonverschuiving gebruiken dezelfde exclusieve procedure per maaier: vaste ZIP met hash, bevestigd schrijven, grids hergenereren, een verse plannerstatus en teruglezen. Een timeout is geen succes. Ruwe herstelcommando's buiten deze procedure worden bij de gedeelde MQTT-grens geweigerd. De oude refresh-dock-anchor en Restore + Realign-routes zijn uitgezet.

## Herankeren

Deze procedure geldt voor een onverplaatst dock en bestaande zones die fysiek op dezelfde grond moeten blijven. Een fysiek verplaatst dock vereist een nieuwe, onafhankelijk vastgestelde referentie; dezelfde oorsprongformule zou de zones anders laten meeverhuizen.

1. De maaier staat op het dock. Serveranker, dockkanalen, `map_info.json` en dock-YAML moeten overeenkomen. Bij tegenspraak wordt niets geschreven.
2. Verzamel acht nieuwe RTK Fixed-GPS-metingen met unieke ontvangerstempels en een spreiding van maximaal 10 cm. Gewone GPS-cacheberichten tellen niet mee.
3. Stuur het expliciete lokale dockanker mee en schrijf `UTM-oorsprong = UTM(gemeten dock) − lokaal dockanker`. Controleer het antwoord en de berekende oorsprong.
4. De aanwezige operator rijdt met de joystick uit. Alleen een verse RUNNING + Fixed-positie buiten het dock en op minstens 0,4 m van het anker bevestigt herlokalisatie binnen deze cyclus.
5. De operator rijdt terug op het dock en drukt Verifieer. Acht nieuwe stabiele dockposes, de ongewijzigde oorsprong en overeenkomende bestandsankers zijn vereist. De afstand tot het dockanker moet maximaal 0,4 m zijn.

Er is geen automatische rij- of dockopdracht in deze herstelcyclus. Een herstart, storing of verlopen cyclus geeft het frame niet vrij. De grens van 0,4 m is een herstelcontrole en bewijst geen centimeternauwkeurigheid.

De live controle heeft een aanvullende beperking aangetoond: raw GNSS meet de antenne, terwijl de lokale voertuigpose een ander referentiepunt gebruikt. De volledige TF-transformatie en de overeenstemming tussen raw GNSS en gefuseerde lokalisatie moeten nog in de herankerprocedure worden opgenomen (`Novabot-55f.19`). Bovenstaande procedure is daarom nog geen fysiek goedgekeurd herstelpad.

## Kopiëren, tekenen en beeldplaatsing

Kopiëren vereist een verse stabiele Fixed + RUNNING-meting, een gevalideerd frame en een servergebonden meet-ID. Niet-nul fysieke polygonoffsets worden voorlopig geweigerd. Het doeldock blijft behouden. Nieuwe dockverbindingen worden tegen bestaande en gekopieerde obstakels gecontroleerd; overlap met een andere zone levert geen automatische verbinding op.

De normale kopieerroute leest nu beide opgeslagen docks rechtstreeks van de online maaiers. Dock-YAML, kaartmetadata en bestaande kanalen moeten overeenkomen; de serverpolygonen worden met de native CSV's vergeleken. Bij toepassen staat de doelmaaier op zijn eigen dock met een stabiele pose binnen 5 cm van het opgeslagen dock. Een preview blijft buiten het dock mogelijk. Na verwijderen van de oude zone kan de onafhankelijke dockpose nog steeds worden gebruikt: meten en de eerste kopie toepassen vereisen geen achtergebleven kanaal.

Als het dock binnen de gekopieerde zone ligt, genereert de kopieerfunctie een aanloop van 1,2 m tegen de opgeslagen dockheading in. Dit voorkomt een kort kanaal naar de dichtstbijzijnde grasrand, de verkeerde kant op. De aanloop moet binnen de zone blijven en de volledige corridor moet obstakelvrij zijn. Een geblokkeerde aanloop levert een weigering of een expliciet ontbrekend kanaal op. Buiten de zone blijft de bestaande verbinding naar de dichtstbijzijnde grens gelden.

De reeds verkeerd opgeslagen .244-kaart kan eenmalig worden gecorrigeerd via `GET /api/dashboard/maps/:sn/repair-dock-channel` en vervolgens `POST` met de teruggegeven `planHash`. De procedure maakt eerst een backup onder `storage/dock-channel-repair/<operation-id>/`, bewaart werkgebieden en obstakels byte voor byte, corrigeert kanaal en secundaire dockmetadata, en gebruikt de bestaande bevestigde sync plus rastergeneratie. Mapping, coverage planner en auto-recharge worden daarbij herladen. Oorsprong, dock-YAML en fotokalibratie blijven behouden; de server commit pas na succesvolle teruglezing. Dit is geen vereiste voor volgende normale kopieën. De geïnstalleerde firmware op .244 ondersteunt deze procedure al; hiervoor is geen firmwareflash nodig.

Tekenen, penseel en plakken gebruiken de inverse van de weergavetransformatie, inclusief rotatie, schaal en offsets. App en dashboard gebruiken gridconvergentie en het lokale dockanker. PROJ-referentietests controleren de wiskundige conversie binnen 1 cm; dit zegt niets over de nauwkeurigheid van het bronbeeld of het fysieke voertuigmeetpunt.

De dockpin is beeldkalibratie. Alleen de pin verplaatsen wijzigt bestaande maaierbestanden niet. Nieuwe tekeningen en navigatieklikken worden wel door die gewijzigde kalibratie omgerekend en kunnen daardoor op een andere fysieke plek uitkomen. Geografisch geplaatste dronehoeken zijn deelbaar; elke maaier heeft daarnaast zijn eigen koppeling van lokale meters naar het beeld.

De desktopactie "Gedockte maaier koppelen aan foto" koppelt een aangewezen beeldpunt aan het onafhankelijk opgeslagen dock in de maaier. Ze vereist een consistente gecorreleerde snapshot, overeenstemming tussen dock-YAML en `map_info.json`, acht verse stabiele Fixed + RUNNING-dockposes en maximaal 5 cm verschil met het opgeslagen dock. Een bestaande rotatie, schaalcorrectie of offset wordt geweigerd. De vorige referentie wordt eerst geback-upt. De actie schrijft uitsluitend de beeldreferentie op de server, zonder navigatieanker, kanalen, zones of `pos.json` op de maaier te wijzigen. Frame-invalidatie verwijdert deze referentie.

De desktop haalt kaarten, kalibratie en dockpose samen op en vernieuwt deze bij `maps:changed` en opnieuw verbinden. Zo kan een oude dockpose niet blijven staan naast nieuw opgehaalde kalibratie. Dit repareert geen fout dockkanaal: dat blijft op zijn werkelijk opgeslagen lokale positie zichtbaar. De afzonderlijke mobiele `MiniMap` gebruikt nog verschillende positiebronnen en valt onder `Novabot-55f.21`.

## Uitrol en bewijsgrenzen

De server en de aangepaste `extended_commands.py` horen samen: commandocorrelatie, consistente snapshots en gestempelde RTK-metingen zijn vereist. Oudere firmware wordt veilig geweigerd of loopt op een meettimeout; de exacte runtimecadans en ROS-ontvangerstempels moeten bij de fysieke proef worden bevestigd. De interne referentiedocumenten `docs/reference/FRAMES-GPS-UTM.md` en `REANCHOR.md` zijn lokaal bijgewerkt; die map is bewust uitgesloten van Git.

Voor maaier .244 bevestigde een verse meting na handmatig rijden en docken het opgeslagen maaierdock binnen circa 1 cm, terwijl het serverdockkanaal circa 1,21 m afweek. Een latere meting liet opnieuw circa 10 cm verschil tussen actuele pose en opgeslagen dock zien. Een eenmalig goede meting is dus geen blijvende validatie. Het kanaalconflict blijft open. Fysieke acceptatie omvat snapshot vóór/na, restore, herankeren, herstart, kopie met doeldock en doorgang, en pas daarna begeleid rijden. Enkele centimeters tekenen vereist daarnaast meerdere ingemeten grondpunten en onafhankelijke controlepunten verspreid over het hele gebied. Een satellietfoto en één passend dockpunt zijn daarvoor onvoldoende bewijs.

## Lokale verificatie

Server na de dockkanaal- en kopieerfix: 1.490 tests geslaagd, 39 bestaande tests overgeslagen. De gerichte controle op de opgeslagen .244-snapshot slaagt ook, zonder apparaatcontact. App: eerder 190 tests geslaagd. Dashboardprojectie: eerder 4 checks geslaagd. Firmwarehelpers: eerder 6 Python-tests geslaagd. Server-TypeScript, lint van de gewijzigde services en de dashboardproductiebuild slagen. De dashboardbuild meldt de bestaande waarschuwing over grote bundels. Volledige lintcontrole van `MowerMap.tsx` meldt nog bestaande fouten; die controle is niet groen. Deze controles vervangen geen runtime- of fysieke acceptatie. De gebruiker doet de nieuwe beta en NAS-update zelf; de kanaalcorrectie is nog niet live uitgevoerd.
