# Verplichte dockmeting bij zonekopieën

Status: lokale testimplementatie, nog niet gedeployed. De eerste herhaalmeting op .100 voldoet niet aan de acceptatiegrenzen; kopiëren via deze methode is nog niet fysiek gevalideerd. Er is geen nauwkeurigheidsgarantie en geen vrijgave voor autonoom maaien op basis van deze proef. Uitvoering wordt gevolgd onder Beads `Novabot-55f`.

## Besluit en afbakening

Iedere nieuwe zonekopie vereist dat beide maaiers hetzelfde fysieke bronlaadstation met hun bestaande camera meten. De doelmaaier rijdt daarvoor vóór het dock van de bronmaaier, zonder te docken. Een dronefoto, satellietklik, RTK-walker of externe landmeetapparatuur is niet nodig. De gebruiker rijdt zelf; de wizard stuurt geen rijcommando's.

Dit vervangt voor de huidige implementatie het eerdere voorstel voor een eenmalige, blijvend opgeslagen registratie. De wizard gebruikt een sessie in servergeheugen met een geldigheid van **20 minuten vanaf de start**, gebonden aan bronmaaier, doelmaaier en gekozen zone. Na succesvolle opslag van de kopie wordt de sessie verbruikt. Een serverherstart, verlopen sessie of volgende kopie vraagt nieuwe metingen. Wijzigen van bron of zone wist de wizardregistratie; wijzigen van de optie voor obstakels behoudt de metingen maar vraagt een nieuwe preview.

Een satellietlaag of dronefoto blijft optionele weergave. Geen beeldlaag bepaalt de omrekening van de gekopieerde navigatiegeometrie. De eigen docks en LoRa-koppelingen blijven behouden; de meetprocedure wijzigt `pos.json` niet.

## Wizard en eerste praktijktest

1. **Bron, eerste meting:** zet .100 stil vóór zijn eigen dock, met het patroon in beeld, zonder te docken. Bevestig het fysieke bronstation en neem de meting op.
2. **Bron, herhaalmeting:** verplaats .100 ongeveer 20 cm, houd hetzelfde patroon in beeld, stop en meet opnieuw. De gemeten verplaatsing moet minstens 15 cm zijn.
3. **Doel, eerste meting:** maak ruimte met .100. Rijd .244 vóór hetzelfde dock van .100, zonder te docken. Bevestig opnieuw het fysieke bronstation, stop en meet.
4. **Doel, herhaalmeting:** verplaats .244 ongeveer 20 cm en meet hetzelfde patroon opnieuw terwijl hij stilstaat.
5. **Preview en toepassen:** zet .244 terug op zijn eigen dock met laadcontact. Controleer zone, obstakels en voorgesteld dockkanaal; pas daarna toe via de bestaande bevestigde kaartoverdracht.

Elke opname is een expliciete gebruikersactie. Het patroon identificeert het station niet uniek: daarom blijft de fysieke bronstationbevestiging bij iedere meting verplicht. Ontbrekende firmwareondersteuning, onvoldoende verse of onbetrouwbare metingen blokkeren de flow. Er is geen fotoklik, sleepbare kopieermarker of losse positiemeting als omweg. Annuleren of opnieuw beginnen blijft mogelijk; late antwoorden mogen een gesloten of gewijzigde wizard niet herstellen.

De eerste proef stopt al na stap 2 als dezelfde maaier hetzelfde stilstaande station niet voldoende reproduceerbaar meet. Pas na een geslaagde bronproef volgt de vergelijking tussen beide maaiers. Lokale tests en een succesvolle build vervangen deze apparaattest niet.

## Berekening en controles in de testcode

Gebruik de effectieve lokale navigatiepose, inclusief de interne lokalisatiecompensatie. De camera rapporteert een relatieve pose; de gecontroleerde richting van die transformatie en de volledige 3D-oriëntatie moeten behouden blijven. De lokalisatie-odometrie gebruikt het GPS-referentiepunt. Reken dit via de gemeten `base_link`–`gps_link`-transformatie naar het voertuigreferentiepunt om voordat de markerpose wordt samengesteld.

Voor beide maaiers wordt de positie van hetzelfde markerpatroon in hun eigen kaartframe bepaald. De huidige kaartframes gebruiken dezelfde UTM-gridassen en schaal. Met `marker_A` en `marker_B` als gemiddelden van de twee geaccepteerde metingen:

```text
verschuiving = marker_B - marker_A
punt_B = punt_A + verschuiving
dock_A_in_B = opgeslagen_dock_A + verschuiving
```

Het markerpatroon wordt dus niet gelijkgesteld aan het opgeslagen dockreferentiepunt. Werkgebied en obstakels krijgen dezelfde verschuiving. De opgeslagen dockpose van .244 bepaalt zijn eigen kanaalaansluiting. Het doeldock zelf wordt niet verplaatst.

De huidige controles omvatten verse RTK Fixed/lokalisatie, stabiele stilstand, tijdkoppeling tussen camera en odometrie van maximaal 0,12 seconde, passende meetvensters, en ongewijzigde brongeometrie en frame-identiteiten. De herhaalde markerposities moeten binnen **3 cm in 3D** en **1 graad yaw** overeenkomen. De headings tussen beide maaiers worden eveneens gecontroleerd. De bestaande geometrie-, obstakel-, dock- en bevestigde overdrachtscontroles blijven gelden.

**De headinggrens van 1 graad is uitsluitend een controle op grove tegenspraak.** Zij bewijst geen centimeternauwkeurigheid verderop in de tuin: 1 graad komt op 25 meter overeen met circa 44 cm dwarsafwijking. Er wordt geen hele zone gedraaid om een enkele camerarichting passend te maken. Ook twee goede metingen bij één dock bewijzen de ligging van de volledige zone nog niet.

Een `pos.json`-/dockfingerprint en serverframerevisie herkennen bestands- en bekende framewijzigingen, maar niet iedere interne lokalisatiecompensatie. Die compensatie kan tijdens rijden veranderen zonder dat een bestandshash wijzigt. De 20-minutensessie voorkomt langdurig hergebruik, maar neemt dit risico niet weg. Onafhankelijke controles van de bestaande fysieke grens, verspreid over de tuin en na rijden, blijven nodig voor globale acceptatie.

## Live bronproef op .100: afgekeurd

De ruwe opnamen en het controlescript staan lokaal in `research/captures/2026-09-26-dock-marker/` (gitignored). De bestanden `novabot-aruco-source-first.json` en `novabot-aruco-source-second.json` zijn omgerekend met `novabot-analyze-marker.py`. Dit zijn diagnostische opnamen; de nieuwe wizard/extended-command-code is daarvoor niet gedeployed.

| Gemiddelde markerpose in .100-kaartframe | Eerste stand | Tweede stand |
|---|---:|---:|
| x (m) | 0,109850 | 0,096185 |
| y (m) | −0,056264 | −0,015350 |
| z (m) | 0,041508 | 0,094297 |
| yaw | 92,1641° | 89,5622° |
| Unieke beeldtijdstempels | 60 | 60 |
| Unieke uitgegeven `/aruco/pose`-waarden | 4 | 1 |

Hetzelfde vaste patroon verschilt tussen de twee standen **4,31 cm horizontaal, 6,82 cm in 3D en 2,60 graden in yaw**. De maaierverplaatsing was circa 23,4 cm. Dit overschrijdt de herhaalgrenzen; de koppeling is hiermee **niet bruikbaar verklaard**. De grenzen worden niet verruimd om deze proef alsnog te laten slagen.

Zestig unieke beeldtijdstempels zijn hier geen bewijs van zestig onafhankelijke poses: de detector gaf in de eerste opname slechts vier verschillende poses en in de tweede één pose uit. Kleine spreiding binnen zo'n opname bewijst daarom geen evenredig kleine meetfout; kwantisatie van gedetecteerde beeldhoeken kan herhaalde poses opleveren. Een aparte, latere alleen-lezen beeldcontrole (`novabot-camera-hash-shm-100.json`) gaf 30 beelden met 30 verschillende pixelhashes in circa 8 seconden: die stream stond toen niet stil. Omdat deze controle niet gelijktijdig met de poses plaatsvond, bewijst zij niet dat de eerdere 60 poses onafhankelijk waren. De detectoruitvoer en afstandsafhankelijkheid moeten verder worden onderzocht. Een vergelijking .100–.244 en een onafhankelijke grenscontrole zijn nog niet uitgevoerd.

