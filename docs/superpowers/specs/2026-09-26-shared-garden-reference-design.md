# Gedeelde tuinreferentie voor kopiëren en nauwkeurig tekenen

Status: voorstel op verzoek van Ramon. Nog niet geïmplementeerd of fysiek gevalideerd. Er worden voor dit ontwerp geen apparaten, kaarten, radiokoppelingen of firmware gewijzigd. Uitvoering wordt gevolgd in Beads onder `Novabot-55f`; beeldvalidatie blijft onderdeel van `.17`.

## Besluit

Gebruik vaste fysieke grondpunten als referentie voor de tuin. Meet de koppeling van iedere maaier naar die punten en bewaar haar. Kopiëren gebruikt deze gemeten koppeling, niet een aangewezen dock op een foto. Kalibreer het beeld afzonderlijk op dezelfde grondpunten.

De bestaande, in de praktijk gebruikte .100-kaart kan aanvankelijk het numerieke tuinframe leveren. Haar native bestanden hoeven daarvoor niet te veranderen. De bijbehorende grondpunten worden vervolgens de blijvende fysieke referentie: een latere afwijking van .100 mag de tuinreferentie niet automatisch mee verschuiven. Een gemeenschappelijke lokale referentie vereist geen nauwkeurige absolute WGS84-positie. Die absolute koppeling is een afzonderlijke meting als uitwisseling met geografische brondata nodig is.

## Eenmalige meetprocedure

Kies vijf vaste, goed bereikbare punten op stabiele ondergrond, verspreid over het relevante maaigebied. Drie dienen voor de berekening; twee blijven buiten die berekening voor controle. Dit aantal is een praktische ontwerpkeuze, geen wiskundig minimum en geen universeel voorschrift voor een droneproject. Vermijd een groep dicht bij één dock: een kleine hoekfout wordt pas op afstand zichtbaar.

Plaats beide maaiers na elkaar reproduceerbaar bij dezelfde punten met een positioneermal met aanslagen. De mal legt één gedefinieerd chassisreferentiepunt en de richting vast. Alleen op het oog boven een stip parkeren voldoet niet. Controleer dat de mal voor beide chassis hetzelfde fysieke referentiepunt oplevert. Verplaats geen dock voor deze procedure.

De wizard verzamelt per plaatsing verse, tijdgestempelde lokale navigatieposes en de bijbehorende kwaliteitsgegevens. Meerdere pakketten met dezelfde sensorwaarde en oude ontvangerstempel tellen niet als onafhankelijke metingen. Een meetvenster geeft spreiding, niet automatisch een bewijs van juistheid. Herhaal de plaatsing, meet opnieuw op een ander moment en keer aan het eind terug naar het beginpunt om tijdsafhankelijke afwijkingen zichtbaar te maken.

Gebruik de effectieve lokale navigatiepose die ook voor de kaart wordt gebruikt. Zo wordt eventuele interne lokalisatiecompensatie niet ten onrechte genegeerd. Ligt het malreferentiepunt buiten het gerapporteerde voertuigpunt, reken dan de bekende offset om met de volledige oriëntatie. Raw GNSS vraagt daarnaast de geverifieerde antenne-offset; een antennepositie is niet hetzelfde als een chassis- of maaimespositie.

Leg tegelijk vast dat het referentieframe van .100 nog overeenkomt met zijn bestaande fysieke grens. Succesvol maaien is relevant praktijkbewijs; nieuwe controlepunten alleen reconstrueren niet automatisch de historische juistheid van iedere ingelopen grens.

## Omrekening en acceptatie

Begin met het bestaande model: beide maaierframes hebben dezelfde UTM-gridassen en schaal. Voor ieder puntpaar is de kandidaatverschuiving:

```text
t_i = gemeten_punt_244_i - gemeten_punt_100_i
punt_244 = punt_100 + t
```

Bereken één verschuiving uit de drie meetpunten. De spreiding tussen de afzonderlijke verschuivingen en de fouten op de twee ongebruikte controlepunten toetsen of dit model klopt. Een verkeerde meting wordt niet stilzwijgend passend gemaakt: toon afwijking, verwerp een ongeldige reeks en hermeet.

