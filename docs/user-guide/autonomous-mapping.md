# Autonoom karteren (grasrand automatisch volgen)

Deze functie laat de maaier zelfstandig langs de rand van het gras rijden om
een kaart van je tuin te maken. Je hoeft dan niet meer handmatig met de
bluetooth-afstandsbediening de rand van je tuin rond te lopen. De maaier
herkent zelf waar gras ophoudt (bijvoorbeeld bij tegels, border of grind) en
volgt die rand rondom. Het resultaat is een kaartvoorstel dat je zelf bekijkt
en pas na jouw goedkeuring definitief wordt.

## Wat het wel en niet doet

- De maaier rijdt zelfstandig één ronde langs de buitenrand van het
  gazon, gestuurd door zijn camera's die gras van niet-gras onderscheiden.
- Er wordt een kaart opgebouwd terwijl de maaier rijdt. Die kaart is pas een
  **voorstel**: hij wordt niet automatisch actief. Je krijgt hem eerst te
  zien en beslist of je hem accepteert of weggooit.
- De maaier vermijdt tijdens de rit gewoon obstakels en stopt bij een botsing,
  net als tijdens normaal maaien.
- **Testrit** raakt geen kaartdata: die rijdt de rand rond zonder iets op te
  slaan, ook niet op een maaier die al een kaart heeft.
- **Kaart maken** werkt alleen op een maaier die nog GEEN bestaande kaart
  heeft. De gemaakte kaart wordt na de rit meteen op de maaier weggeschreven;
  er is geen wachtstand die pas bij "accepteren" iets opslaat. Het
  dashboard-voorstel bepaalt vervolgens of je die kaart definitief houdt.
  Verwerp je hem, dan verwijder je de kaart daarna zelf via het bestaande
  kaartbeheer van de maaier.

## Vereisten voordat je start

- Je maaier moet de aangepaste (custom) firmware met de grasrand-herkenning
  erop hebben. Op stock/originele firmware is deze functie niet beschikbaar.
- De maaier moet **RTK Fixed** hebben (de nauwkeurigste GPS-status). Zonder
  Fixed start de rit niet.
- De accu moet **boven 40%** zitten.
- Zet de maaier **midden op het gras**, ruim van de rand af, en **niet op het
  laadstation**. De maaier zoekt vanaf zijn startpunt de dichtstbijzijnde
  grasrand; als hij op de oprit, tegels of het laadstation staat, vindt hij
  geen rand om te volgen.
- Er mag nog geen andere autonome kartering bezig zijn voor deze maaier.
- Voor **Kaart maken** mag de maaier nog geen bestaande kaart hebben. Heeft
  hij die wel, verwijder je die eerst via het bestaande kaartbeheer, of blijf
  je bij een testrit.

## Hoe je het gebruikt (dashboard)

1. Ga naar het kaart-tabblad van je maaier en open het paneel "Autonoom
   karteren".
2. Stel eventueel de geofence in (zie hieronder) en kies eerst voor
   **Testrit (zonder opname)**. Dit laat de maaier de grasrand volgen zonder
   dat er een kaart wordt opgeslagen. Zo controleer je of de rit
   goed verloopt voordat je een echte kaart laat maken.
3. Bevalt de testrit? Start daarna **Kaart maken**. De maaier rijdt dezelfde
   soort rit, maar legt nu de route vast als kaart.
4. Tijdens de rit zie je live de status: voorbereiden, grasrand zoeken, rand
   volgen, opnemen, kaart opslaan.
5. Zodra de maaier klaar is, krijg je de melding "De maaier heeft een kaart
   gemaakt. Controleer hem op de kaartweergave en accepteer of verwerp."
6. Bekijk de kaart op de kaartweergave. Klik op **Kaart accepteren** als hij
   klopt, of op **Verwerpen** als hij niet goed is. Na verwerpen kun je de
   proefkaart via het bestaande kaartbeheer van de maaier verwijderen en
   gewoon opnieuw een poging starten.
7. Je kunt de rit op elk moment stoppen met de stopknop in het paneel.

## Veiligheidsvangnetten

