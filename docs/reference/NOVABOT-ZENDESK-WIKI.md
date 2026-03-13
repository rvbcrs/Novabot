# Novabot Official Knowledge Base (Zendesk)

> Bron: [lfibot.zendesk.com](https://lfibot.zendesk.com/hc/en-gb) — volledig geextraheerd via Zendesk API op 8 maart 2026.

---

## Inhoudsopgave

- [1. Firmware & App Versies](#1-firmware--app-versies)
- [2. Installatie](#2-installatie)
  - [2.1 Plaatsing laadstation & GNSS antenne](#21-plaatsing-laadstation--gnss-antenne)
  - [2.2 Fysieke installatie](#22-fysieke-installatie)
  - [2.3 Verbinden met de app](#23-verbinden-met-de-app)
  - [2.4 Firmware updaten (OTA)](#24-firmware-updaten-ota)
  - [2.5 Loskoppelen van de app](#25-loskoppelen-van-de-app)
- [3. Tuinkaart maken (Mapping)](#3-tuinkaart-maken-mapping)
  - [3.1 Kaart aanmaken](#31-kaart-aanmaken)
  - [3.2 Obstakels & kanalen](#32-obstakels--kanalen)
  - [3.3 Maaien starten](#33-maaien-starten)
  - [3.4 Schema (Schedule)](#34-schema-schedule)
  - [3.5 Geavanceerde instellingen](#35-geavanceerde-instellingen)
- [4. Firmware Changelog](#4-firmware-changelog)
  - [4.1 v5.7.1 / v0.3.6 / App 2.3.8](#41-v571--v036--app-238)
  - [4.2 v5.6.x / v0.3.6 (testversie)](#42-v56x--v036-testversie)
- [5. FAQ](#5-faq)
  - [5.1 Functies & specificaties](#51-functies--specificaties)
  - [5.2 Accessoires](#52-accessoires)
  - [5.3 Operationeel](#53-operationeel)
- [6. Troubleshooting](#6-troubleshooting)
  - [6.1 Foutmeldingen (Error codes)](#61-foutmeldingen-error-codes)
  - [6.2 Overige problemen](#62-overige-problemen)
- [7. Video Tutorials](#7-video-tutorials)
- [8. Contact & Support](#8-contact--support)

---

## 1. Firmware & App Versies

> **Belangrijk**: Gebruik ALTIJD de bijpassende app-versie na een firmware update!

| APP versie | Platform | Maaier firmware | Station firmware | Opmerking |
|------------|----------|-----------------|------------------|-----------|
| 1.2.29 | iOS (TestFlight) | v4.6.6 | v0.1.9 | Handmatig gepusht door fabriek |
| 1.2.29 | Android (APK) | v4.6.6 | v0.1.9 | Handmatig gepusht door fabriek |
| 2.0.1 | iOS (TestFlight) | v4.7.6 | v0.2.4 | Fix voor speciaal probleem |
| 1.3.0 | Android (APK) | v4.7.6 | v0.2.4 | Fix voor speciaal probleem |
| 2.2.0 | Apple Store / Google Play | v4.7.3 | v0.2.5 | Standaard release |
| 2.2.0 | Apple Store / Google Play | v5.0.6 | v0.3.3 | Standaard release |
| 2.3.8 | Apple Store / Google Play | v5.1.8 | v0.3.4 | Huidige release |

**Opmerkingen:**
- App 2.2.0 en latere versies zijn compatibel met firmware-updates
- Speciale tekens kunnen nu worden gebruikt in WiFi-credentials bij verbinding met de maaier
- Firmware-update beschikbaar wanneer de rode stip op de OTA-knop verschijnt

---

## 2. Installatie

### 2.1 Plaatsing laadstation & GNSS antenne

De plaatsing is **cruciaal** voor goede GPS/RTK-prestaties:

1. **120-graden vrij**: Houd 120 graden vanaf de bovenkant van de GNSS-antenne vrij van obstakels
2. **Hoek-regel**: Hoge obstakels moeten onder een hoek van 30 graden vanaf de horizontale lijn van de antenne blijven
3. **Afstand tot beplanting**: Minimaal 20cm vrije ruimte van struiken/lage muren tot de bovenkant van de antenne
4. **Geen metaal**: Vermijd metalen objecten in de buurt (hekken, poorten, etc.)
5. **Vlak terrein**: Installeer op een vlak gazon — vermijd hellingen, kuilen en metalen ondergrond
6. **WiFi bereik**: Installeer dicht bij het WiFi-signaal van je huis (2.4 GHz aanbevolen)
7. **2 meter vrij**: Houd minimaal 2 meter ruimte rond het laadstation vrij van obstakels en sprinklers
8. **Beveiligingsradius**: Optioneel 3,5 meter radius voor beveiligingsfuncties
9. **Loodrecht op grasrand**: Positioneer het station loodrecht op de rand van het gazon, richting het gras

**Na installatie:**
- **Verplaats de GNSS-antenne of het laadstation NIET meer** — dit vereist opnieuw mappen
- Bij verplaatsing >5 meter is opnieuw mappen altijd nodig
- Plaats de antenne NIET achter glas — dit beïnvloedt de signaalsterkte en veroorzaakt RTK-problemen

![Laadstation plaatsing](https://lfibot.zendesk.com/hc/article_attachments/16441759710487)

### 2.2 Fysieke installatie

**5 montagestappen:**
1. Bracket montage
2. Antenne/kabel installatie
3. Klittenband bevestiging
4. Verticale grondplaatsing — **hoek met de grond mag niet groter zijn dan 10 graden**
5. Draad/groef uitlijning

**7 richtlijnen voor het laadstation:**
1. Plaatsing op vlak gazon
2. Nabijheid van WiFi
3. 2 meter obstakelvrije ruimte
4. Optionele beveiligingsradius
5. Loodrechte positionering
6. Wandgemonteerde voeding minimaal 30cm van de grond
7. Stroomaansluiting

### 2.3 Verbinden met de app

#### Stap 1: Laadstation verbinden

1. Zorg dat Bluetooth op je telefoon aanstaat
2. Scan de QR-code op het laadstation om te verbinden
3. Voer je WiFi-inloggegevens in na succesvolle verbinding
   - **WiFi MOET 2.4 GHz zijn** — 5 GHz werkt niet
   - **Geen spaties of speciale tekens** in WiFi-naam/wachtwoord
4. Controleer GPS-coördinaten na verbinding met WiFi
5. **Als je de antenne of het laadstation verplaatst na deze stap, moet je het laadstation opnieuw toevoegen en WiFi opnieuw invoeren**

![WiFi setup fout](https://lfibot.zendesk.com/hc/article_attachments/20021654136215)

> **Foutmelding "Get signal info failed"?** Controleer of het laadstation goed verbonden is met de GNSS-antenne bovenop. Opnieuw aansluiten kan 1-2 minuten duren.

#### Stap 2: Maaier verbinden

1. Open het instellingenmenu op het maaier-scherm
2. Ga naar "About" om de QR-code en het serienummer te vinden
3. Scan de QR-code met de app

**Na verbinding:**
- De maaier kan tijdelijk als offline verschijnen — dit is normaal tijdens systeeminitialisatie
- De app kan momenteel geen realtime signaalsterkte tonen voor WiFi, GPS, maaier of Bluetooth

### 2.4 Firmware updaten (OTA)

1. Plaats de maaier in het laadstation en zorg dat hij verbonden is
2. Ga naar **Profile → Setting → About**
3. Zoek **"NOVABOT Device Upgrade (OTA)"**
4. Druk op OK om de update te starten
5. **De volledige update duurt 20-30 minuten**

**Belangrijke regels:**
- Houd de maaier op het laadstation tijdens de update
- Schakel de stroom NIET handmatig uit
- Als de update vastloopt: haal de maaier uit het station, herstart, en probeer opnieuw

**Na de update:**
- De app kan "machine chassis error" melden — dit is normaal na een firmware-update
- Klik "OK" en voer het wachtwoord in om de fout te ontgrendelen
- Als "Novabot RTK error" verschijnt na het invoeren van het wachtwoord: haal de maaier uit het laadstation en herstart

![RTK error na update](https://lfibot.zendesk.com/hc/article_attachments/22861445369623)
![Wachtwoord invoer](https://lfibot.zendesk.com/hc/article_attachments/22861445374743)
![RTK error scherm](https://lfibot.zendesk.com/hc/article_attachments/22861476401687)

### 2.5 Loskoppelen van de app

1. Open de Novabot-app en selecteer **My devices** rechtsboven op de homepage
2. Druk op **"About Novabot"** en verwijder
3. **De maaier MOET eerst verwijderd worden vóór het laadstation**
4. Ga naar **My devices**, zoek **"About charger"** en verwijder

---

## 3. Tuinkaart maken (Mapping)

> Beschikbaar voor App 2.3.8 met firmware v5.7.1/v0.3.6

### 3.1 Kaart aanmaken

1. Klik **"Start → Start mapping"** of **"Lawn"** op de homepage
2. De app controleert automatisch: WiFi, GPS, Bluetooth, telefoon-batterij en Novabot-batterijniveau
3. Klik op de **Map**-knop
4. **Sleep de groene cirkel** in het midden naar de pijlen om de robot naar de rand van het gazon te sturen
5. De **Start-knop wordt groen** als de locatie juist is — klik om door te gaan
6. De **Done-knop wordt groen** als de kaart klaar is — klik om door te gaan

**Opties tijdens het mappen:**
- **Reset**: opnieuw beginnen met mappen
- **Retract**: maaier rijdt automatisch achteruit

**Regels:**
- Maximaal **3 kaarten** — ze moeten verbonden zijn via kanalen (channels)
- Terugkeren naar het laadstation is alleen nodig voor de eerste kaart
- Een kanaal wordt automatisch aangemaakt als de afstand tussen het gazon en het laadstation groter is dan 1,5m
- Plaats kaarten niet te dicht bij elkaar om verwarring met doorgangen te voorkomen
- **Opnieuw mappen is verplicht als de GNSS-antenne of basis wordt verplaatst**

### 3.2 Obstakels & kanalen

#### Obstakels (No-go zones)

1. Klik **"Obstacle"** om een no-go zone te maken
2. De maaier moet op de gemaakte kaart staan (Start-knop wordt groen)
3. De **Done-knop wordt groen** als de no-go zone klaar is

**Richtlijnen:**
- De maaier kan zelf obstakels ontwijken (via camera + ToF sensoren)
- Verwijder onkruid, takken of obstakels langer dan 20cm
- Obstakels kunnen alleen worden aangemaakt na het maken van twee kaarten
- **Aanbeveling**: map obstakels die groter zijn dan 1 meter
- Grens van obstakelkaart mag niet te dicht bij de grens van de gazonkaart liggen (minimaal 2-3m)

#### Kanalen (Passageways)

1. Klik **"Channel"** om een doorgang tussen twee kaarten te maken
2. Positioneer de robot op de gemaakte kaart
3. De **Done-knop wordt groen** als het kanaal klaar is

**Vereisten:**
- **Kanaallengte moet langer zijn dan 0,5 meter** en binnen RTK-bereik
- Anders kan het kanaal niet worden gebruikt, zelfs als het wel kan worden aangemaakt

### 3.3 Maaien starten

**Methode 1 — Start:**
- Start direct met maaien
- **Terminate**: volledig resetten
- **Pause**: stopt, toont al gemaaid vs. resterend gebied

**Methode 2 — Lawn:**
- De kaart verschijnt bij het klikken op de startknop
- Verschijnt ook op het geplande maaitijdstip

**Visuele weergave:**
- **Lichtgroen** = nog te maaien gebied
- **Donkergroen** = al gemaaid gebied
- **Opgeblazen grenzen** worden berekend door het systeem op basis van de gemaakte kaart

**Randafwerking:**
- De maaier maait het gebied rond no-go zones en hoeken van de kaart minstens **drie keer**
- Dit resulteert in een donkerdere kleur dan het omringende gebied

**Extra functies:**
- Stippellijn = tweede maaibeurt, start opnieuw vanaf het begin
- De maaier herstelt zichzelf als hij stopt (RTK verloren) tijdens het maaien
- De maaier kan doorgaan vanaf het laatste stoppunt met de terugknop
- **Lawn → Add/Edit → Modify map**: kaartgrenzen opnieuw mappen

### 3.4 Schema (Schedule)

- **Onbeperkt** aantal schema's aanmaken
- Huidige datum wordt weergegeven
- Tijd kan direct worden aangepast (gaat niet terug naar 8:00)
- **Minimale schema-duur: 30 minuten**
- De maaier start automatisch als het schema is aangemaakt
- **Het schema wordt ongeldig als de startknop handmatig wordt ingedrukt na aanmaak**
- Als een schema verdwijnt door een fout: selecteer "retry" bij de "Date"-optie

**Handmatig starten na schema:**
- Doe dit NIET — het maakt het schema ongeldig
- Na een zelf-veroorzaakte onderbreking (opladen, obstakel ontwijken) gaat de maaier verder
- Na een handmatige onderbreking start de maaier het hele gazon opnieuw

### 3.5 Geavanceerde instellingen

> **Geavanceerde instellingen zijn alleen online toegankelijk en worden pas actief bij de volgende nieuwe maaisessie.**

- **Manuele controller**: bestuur de maaier met instelbare maximale snelheid — geen fysiek terugdragen naar basis nodig
- **Maaihoek (Path direction)**: selecteer de maairichting en bekijk een preview
- **Obstakel-gevoeligheid**: Laag / Medium / Hoog (zie [Firmware Changelog](#41-v571--v036--app-238))
- **Maximum snelheid**: instelbaar
- **Draaisnelheid (Handling)**: snelheid bij bochten

> **Activeer de manuele controller NIET terwijl de maaier oplaadt** — dit veroorzaakt constante meldingen.

---

## 4. Firmware Changelog

### 4.1 v5.7.1 / v0.3.6 / App 2.3.8

**App verbeteringen:**
1. App 2.2.0+ compatibel met firmware-updates
2. Speciale tekens in WiFi nu ondersteund
3. OTA-update via rode stip op OTA-knop
4. Download via App Store / Google Play
5. **Modify map** functie: links klikken om gebieden te vergroten, rechts om te verwijderen
6. **Maaihoek selectie**: hoek kiezen en preview bekijken
7. Verbeterde obstakel-gevoeligheid (gebaseerd op v5.4.2)
8. Bijgewerkt visiemodus
9. Verbeterd probleem met hoog/medium niveau obstakeldetectie en hoog-gras herkenning
10. **Manuele controller**: instelbare max snelheid, geen terugdragen naar basis nodig

**Maaien & mapping verbeteringen:**
1. Kaart toont opgeblazen grenzen met zwarte vakjes als paden
2. Verbeterde obstakel-ontwijking
3. Randafwerking na voltooiing van gemapt gebied
4. Tweede maaibeurt mogelijkheid
5. **Super grote kaart upload (tot 1,5 acre / ~6000 m2)**
6. Fix: interne coverage module fouten
7. Fix: zelf-kruising tijdens mappen
8. Fix: positioneringsproblemen
9. Optimalisatie LoRa-communicatie
10. Verbeterde botsingsdetectie
11. Motorbeveiliging
12. Verbeterd terugkeren naar laadstation
13. Fix: padfouten
14. **Verbetering**: terugkeren naar laadstation, buiten-grenzen, en OTA-updatesnelheid

**Schedule verbeteringen:**
1. Onbeperkt schema's aanmaken
2. Huidige datum weergave
3. Tijd direct aanpasbaar (geen reset naar 8:00)

### 4.2 v5.6.x / v0.3.6 (testversie)

**Obstakel-gevoeligheid — 3 niveaus:**

| Niveau | Beschrijving |
|--------|-------------|
| **Laag** | Alleen botsingsfunctie. ToF en camera worden NIET gebruikt. Mensen, dieren en niet-gemapte obstakels veroorzaken botsingen voor detectie. |
| **Medium** | ToF + camera met detectiemodus |
| **Hoog** | ToF + camera met segmentatiemodus |

**Hardware configuratie:**
- **Twee linker ToF-camera's**: voor afstands- en obstakelhoogte-detectie
- **Rechter camera**: maakt beelden van obstakels in verschillende modi om objecten te identificeren

**18 verbeteringen:**
1. Verbeterde positioneringsherstel
2. Fix: coverage module fouten
3. Fix: zelf-kruising tijdens mappen
4. Geforceerde segmentatie
5. LoRa-frequentiereductie
6. **CPU temperatuurdrempel verhoogd naar 96 graden**
7. Bijgewerkt visiemodel
8. Verfijning obstakel-gevoeligheid
9. Verbeterde navigatie naar laadstation
10. Fixes voor kaart bewerken
11. Buiten-grenzen herstellogica
12. RTK-stabiliteit
13. Oplossing voor vastlopen aan randen

**Testvereisten voor gebruikers:**
- Test effectiviteit bij slechte locatieomstandigheden
- Test alle drie obstakel-gevoeligheidsniveaus
- Documenteer (foto's/video's met timestamps en temperaturen) bij problemen met positionering, LoRa, oververhitting of grensoverschrijdingen

---

## 5. FAQ

### 5.1 Functies & specificaties

#### Batterij laadt niet op

**Oorzaak**: Slecht contact tussen oplaadpoort en stekker.

**Oplossing:**
1. De oplaadstekker moet **volledig in de oplaadpoort worden gestoken**
2. Plaats het laadstation horizontaal om verschuiven door zwaartekracht te voorkomen
3. Als het niet lukt: stuur omgevingstemperatuur, foto van laadstationlocatie en maaier-schermafbeelding naar support@lfibot.com

#### Betekenis van de lampjes op het laadstation

| Lampje | Betekenis |
|--------|-----------|
| **Uit** | Maaier niet verbonden (ondanks dat stroom aan is) |
| **Rood constant** | Maaier wordt opgeladen |
| **Groen constant** | Volledig opgeladen, maaier nog in dock |
| **Rood knipperend** | Netwerkfout |
| **Rood + groen knipperend** | Geen netwerkverbinding |
| **Rood + groen constant** | Succesvolle netwerkverbinding |

#### Maaien op hellingen

- De maaier werkt op hellingen tot **24 graden** (45%)
- Beste resultaten bij hellingen **minder dan 20 graden**
- Het kan langer duren op hellingen

#### Opmerkingen over hellingen

- Verminder de snelheid van de maaier op hellingen
- Pas de maaihoek aan voor soepele prestaties

#### Buiten de grenzen (Out of boundary)

- Controleer de antenne-locatie (foto's nuttig voor verificatie)
- Vermijd metalen objecten in de buurt
- Vermijd hoge bomen
- **Plaats de antenne NIET achter glas** — beïnvloedt signaalontvangst en veroorzaakt RTK-problemen

#### Opslag (winter)

- **Maandelijks opladen** terwijl de maaier horizontaal blijft
- **Binnenshuis opladen als temperatuur onder 4°C**
- Uitschakelen via rode schakelaar onderin en losmaken van laadstation
- Bewaren op droge locatie
- GNSS-antenne aangesloten houden en beschermen tegen water
- **Temperatuurbereik: 4-40°C**
- Onder -30°C: apparatuur naar binnen verplaatsen
- **Niet werken onder 4°C**

#### Knipperend licht en pieptoon

Beveiligingsmelding: de messen zijn ingeschakeld en de maaier gaat werken.

#### Herpositionering GNSS-antenne

- Verplaats de antenne niet zonder noodzaak — kleine verplaatsingen beïnvloeden het signaal
- Vermijd metalen objecten in de buurt
- Niet achter glas plaatsen
- **Opnieuw mappen is nodig na verplaatsing**

#### Beschrijving van app- en maaier-schermsymbolen

| Symbool | Functie | Details |
|---------|---------|---------|
| **GPS** | Locatiebepaling via RTK | GNSS-antenne + maaier ontvangen satellietsignalen. Antenne in open gebied plaatsen. |
| **Bluetooth** | Telefoonbesturing + mapping | Telefoon dicht bij maaier houden als BT niet goed werkt. |
| **WiFi** | Communicatie via router | Afstandsbesturing en informatie-uitwisseling. Maaier/station dicht bij router plaatsen bij problemen. |
| **LoRa** | Maaier↔laadstation communicatie | Lage-energiecommunicatie voor afstandsdetectie. Werkt in zwak-netwerk situaties. **Kan NIET handmatig worden aangepast door gebruikers.** |

**Statuskleuren:**
- **Cyaan**: goed
- **Rood**: slecht
- **Grijs**: offline

#### Bluetooth tonen als ontkoppeld in telefooninstellingen

Bluetooth is alleen actief voor mapping en app-verbinding. Het schakelt automatisch uit wanneer het niet wordt gebruikt om signaalinterferentie te voorkomen. Het is normaal dat het als ontkoppeld verschijnt in telefooninstellingen.

#### LoRa data-transmissiefout

Een data-transmissiefout geeft een tijdelijke onderbreking aan van de LoRa-communicatie tussen maaier en basisstation.
- Herstelt meestal automatisch
- Of handmatig via de bevestigingsknop
- Neem contact op met support als het probleem niet binnen 10 minuten is opgelost

### 5.2 Accessoires

#### Wielwaarschuwing (Wheel Warning)

**Voorwiel problemen — benodigde onderdelen:**
1. **Voorwiel bus**: Buitendiameter 16,7mm × Binnendiameter 8mm × Dikte 33,5mm
2. **Lager borgveer (staal)**: 8,0mm × 0,3mm (M8)
3. **Voorwiel lager**: Model S608 2RS — Buitendiameter 22mm × Binnendiameter 8mm × Dikte 7mm

**Achterwiel problemen:**
- Breng schroefdraadborging aan op M4×12 schroeven
- 12 uur wachten voor gebruik
- Niet te repareren? Terugsturen naar servicecentrum

#### Wat zit er in de doos

- Messen (9 of 18 stuks) zitten in dezelfde doos onderin

#### Levensduur messen

- **Vervang de messen elke 1,5-2 maanden** voor optimaal maairesultaat
- Controleer de messenconditie regelmatig
- Meldingsfunctie voor mesvervanging is gepland

### 5.3 Operationeel

#### WiFi — 2.4 GHz vs 5 GHz

Novabot gebruikt **2.4 GHz WiFi** omdat dit:
- Breder bereik biedt over lange afstanden
- Beter door obstakels heen kan

**RSSI** (Received Signal Strength Indicator) meet de signaalsterkte:
- Waarde hoger dan **-80**: goede dekking
- Android: installeer **WiFi Analyzer** app
- iPhone: gebruik **Airport Utility** app

#### Maaier keert moeilijk terug naar laadstation

**Overdag:**
- Gebruik een droge doek om de QR-code op het laadstation schoon te maken en probeer opnieuw

**'s Nachts:**
- Verwijder sterke lichtbronnen
- Plak zwart papier in het geel gemarkeerde gebied om reflecties te verminderen

#### Opmerkingen bij schedule & maaionderbreking

- Start het maaien NIET handmatig na het aanmaken van een schema
- Na een **zelf-veroorzaakte onderbreking** (opladen, obstakel): maaier gaat verder
- Na een **handmatige onderbreking**: maaier start het hele gazon opnieuw

#### Opmerkingen bij update en afsluiten

- Houd maaier op laadstation tijdens updates, schakel stroom niet handmatig uit
- Bij vastzittende update: maaier verwijderen, herstarten, opnieuw proberen
- Afsluiten: rode schakelaar uit + van laadstation halen

#### Verificatiecode niet ontvangen

1. Controleer spam/junkmail folders
2. Wacht ongeveer 1 minuut
3. Overweeg Gmail als alternatief
- Het team werkt aan ondersteuning voor andere e-mailproviders

#### Inloggen mislukt na wachtwoordreset

- Zorg dat het reset-e-mail overeenkomt met het registratie-e-mail
- **Wachtwoord mag GEEN spaties, speciale tekens of leestekens bevatten**

#### App log uploaden

Ga naar **Profile → Settings → App Log Upload** en druk op de uploadknop.

---

## 6. Troubleshooting

### 6.1 Foutmeldingen (Error codes)

#### "Novabot RTK upgrading, please do not turn off" / "Novabot RTK error"

Deze foutmelding verschijnt tijdens firmware-updates, vooral wanneer de app meldt dat de update geslaagd is maar vervolgens **"machine chassis error"** toont.

**Oplossing:**
1. Klik eerst "OK"
2. Voer het wachtwoord in om de fout te ontgrendelen
3. Als **"Novabot RTK error"** verschijnt na het invoeren van het wachtwoord: haal de maaier uit het laadstation en herstart

#### "No pairable device was identified" (App 1.2.29)

> **Doe eerst een zelfcheck**, vooral als firmware lager is dan v4.7.3 en v0.2.5.

1. Zet de schakelaar onderin de maaier aan
2. Verwijder het laadstation en verbind laadstation + maaier opnieuw
3. Haal de maaier uit het station, herstart, en controleer of de tijd correct is
4. Ga naar het instellingenmenu → "About" of "Novabot serial number" — controleer of de QR-code zichtbaar is
5. Laat de maaier niet constant aan als hij niet verbonden is met de app (behalve maandelijks opladen)

#### "No pairable device was identified" (algemeen)

1. Controleer of de maaier aan staat
2. Controleer of de app correct wordt gebruikt
3. Controleer of WiFi-naam en wachtwoord spaties/speciale tekens bevatten — zo ja, reset en probeer opnieuw
4. Controleer WiFi-frequentie: **MOET 2.4 GHz zijn**

#### "Get signal info failed, pls retry"

1. Zorg dat het laadstation verbonden is met de GNSS-antenne
2. Controleer of de verbinding tussen laadstation en bovenkant GNSS-antenne los zit — opnieuw aansluiten
3. Opnieuw proberen en app-log uploaden

#### "No map! Please create a map"

- Herstart de app — de gemaakte kaart verschijnt dan op het scherm
- Dit is een probleem met synchrone kaartuploading

#### GPS en Bluetooth signalen zijn zwak

1. Controleer versie van laadstation en maaier (App → Profile → Settings → About)
2. Controleer locatie GNSS-antenne (foto nodig voor verificatie)
3. **Gebruik de maaier NIET onder een dak of afdak** — verplaats de maaier iets naar voren en ververs
4. Verwijder laadstation + maaier uit de app en verbind opnieuw
5. Geen obstakels tussen laadstation en maaier
6. Als het blijft falen: maaier aan laten en tijdstip melden (voor log-analyse)

#### "Search bluetooth timeout"

1. Let op de tijd op het maaier-scherm (foto maken als de tijd niet klopt)
2. Herstart het laadstation
3. Haal maaier uit station, herstart, en verbind opnieuw
4. Schakel Bluetooth uit op telefoon, wacht 2 seconden, schakel weer in
5. Schakel locatietoestemming in op telefoon
6. Herstart de app
7. Als het blijft falen: herhaal bovenstaande stappen (Bluetooth heeft tijdslimiet, wordt opnieuw ingeschakeld bij herstart laadstation)

#### "NOVABOT's Bluetooth is disconnected. Please retry or exit mapping..."

Als deze fout verschijnt terwijl je bijna klaar bent met een kaart:
1. Sluit de app
2. Schakel Bluetooth uit, wacht 2 seconden, schakel weer in
3. Open de app en maak de kaart opnieuw
4. Als het blijft falen en Bluetooth ontkoppeld is: herstart de maaier (**haal hem eerst uit het laadstation!**)

#### "Bluetooth Signal error" (v4.7.3+0.2.5+2.1.0)

Als deze fout verschijnt bij het aanmaken van gazonbegrenzingen:
1. Herstart de maaier
2. Houd je telefoon dicht bij de maaier

#### "Start navigation failed, please check it"

- Herstart de maaier

#### "The charging station network is abnormal, please check it"

1. Herstart de maaier en wacht een minuut (kan komen door slecht netwerk)
2. Herstart de app (optioneel)

#### "Set config info failed, please retry"

1. Lees eerst de meegeleverde instructies en download de juiste app
2. Verbind laadstation en maaier opnieuw

#### "Map upload failed"

1. Controleer of laadstation en maaier succesvol zijn bijgewerkt (Profile → Settings → About)
2. Zo niet: herinstalleer app 1.2.29, verbind opnieuw, **druk op de rode stip op de Device Upgrade knop tot hij verdwijnt**
3. Update naar nieuwste versie
4. Controleer of telefoon WiFi of mobiele data heeft — zo niet, ga dichter bij WiFi
5. **WiFi-naam en wachtwoord mogen GEEN spaties of speciale tekens bevatten**
6. Herstart en verbind opnieuw
7. Als alles in orde is maar het probleem blijft:
   - Laadstation dichter bij router plaatsen
   - Geen metalen objecten rond GNSS-antenne
   - Herstart en probeer opnieuw
8. Als het probleem blijft bestaan:
   - App-log uploaden
   - Maaier aan laten
   - Tijdstip van het probleem melden

#### Zwak GPS en moeilijk te mappen

1. Controleer plaatsing GNSS-antenne — niet onder afdak, niet achter glas, niet bij water
2. Ga naar open gebied
3. Verwijder apparaten uit de app en voeg opnieuw toe

#### Maaiermotor fout / linkermotor fout

1. Controleer op obstakels in het maaidek
2. Controleer wielweerstand
3. Pas grasdichtheids-instellingen aan
4. Schakel uit en weer in (power cycle)
5. Maak de maaier schoon wanneer hij in het laaddock staat

#### Oververhitting

1. Haal de maaier van het dock om af te koelen
2. Vermijd direct zonlicht tijdens het laden
3. Werk tijdens koelere perioden
4. Nieuwste firmware schakelt camera automatisch uit bij te hoge temperaturen

#### Maaier doet het niet meer (na verwijderen van dock)

**Stap 1 — Eerste controles:**
- Controleer schakelaar positie
- Controleer oplaad-indicator status
- Verwijder eventueel schuim
- Controleer magneetplaatsing

**Stap 2 — Geavanceerde diagnose:**
- Controleer connectors
- Meet spanning met multimeter

### 6.2 Overige problemen

#### WiFi stopt met werken

1. Controleer en reset WiFi-naam/wachtwoord als er **spaties of speciale tekens** in staan
2. Test WiFi-kwaliteit met een app (zie [2.4 GHz vs 5 GHz](#wifi--24-ghz-vs-5-ghz))
3. **Aanbevolen**: schakel persoonlijke hotspot in op telefoon en verbind via die hotspot (zonder spaties/speciale tekens)
4. Upload app-log en meld tijdstip als het blijft falen
5. Na verbinding kan Novabot tijdelijk als offline verschijnen — dit is normaal

#### Verificatiecode niet ontvangen

Zie [FAQ → Verificatiecode niet ontvangen](#verificatiecode-niet-ontvangen)

---

## 7. Video Tutorials

### Installatie

| Video | YouTube ID | Link |
|-------|-----------|------|
| Batterij installatie tutorial | FfnNZtfv9g8 | [Bekijken](https://www.youtube.com/watch?v=FfnNZtfv9g8) |
| Quick set up guide | hS7DyDviA8I | [Bekijken](https://www.youtube.com/watch?v=hS7DyDviA8I) |
| Plaatsing laadstation | uUiPSLGQZw0 | [Bekijken](https://www.youtube.com/watch?v=uUiPSLGQZw0) |
| Installatie NOVABOT | 3Hpf-S5dlxk | [Bekijken](https://www.youtube.com/watch?v=3Hpf-S5dlxk) |

### Bediening

| Video | YouTube ID | Link |
|-------|-----------|------|
| 2.4 GHz netwerk setup | TRwkgeTzylU | [Bekijken](https://www.youtube.com/watch?v=TRwkgeTzylU) |
| Mapping overwegingen | r_vjmkJYphE | [Bekijken](https://www.youtube.com/watch?v=r_vjmkJYphE) |
| Mes vervanging | *(zie Bulletins)* | — |

---

## 8. Contact & Support

**E-mail:** support@lfibot.com

**Via de app:**
1. App → Profile → Help center
2. App → Profile → Help center → Intelligent Novabot (AI-assistent)

**Werkuren:** Zie [lfibot.zendesk.com](https://lfibot.zendesk.com/hc/en-gb/articles/19274878064791) voor actuele tijden.

**Bij het melden van een probleem, vermeld:**
1. Tijdstip van het incident
2. Screenshots van foutmeldingen
3. Serienummers van apparaten
4. Registratie-e-mailadres
5. Video's van het probleem
6. App-logs (Profile → Settings → App Log Upload)

> **Tip:** Laat de maaier 6 uur aan na een probleem zodat support de maaier-logs kan ophalen via de backend.

**Affiliate programma:** [partner.novabotstore.com/register](https://partner.novabotstore.com/register)

---

## Appendix: Hardware-specificaties (uit FAQ)

| Eigenschap | Waarde |
|-----------|--------|
| Maximale helling | 24 graden (45%) |
| Optimale helling | < 20 graden |
| Werktemperatuur | 4-40°C |
| Opslagtemperatuur | > -30°C |
| WiFi | 2.4 GHz (geen 5 GHz) |
| Communicatie maaier↔station | LoRa |
| Positiebepaling | RTK-GPS via GNSS-antenne |
| Obstakeldetectie | 2x ToF camera (links) + 1x camera (rechts) |
| Obstakel-gevoeligheid | 3 niveaus: Laag (botsing), Medium (ToF+cam detectie), Hoog (ToF+cam segmentatie) |
| CPU temp drempel | 96°C (v5.6.x+) |
| Max kaartgrootte | 1,5 acre (~6000 m2) |
| Max aantal kaarten | 3 (verbonden via kanalen) |
| Min kanaallengte | 0,5 meter |
| Mes levensduur | 1,5-2 maanden |
| Min schema-duur | 30 minuten |
