# Kaart- en frameherstel: softwarecontrole en fysieke acceptatie

Deze wijziging voert het [herstelplan](../superpowers/plans/2026-09-25-frames-gps-utm-fixes.md) uit. De software is lokaal gecontroleerd; er is niets naar server of maaiers uitgerold en er is geen fysieke proef uitgevoerd. Voortgang en resterend werk staan in Beads onder `Novabot-55f`.

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

## Kopiëren, tekenen en beeldplaatsing

Kopiëren vereist een verse stabiele Fixed + RUNNING-meting, een gevalideerd frame en een servergebonden meet-ID. Niet-nul fysieke polygonoffsets worden voorlopig geweigerd. Het doeldock blijft behouden. Nieuwe dockverbindingen worden tegen bestaande en gekopieerde obstakels gecontroleerd; overlap met een andere zone levert geen automatische verbinding op.

Tekenen, penseel en plakken gebruiken de inverse van de weergavetransformatie, inclusief rotatie, schaal en offsets. App en dashboard gebruiken gridconvergentie en het lokale dockanker. PROJ-referentietests controleren de wiskundige conversie binnen 1 cm; dit zegt niets over de nauwkeurigheid van het bronbeeld of het fysieke voertuigmeetpunt.

De dockpin is beeldkalibratie. Alleen de pin verplaatsen wijzigt bestaande maaierbestanden niet. Nieuwe tekeningen en navigatieklikken worden wel door die gewijzigde kalibratie omgerekend en kunnen daardoor op een andere fysieke plek uitkomen. Geografisch geplaatste dronehoeken zijn deelbaar; elke maaier heeft daarnaast zijn eigen koppeling van lokale meters naar het beeld.

## Uitrol en bewijsgrenzen

De server en de aangepaste `extended_commands.py` horen samen: commandocorrelatie, consistente snapshots en gestempelde RTK-metingen zijn vereist. Oudere firmware wordt veilig geweigerd of loopt op een meettimeout; de exacte runtimecadans en ROS-ontvangerstempels moeten bij de fysieke proef worden bevestigd. De interne referentiedocumenten `docs/reference/FRAMES-GPS-UTM.md` en `REANCHOR.md` zijn lokaal bijgewerkt; die map is bewust uitgesloten van Git.

Voor maaier .244 blijft de historische ankertegenspraak onopgelost. Zonder nieuwe betrouwbare dockmeting wordt geen anker gekozen. Fysieke acceptatie omvat snapshot vóór/na, restore, herankeren, herstart, kopie met doeldock en doorgang, en pas daarna begeleid rijden. Enkele centimeters tekenen vereist daarnaast meerdere ingemeten grondpunten en onafhankelijke controlepunten verspreid over het hele gebied. Een satellietfoto en één passend dockpunt zijn daarvoor onvoldoende bewijs.

## Lokale verificatie

Server: 1.476 tests geslaagd, 39 bestaande tests overgeslagen; de laatste MQTT-guardwijziging heeft daarnaast 12 gerichte tests. App: 190 tests geslaagd. Dashboardprojectie: 4 checks geslaagd. Firmwarehelpers: 6 Python-tests geslaagd. Server- en app-TypeScript en de dashboardproductiebuild slagen. De dashboardbuild meldt de bestaande waarschuwing over grote bundels. Deze controles vervangen geen runtime- of fysieke acceptatie.