Deze zitten er altijd in, ook tijdens een testrit:

- **Geofence**: de maaier mag zich maximaal een ingestelde afstand van zijn
  startpunt verwijderen. Standaard 30 meter, zelf instelbaar tussen 5 en 200
  meter. Overschrijdt de maaier deze afstand, dan stopt de rit direct.
- **Tijdslimiet**: een rit stopt automatisch na 20 minuten, ook als de maaier
  nog niet klaar is.
- **GPS-controle**: valt de GPS-ontvangst weg of wordt de positie niet meer
  ververst, dan stopt de rit uit voorzorg in plaats van blind door te rijden.
- **Obstakelvermijding blijft actief**: de bumper en camera-detectie werken
  gewoon door tijdens de rit, net als bij normaal maaien.
- **Stopknop**: je kunt de rit altijd handmatig afbreken vanuit het
  dashboard.
- Vindt de maaier bij de start geen duidelijke grasrand, dan probeert hij
  automatisch één keer opnieuw (rijdt een klein stukje vooruit en zoekt
  opnieuw). Lukt het dan nog niet, dan stopt de rit met een foutmelding in
  plaats van te blijven proberen.

## Foutmeldingen

| Melding | Betekenis |
|---|---|
| Accu moet boven 40% zijn | De accu is te leeg om de rit veilig te starten. Laad de maaier eerst op. |
| Wacht op RTK Fixed | De GPS-positie is nog niet nauwkeurig genoeg. Wacht tot de maaier een Fixed-status heeft (dit kan na opstarten of in de schaduw even duren). |
| Er loopt al een sessie | Er is al een autonome kartering bezig voor deze maaier. Wacht tot die klaar is of stop hem eerst. |
| Geofence overschreden, rit gestopt | De maaier is verder van zijn startpunt gekomen dan de ingestelde geofence-afstand. De rit is uit voorzorg gestopt. |
| Tijdslimiet bereikt | De rit duurde langer dan 20 minuten en is daarom automatisch gestopt. |
| lawn_edge_relay draait niet op de maaier | De grasrand-herkenning is niet actief op de maaier. Dit wijst meestal op een probleem met de custom firmware; neem contact op als dit blijft optreden. |
| geen grasrand gevonden op startpunt | De maaier kon vanaf zijn huidige positie geen grasrand vinden, ook niet na de automatische herprobeerpoging. Zet de maaier verder het gazon in, weg van tegels/oprit/laadstation, en probeer opnieuw. |
| Er staat al een kaart op deze maaier. Autonoom karteren werkt alleen op een maaier zonder kaart. | Je koos "Kaart maken" op een maaier die al een kaart heeft. Verwijder de bestaande kaart eerst via het kaartbeheer, of gebruik een testrit. |
| Gestopt via de stopknop | Je hebt de rit zelf gestopt met de stopknop in het paneel. |
| GPS-signaal weggevallen, rit gestopt | De GPS-ontvangst viel weg tijdens de rit; deze is uit voorzorg gestopt. |
| Geen GPS-fix gekregen bij de start | De maaier kreeg bij de start geen bruikbare GPS-fix. |
| Costmap instellen mislukte op de maaier | Het instellen van de costmap-parameter op de maaier is mislukt. |
| De maaier reageerde niet op de start van de opname | De maaier bevestigde het startcommando voor de kaartopname niet binnen de tijdslimiet. |
| Gestopt tijdens het opslaan van de kaart | De rit werd gestopt terwijl de kaart nog werd opgeslagen. |
| Sessie verloren door een serverherstart | De server is herstart terwijl deze sessie nog liep; de sessie is daardoor afgebroken. Start een nieuwe poging. |
| De maaier-daemon reageerde niet | De maaier-daemon voor autonoom karteren reageerde niet binnen de verwachte tijd. Controleer of de daemon op de maaier draait. |

Bij elke gestopte of mislukte rit blijft de maaier gewoon bruikbaar: er is
niets aan je bestaande kaart of instellingen gewijzigd totdat je zelf een
nieuw kaartvoorstel accepteert.