Als meerdere meetrondes een echte constante hoekafwijking aantonen, kan een starre omzetting `R * punt + t` worden onderzocht. Gebruik geen schaalverandering, rek of homografie om navigatiepolygonen op slechte metingen te laten passen. Een onverwachte hoekfout is eerst reden om meetpunt, lokalisatie en assen te controleren.

Rapporteer maximale controlefout, gemiddelde fout, herhaalbaarheid en het gebied waarbinnen gecontroleerd is. Een doel zoals maximaal 3 cm op de gemeten controlepunten is een acceptatie-eis die nog bewezen moet worden. Het is geen gegarandeerde maainauwkeurigheid overal en altijd. De uiteindelijke fout bevat ook de oorspronkelijke grensmeting, lokalisatie tijdens rijden, stuurgedrag en de afstand van voertuigreferentie tot maaimes. Als de hardware een gewenste grens niet haalt, moet dat zichtbaar blijven; software kan geen nauwkeurigheid bijmaken.

## Hergebruik en veranderingen

Bewaar de goedgekeurde transformatie met ruwe meetreeksen, fysieke puntidentiteiten, meetpuntgeometrie, kwaliteitsresultaten en duurzame bron-/doelframe-identiteiten. Een serverherstart en het toevoegen van een zone mogen de koppeling niet wissen. Het huidige vluchtige meet-ID van vijf minuten en de in-memory frame-revisie zijn hiervoor onvoldoende.

Een gewijzigde navigatie-oorsprong, restore naar een ander frame, basisreferentie of relevante herlokalisatie vraagt nieuwe verificatie. Alleen een hash van `pos.json` is onvoldoende: de gemeten jump-compensatie kan veranderen zonder bestandswijziging. Bewaar fysieke controlepunten en gebruik runtime-diagnostiek om twijfel zichtbaar te maken; verschuif nooit automatisch de hele tuin op basis van één nieuwe dockpose. Een herstart is geen bewijs van een fout, maar mag ook geen ongecontroleerde nieuwe koppeling opleveren.

Bij kopiëren krijgen werkgebied en obstakels exact dezelfde omzetting. Het doeldock blijft een apart object in het doelmaaierframe. Genereer de dockverbinding met de bestaande geometrie- en obstakelcontroles en pas toe via de bevestigde bestandsoverdracht. Het verplaatsen van een echt dock wijzigt zijn pose en verbinding, niet de fysieke tuin. De huidige 5cm-gate bij het dock blijft bestaande code; dit ontwerp verandert die grens niet en gebruikt haar niet als enige bewijs voor de koppeling.

De eerste implementatie kan één bewaarde registratie .100 naar .244 gebruiken. Een migratie van alle kaarten naar een nieuwe databasevorm is niet nodig om deze foutbron weg te nemen. De blijvende tuinreferentie en aparte beeldkalibratie bepalen wel de verdere richting.

## Nauwkeurig tekenen op beeld

Voor de gewenste ervaring wordt een drone-orthofoto aan ingemeten grondpunten gekoppeld. Gebruik voldoende scherpe beelden, grondresolutie en spreiding van referentiepunten, passend bij terrein en gewenste tolerantie. Reserveer extra onafhankelijke controlepunten; punten waarop het beeld is passend gemaakt leveren op zichzelf geen onafhankelijke nauwkeurigheidscontrole. Het aantal beeldreferenties wordt voor de opname bepaald, niet automatisch gelijkgesteld aan de drie maaier-fitpunten.

De keten wordt:

```text
dronebeeld -> vaste tuincoördinaten -> gecontroleerd maaierframe
```

Een nieuwe foto of verplaatste weergavepin verandert bestaande grondzones niet. Nieuw tekenen gebruikt uitsluitend een goedgekeurde beeldkoppeling als centimeternauwkeurigheid wordt verlangd. Een gewone satellietlaag blijft bruikbaar als achtergrond, maar scherp inzoomen of één passend dock maakt haar niet aantoonbaar centimeters nauwkeurig. Controleer ook plekken met reliëf, begroeiing en slecht zichtbare grenzen.