Een derde diagnostische opname (`novabot-aruco-source-close.json`) vanaf circa 35 cm camera-afstand gaf marker `(0,140179; -0,055441; 0,081412)` m en yaw `91,3374°`. Ten opzichte van de eerste stand is dat circa 3,03 cm XY, 5,01 cm in 3D en 0,83° yaw. Ook die vergelijking voldoet nog niet aan de positiegrens. Een tweede dichtbij-stand wordt apart gemeten. De latere opnamen melden bovendien `RobotStatus.error_status=8` (LoRa-waarschuwing), terwijl actuele BestPos Fixed en LOC_SUCCESS zijn; de nieuwe handler wijst die gezondheidstoestand momenteel af. De diagnostische opnamen mogen daarom niet als geslaagde productmeting worden gebruikt.

## Vervolgprincipes, afzonderlijk van deze wizard

Een blijvend tuinreferentiestelsel met meerdere fysieke meetpunten is een mogelijke vervolgstap, geen eigenschap van de huidige sessie. Gebruik daarvoor reproduceerbare grondpunten verspreid over het maaigebied, afzonderlijke berekenings- en controlepunten, herhaalde plaatsingen en een terugkeer naar het beginpunt. De bestaande .100-kaart kan het numerieke referentieframe leveren; fysieke controlepunten voorkomen dat een latere lokalisatieafwijking stilzwijgend de hele tuin verschuift. Een blijvende registratie vereist eigen opslag, invalidatie en onafhankelijke fysieke validatie voordat zij de verplichte bezoeken zou kunnen vervangen.

Nieuwe grenzen kunnen zonder foto met de maaier worden opgenomen. Een gewone satellietfoto is een achtergrond of benadering, geen garantie voor enkele centimeters. Een optionele drone-orthofoto mag afzonderlijk aan gecontroleerde grondpunten worden gekoppeld, met onafhankelijke beeldcontrolepunten. Verplaatsen van een weergavepin of vervangen van een foto mag bestaande navigatiepolygonen niet wijzigen. Absolute WGS84-nauwkeurigheid is een afzonderlijke kalibratievraag.

Een gedeelde RTK-basis is geen voorwaarde voor een gemeten lokale koppeling. De maaiers hetzelfde LoRa-paar geven is geen geschikte oplossing: die verbinding draagt ook dockhandshake, status en besturing. Externe meetapparatuur en wijzigingen aan die radiokoppeling vallen buiten deze flow.

## Implementatiepunten

- `dashboard/src/components/map/MowerMap.tsx`: verplichte vijfstappenwizard; `dashboard/src/api/client.ts`: alignment-, preview- en copyaanroepen.
- `server/src/services/copyAlignment.ts`: tijdelijke sessie, vier metingen, herhaalcontrole en omrekening. `server/src/routes/dashboard.ts`: preview/apply accepteren alleen een passende voltooide `alignmentId`, geen clientcoördinaat als alternatief.
- `research/extended_commands.py`: lokale meetopdracht voor de bestaande ArUco-voorziening; nog niet op de maaiers geplaatst.
- `server/src/services/zoneCopy.ts` en `dockChannelRepair.ts`: bestaande dock-, geometrie- en kanaalcontroles blijven de gedeelde basis.
- `server/src/services/frameValidation.ts` en `dockPhotoReference.ts`: navigatieframe en optionele weergavekalibratie blijven afzonderlijk.

## Achtergrond bij optionele verdere kalibratie

- [Trimble: basiscoördinaten en samenhang tussen meerdere bases](https://help.fieldsystems.trimble.com/trimble-access/2021.10/en/GNSS-base-coordinates.htm).
- [Trimble: factoren die RTK-nauwkeurigheid beperken](https://receiverhelp.trimble.com/oem-gnss/position-modes-critical-factors-rtk.html). Dit zijn geen Novabot-productspecificaties.
- [Pix4D: relatieve en absolute beeldnauwkeurigheid](https://support.pix4d.com/hc/en-us/articles/202558889).
- [Pix4D: grondreferenties en onafhankelijke controlepunten](https://support.pix4d.com/hc/en-us/articles/115000140963).

Deze principes ondersteunen de vervolgopzet; de lokale apparaatmetingen bepalen of de concrete Novabot-methode voldoet.