## Bestaande hardware: wat wel en niet nodig is

Eén gedeelde RTK-basis is niet vereist voor de gemeten lokale koppeling. Ook meerdere vaste bases kunnen in één gecontroleerde referentie werken. Een gezamenlijke vaste en ingemeten correctiereferentie kan later de onderhoudslast verminderen, maar neemt ontvangst-, multipath- of stuurfouten niet weg.

Beide Novabots eenvoudig hetzelfde LoRa-paar geven is geen verantwoorde implementatie: die verbinding draagt behalve RTK ook dockhandshake, status en besturingscommando's. De huidige gescheiden koppelingen blijven behouden. Het scheiden van correctiedata en besturing zou een aparte, op hardware te bewijzen wijziging zijn.

De bestaande RTK-walker is bruikbaar als verdere meetvoorziening. Hij kan passief van chargerbron wisselen. Op exact dezelfde onbeweeglijke antennepositie achtereenvolgens A, B en opnieuw A meten kan het verschil tussen de GNSS-referenties onderzoeken. De huidige bronwissel maakt een oude fix echter niet aantoonbaar ongeldig en de parser legt geen volledige RTCM1005/1006-basisreferentie vast. Bovendien kan de maaier zelf GNSS-sprongen compenseren. De walker is daarom nog geen bewezen vervanger van lokale controlepunten. NTRIP-metingen vereisen eveneens een expliciete koppeling naar het tuinframe en een bekende datum/epoch als absolute centimeters worden verlangd.

## Bestaande code om te hergebruiken

- `dashboard/src/components/map/MowerMap.tsx`: `copyMarkerFromMower` biedt al een fysieke meetknop; uitbreiden naar een begeleide, blijvend bewaarde registratie.
- `server/src/routes/dashboard.ts`: bestaande measurement- en copyroutes; tijdelijke meet-ID's niet als permanente kalibratie opslaan.
- `server/src/services/positionTelemetry.ts`: verse kwaliteitsvensters; sensoridentiteit en herhaalde fysieke plaatsingen blijven aanvullende eisen.
- `server/src/services/zoneCopy.ts`: `transformPoints`, `planZoneCopy` en kanaalcontrole hergebruiken.
- `server/src/services/dockChannelRepair.ts`: onafhankelijke native docks en kaartvergelijking behouden.
- `server/src/services/frameValidation.ts`: duurzame frame-identiteit en fysieke verificatie onderscheiden van vluchtige processtatus.
- `server/src/services/dockPhotoReference.ts`: weergavekalibratie afzonderlijk houden van fysieke navigatie.

## Onderbouwing

- [Trimble: basiscoördinaten en samenhang tussen meerdere bases](https://help.fieldsystems.trimble.com/trimble-access/2021.10/en/GNSS-base-coordinates.htm). Ongekoppelde basisreferenties vereisen afzonderlijke kalibratie; één gezamenlijke referentie moet worden gemeten.
- [Trimble: factoren die RTK-nauwkeurigheid beperken](https://receiverhelp.trimble.com/oem-gnss/position-modes-critical-factors-rtk.html). Basispositie, ontvangst en multipath blijven foutbronnen. De genoemde productspecificaties zijn geen specificaties van Novabot.
- [Pix4D: relatieve en absolute beeldnauwkeurigheid](https://support.pix4d.com/hc/en-us/articles/202558889). Grondresolutie, beeldkwaliteit en referentiepunten begrenzen het resultaat.
- [Pix4D: grondreferenties en onafhankelijke controlepunten](https://support.pix4d.com/hc/en-us/articles/115000140963). Fit en onafhankelijke toetsing hebben verschillende functies.

De meetopzet en softwarekeuzes hierboven zijn een voorstel voor Novabot op basis van deze principes en de onderzochte lokale code, geen reeds aangetoonde nauwkeurigheidsclaim.
