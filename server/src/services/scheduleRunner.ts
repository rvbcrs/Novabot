/**
 * Schedule Runner — achtergrondproces dat maaischema's met rain_pause=1 beheert.
 *
 * Schema's met rain_pause worden NIET als timer_task naar de maaier gestuurd.
 * In plaats daarvan checkt deze runner periodiek of een starttijd net is bereikt,
 * controleert het weer via Open-Meteo, en stuurt start_run als het droog is.
 */

import { scheduleRepo, mapRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice } from '../mqtt/mapSync.js';
import { startMowing, edgeBladeHeightMm, getMowerPhase, startEdgeCut } from './mowingService.js';
import { getWeatherForecast, shouldPauseForRain } from './weatherService.js';
import { emitScheduleEvent, pushMqttLog } from '../dashboard/socketHandler.js';
import type { ScheduleRow } from '../db/repositories/schedules.js';

let intervalId: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL_MS = 30_000;
const TRIGGER_WINDOW_MS = 5 * 60_000; // 5 minuten window — ruim genoeg voor restarts

// Levensduur van een rand-dag watcher. Bewust ruim gehouden op 12 uur, óók na
// finding 4 uit de whole-branch review: de firmware pauzeert een lopende
// maaibeurt zelf voor een low-battery recharge, dockt, laadt tot ongeveer 96%
// en hervat daarna de gepauzeerde taak (coverContinueDeal, zie
// research/documents/firmware-auto-continue-after-recharge.md). Eén maaibeurt
// kan dus legitiem maaien → dokken → laden → hervatten → afronden beslaan en
// ruim langer duren dan een paar uur; het plan-oorspronkelijke 3 uur zou zo'n
// beurt de randmaai stil ontnemen. De veiligheid tegen "verkeerde beurt
// adopteren" hangt sinds finding 4 niet meer aan deze timeout maar aan de
// identiteitschecks: het maai-startvenster (EDGE_MOW_START_WINDOW_MS), de
// 'aborted'-ontwapening, de expliciete disarms (stopknop, schema uit/weg) en
// de hercontrole van het schema op het vuurmoment. De timeout is daarmee
// alleen nog de achtervang die een vergeten watcher ooit opruimt.
const EDGE_WATCH_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 uur

// Maai-startvenster: de gearmde beurt moet binnen dit venster na het armen ook
// echt als 'mowing' zijn waargenomen. De arm wordt gezet direct nadat
// start_navigation is geaccepteerd; de maaier ontdockt en rijdt binnen enkele
// minuten (fase 'mowing' dekt ook het aanrijden via Work:MOVING). Is er binnen
// het venster géén maaien gezien, dan is de gearmde beurt nooit begonnen en
// vervalt de arm — anders zou een handmatige beurt uren later de arm
// "adopteren" en een randmaai op de verkeerde zone/hoogte uitlokken (finding
// 4). Ruim genomen (30 min) voor trage RTK-init; loopt de init nog langer,
// dan valt dat in de veilige richting: een gemiste randmaai, geen verkeerde.
const EDGE_MOW_START_WINDOW_MS = 30 * 60 * 1000; // 30 minuten

const pendingEdge = new Map<string, EdgeWatchEntry>(); // sn → watcher

/** Ontwapen de rand-dag watcher voor een maaier. Aangeroepen bij elke
 *  handmatige start/stop via de server (dashboard stop-navigation, generieke
 *  command-route van de app): een handmatige actie betekent dat de gearmde
 *  geplande beurt niet meer de beurt is die er loopt. Stopt de gebruiker de
 *  maaier buiten de server om (fysieke knop, stock-app via MQTT), dan vangt de
 *  'aborted'-fase in advanceEdgeWatch dat op via de firmware-rapportage. */
export function disarmEdgeWatch(sn: string, reason: string): void {
  if (pendingEdge.delete(sn)) {
    console.log(`[ScheduleRunner] EDGE DISARMED sn=${sn}: ${reason}`);
  }
}

/** Ontwapen de watcher(s) die bij een specifiek schema horen. Aangeroepen
 *  wanneer dat schema wordt uitgezet of verwijderd. */
export function disarmEdgeWatchForSchedule(scheduleId: string, reason: string): void {
  for (const [sn, entry] of pendingEdge) {
    if (entry.scheduleId === scheduleId) {
      pendingEdge.delete(sn);
      console.log(`[ScheduleRunner] EDGE DISARMED sn=${sn} (schema ${scheduleId}): ${reason}`);
    }
  }
}

// Terugval-maaihoogte voor legacy rijen waar dashboard_schedules.cutting_height
// NULL is. Eenheid is user-cm, dezelfde als de app-editor schrijft; de
// dashboard-editor schrijft mm. cuttingHeightToWire (maaien) en
// edgeBladeHeightMm (randmaaien) herkennen allebei cm (<20) en mm (>=20) aan
// het bereik, dus dezelfde constante bedient beide. Eén gedeelde waarde is
// noodzakelijk: met een aparte fallback per pad maait zo'n legacy schema op
// 5 cm en randmaait het op 4 cm.
const DEFAULT_CUTTING_HEIGHT_CM = 5;

// Visible per-schedule decision log: writes to the console (→ proxy log file +
// stdout) AND the dashboard MQTT-log stream (pushMqttLog), so you can actually
// SEE whether a scheduled run started and, if not, exactly why (offline / rain /
// mower busy / start error). Deduped per (day, outcome) so the 30s retry ticks
// inside the 5-minute window log each distinct outcome ONCE, not every tick.
const lastLoggedDecision = new Map<string, string>();
function logScheduleDecision(row: ScheduleRow, ok: boolean, outcome: string, detail?: string): void {
  const dayKey = new Date().toISOString().slice(0, 10);
  const dedupeKey = `${dayKey}:${outcome}:${detail ?? ''}`;
  if (lastLoggedDecision.get(row.schedule_id) === dedupeKey) return;
  lastLoggedDecision.set(row.schedule_id, dedupeKey);
  const text = `${outcome}${detail ? ` — ${detail}` : ''}`;
  console.log(`[ScheduleRunner] ${row.schedule_id} (${row.mower_sn}) @${row.start_time}: ${text}`);
  pushMqttLog({
    ts: Date.now(),
    type: ok ? 'forward' : 'error',
    clientId: 'ScheduleRunner',
    clientType: '?',
    sn: row.mower_sn,
    direction: '',
    topic: `schedule/${row.start_time}`,
    payload: text,
    encrypted: false,
  });
}

/** Haal charger GPS coördinaten op voor een maaier SN */
function getChargerGps(mowerSn: string): { lat: number; lng: number } | null {
  return mapRepo.getChargerGps(mowerSn);
}

// Wall-clock componenten van `now` in de tijdzone van het schema.
// row.timezone komt van de browser/app die het schema aanmaakte; NULL of
// ongeldig (bv. "Canada/Toronto" — bestaat niet) valt terug op de
// server-lokale tijd (container TZ), het gedrag van vóór de kolom.
const warnedInvalidTz = new Set<string>();
function wallClock(now: Date, tz: string | null) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz ?? undefined,
      weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(now);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return {
      year: Number(get('year')), month: Number(get('month')), day: Number(get('day')),
      weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
      minutesIntoDay: Number(get('hour')) * 60 + Number(get('minute')),
      seconds: Number(get('second')),
    };
  } catch {
    if (tz && !warnedInvalidTz.has(tz)) {
      warnedInvalidTz.add(tz);
      console.warn(`[ScheduleRunner] Ongeldige timezone "${tz}" op schema — val terug op server-TZ (${process.env.TZ ?? 'UTC'})`);
    }
    return wallClock(now, null);
  }
}

/** Is vandaag (weekday 0=zondag) een rand-dag voor dit schema?
 *  edge_days NULL/corrupt/leeg → false (huidig gedrag: geen server-randmaai). */
export function isEdgeDay(edgeDaysJson: string | null, weekday: number): boolean {
  if (!edgeDaysJson) return false;
  try {
    const days = JSON.parse(edgeDaysJson);
    return Array.isArray(days) && days.includes(weekday);
  } catch { return false; }
}

export type EdgeWatchEntry = {
  /** Identiteit van de run: het schema dat deze watcher armde. Bij het vuren
   *  wordt gecontroleerd of dat schema nog bestaat en aan staat. */
  scheduleId: string;
  bladeHeightMm: number;
  mapName: string;
  /** Moment van armen = starttijd van de maaibeurt waarvoor gearmd is (de arm
   *  wordt direct na een geaccepteerde start_navigation gezet). */
  armedAt: number;
  sawMowing: boolean;
};

/** State machine per maaier voor de rand-dag. Arm bij trigger (sawMowing=false),
 *  markeer sawMowing zodra de maaier echt maait, en vuur (fire=true) zodra hij
 *  daarna gaat laden = maaibeurt klaar.
 *
 *  Identiteitsregels (finding 4, whole-branch review):
 *  - Startvenster: is er binnen mowStartWindowMs na het armen géén maaien
 *    gezien, dan is de gearmde beurt nooit begonnen en vervalt de arm — vóór
 *    er iets geadopteerd kan worden. Dit geldt in ELKE fase, dus ook wanneer
 *    de eerste 'mowing'-waarneming pas ná het venster komt: dat is dan per
 *    definitie een andere (handmatige) beurt.
 *  - 'aborted' ná gezien maaien ontwapent: de beurt waar de arm bij hoorde is
 *    definitief afgebroken (gebruikersstop, tijdslimiet, fout). Vóór gezien
 *    maaien wordt 'aborted' genegeerd: dat is dan een verouderde stopcode van
 *    een eerdere beurt die nog in de sensor-cache hangt; het startvenster
 *    ruimt zo'n arm vanzelf op als de beurt echt niet loopt.
 *  - Vervalt na timeoutMs zonder vuren (achtervang).
 *
 *  De 'other'-tak is bewust passief-wachtend: getMowerPhase geeft tijdens een
 *  mid-mow laadpauze 'other' terug (geen 'charging' en geen 'aborted'), dus
 *  zo'n tussenstop laat de watcher doorwachten tot het echte einde-taak-dock. */
export function advanceEdgeWatch(
  entry: EdgeWatchEntry,
  phase: 'mowing' | 'charging' | 'aborted' | 'other',
  nowMs: number,
  timeoutMs: number,
  mowStartWindowMs: number = EDGE_MOW_START_WINDOW_MS,
): { next: EdgeWatchEntry | null; fire: boolean } {
  if (nowMs - entry.armedAt > timeoutMs) return { next: null, fire: false };
  if (!entry.sawMowing && nowMs - entry.armedAt > mowStartWindowMs) return { next: null, fire: false };
  if (phase === 'aborted' && entry.sawMowing) return { next: null, fire: false };
  if (phase === 'mowing') return { next: { ...entry, sawMowing: true }, fire: false };
  if (phase === 'charging' && entry.sawMowing) return { next: null, fire: true };
  return { next: entry, fire: false };
}

/** ALLEEN VOOR TESTS: momentopname van de gearmde rand-dag watchers.
 *
 *  De bekabeling eromheen (armen bij een geslaagde start, niet armen bij een
 *  afwijzing, vervallen na de timeout) is de veiligheidskritieke helft van deze
 *  feature en is van buitenaf niet te zien: `pendingEdge` is module-state en
 *  `checkSchedules` is niet geëxporteerd. Zonder dit kijkgaatje kan een test
 *  alleen "er is geen randmaai gestuurd" vaststellen, wat óók waar is als de
 *  watcher wél verkeerd gearmd staat en pas een tick later vuurt. Bewust een
 *  kopie: een test kan de echte state hiermee niet muteren. */
export function __getPendingEdgeForTest(): Map<string, EdgeWatchEntry> {
  return new Map(pendingEdge);
}

/** Kalenderdag (YYYY-MM-DD) van `now` in de tijdzone van het schema. */
export function scheduleDayKey(row: ScheduleRow, now: Date): string {
  const wc = wallClock(now, row.timezone ?? null);
  return `${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')}`;
}

export function getScheduleOccurrence(row: ScheduleRow, now: Date): Date | null {
  const wc = wallClock(now, row.timezone ?? null);

  // Match today against either the interval-days rule (preferred when set)
  // or the legacy weekdays array.
  if (row.interval_days && row.interval_days > 0) {
    // Issue #51: "every N days" mode. Kalenderdag-verschil via UTC-proxies
    // zodat DST de telling niet ±1 dag verschuift.
    if (!row.interval_anchor_date) return null;
    const [anchorY, anchorM, anchorD] = row.interval_anchor_date.split('-').map(Number);
    if (!Number.isFinite(anchorY) || !Number.isFinite(anchorM) || !Number.isFinite(anchorD)) return null;
    const daysSince = Math.round(
      (Date.UTC(wc.year, wc.month - 1, wc.day) - Date.UTC(anchorY, anchorM - 1, anchorD)) / 86_400_000,
    );
    if (daysSince < 0 || daysSince % row.interval_days !== 0) return null;
  } else {
    const weekdays: number[] = JSON.parse(row.weekdays);
    if (!weekdays.includes(wc.weekday)) return null; // 0=Sunday
  }

  const [hourText = '0', minuteText = '0'] = row.start_time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  // Epoch van de occurrence van vandaag = now minus hoe ver de wandklok in
  // de schema-zone er al voorbij is.
  // ponytail: tijdens een DST-sprong die precies in het 5-min window valt is
  // dit de shift ernaast — twee keer per jaar om 02:00-03:00, negeren.
  const sinceMs = ((wc.minutesIntoDay - (hour * 60 + minute)) * 60 + wc.seconds) * 1000;
  return new Date(now.getTime() - sinceMs);
}

function checkSchedules() {
  const now = new Date();

  // Rand-dag watchers: vuur een losse randmaai zodra een gearmde maaier na het
  // maaien gaat laden (= maaibeurt klaar). Staat vóór de schema-lus zodat hij
  // ook loopt op ticks waarop geen enkel schema aan de beurt is. Puur via
  // advanceEdgeWatch; state in pendingEdge. Kopie van de entries zodat
  // delete/set tijdens de iteratie veilig is.
  for (const [sn, entry] of [...pendingEdge]) {
    const { next, fire } = advanceEdgeWatch(entry, getMowerPhase(sn), now.getTime(), EDGE_WATCH_TIMEOUT_MS);
    // State EERST bijwerken, het bewegingscommando als LAATSTE. Gooit de
    // publish-keten een fout, dan is de watcher al opgeruimd en kan dezelfde
    // entry op de volgende tick niet nog een keer vuren.
    if (next === null) pendingEdge.delete(sn);
    else pendingEdge.set(sn, next);
    if (fire) {
      // Hercontrole op het vuurmoment (finding 4): het schema dat deze watcher
      // armde moet nog bestaan en aan staan. Dit vangt ALLE verwijder- en
      // uitzetpaden af (dashboard, app, admin, directe DB-wijziging), niet
      // alleen de routes die disarmEdgeWatchForSchedule aanroepen.
      const sched = scheduleRepo.findById(entry.scheduleId);
      if (!sched || !sched.enabled) {
        console.log(`[ScheduleRunner] EDGE NIET GESTART sn=${sn}: schema ${entry.scheduleId} bestaat niet meer of staat uit`);
        continue;
      }
      // departFromDock: de watcher vuurt per definitie op fase 'charging'
      // (gedockt); zonder deze vlag blijft het chassis magnetisch aan het dock
      // vergrendeld en plant NTCP vanaf een bijna-lethal positie. De app en
      // het dashboard zetten deze vlag in exact dezelfde situatie ook.
      const r = startEdgeCut(sn, entry.mapName, entry.bladeHeightMm, true);
      console.log(`[ScheduleRunner] EDGE ${r.ok ? 'STARTED' : 'FAILED'} sn=${sn} map=${entry.mapName} blade=${entry.bladeHeightMm}mm ${r.error ?? ''}`);
    }
  }

  // Haal ALLE enabled schedules op — de runner handelt alles af
  const rows = scheduleRepo.findEnabled();
  if (rows.length > 0) {
    const day = now.getDay();
    const time = `${now.getHours()}:${String(now.getMinutes()).padStart(2,'0')}`;
    console.log(`[ScheduleRunner] Checking ${rows.length} schedule(s) at ${time} (day=${day})`);
  }

  for (const row of rows) {
    const scheduledAt = getScheduleOccurrence(row, now);
    if (!scheduledAt) {
      // Niet vandaag
      continue;
    }
    const sinceScheduledMs = now.getTime() - scheduledAt.getTime();
    if (sinceScheduledMs < 0 || sinceScheduledMs > TRIGGER_WINDOW_MS) {
      // Buiten trigger window
      continue;
    }

    // Voorkom dubbele trigger voor dezelfde geplande run.
    // SQLite datetime('now') produces 'YYYY-MM-DD HH:MM:SS' in UTC without
    // a timezone marker. JS new Date() parses that as LOCAL time, which made
    // lastTriggered always lag scheduledAt by the local offset (e.g. 2h in
    // CEST) — guard never matched, schedule retriggered every 30s.
    // Issue #13: dir26738 hit this and got Error 2 "Already in running task"
    // spam from the mower for 5 minutes per scheduled run.
    if (row.last_triggered_at) {
      const lastTriggered = new Date(row.last_triggered_at.replace(' ', 'T') + 'Z');
      if (!Number.isNaN(lastTriggered.getTime()) && lastTriggered.getTime() >= scheduledAt.getTime()) {
        continue;
      }
    }

    // Gebruiker drukte op "sla deze dag over" (app/dashboard). Datum-gericht
    // en zelf-wissend: alleen de occurrence op skip_date wordt overgeslagen,
    // en last_triggered_at wordt gestempeld zodat het 5-min window niet
    // alsnog hertriggert. Een verlopen skip_date wordt opgeruimd.
    if (row.skip_date) {
      const todayKey = scheduleDayKey(row, now);
      if (row.skip_date === todayKey) {
        scheduleRepo.update(row.schedule_id, { skip_date: null });
        scheduleRepo.updateLastTriggered(row.schedule_id);
        logScheduleDecision(row, false, 'SKIPPED', `user skipped ${todayKey}`);
        continue;
      }
      if (row.skip_date < todayKey) {
        scheduleRepo.update(row.schedule_id, { skip_date: null });
      }
    }

    // Check of maaier online is
    if (!isDeviceOnline(row.mower_sn)) {
      logScheduleDecision(row, false, 'SKIPPED', 'mower offline');
      continue;
    }

    // Rain pause: check weer als ingeschakeld, anders direct starten
    if (row.rain_pause) {
      const gps = getChargerGps(row.mower_sn);
      if (!gps) {
        console.log(`[ScheduleRunner] ${row.schedule_id}: geen GPS coördinaten, start zonder weercheck`);
        triggerSchedule(row);
        continue;
      }
      checkWeatherAndTrigger(row, gps).catch(err => {
        console.error(`[ScheduleRunner] Weather check failed for ${row.schedule_id}:`, err);
        triggerSchedule(row);
      });
    } else {
      triggerSchedule(row);
    }
  }
}

async function checkWeatherAndTrigger(
  row: ScheduleRow,
  gps: { lat: number; lng: number },
) {
  const forecast = await getWeatherForecast(gps.lat, gps.lng);
  const shouldPause = shouldPauseForRain(
    forecast,
    row.rain_threshold_mm,
    row.rain_threshold_probability,
    row.rain_check_hours,
  );

  if (shouldPause) {
    logScheduleDecision(row, false, 'SKIPPED', 'rain expected (pre-start weather check)');
    emitScheduleEvent('weather:paused', {
      scheduleId: row.schedule_id,
      mowerSn: row.mower_sn,
      reason: 'rain',
    });
    // Update last_triggered_at zodat we niet elke seconde opnieuw checken
    scheduleRepo.updateLastTriggered(row.schedule_id);
    return;
  }

  console.log(`[ScheduleRunner] ${row.schedule_id}: weer OK, start maaier`);
  triggerSchedule(row);
}

/**
 * Resolve a schedule's stored map selection to the firmware `area` value.
 *
 * `area` is a decimal positional bitmask (slot N → 10^N: map0=1, map1=10,
 * map2=100; summed for multi-map). The firmware mows every selected map in one
 * task, no dock between zones — see research/documents/multi-map-area-bitmask-decode.md.
 *
 * - `selectedMapId` set  → that one map's slot (10^slot).
 * - `selectedMapId` null → "All work areas" (the ScheduleSheet default) → the
 *   summed bitmask of EVERY work map, so a scheduled run mows the whole garden.
 *
 * Falls back to map0 (`1`) when the selection can't be resolved to a canonical
 * slot, matching the previous always-map0 behaviour rather than mowing nothing.
 * Pure (no DB) so it's unit-testable; the caller supplies the work-map list.
 */
export function computeScheduleArea(
  workMaps: Array<{ map_id: string; canonical_name: string | null }>,
  selectedMapId: string | null,
): number {
  const slotOf = (m: { canonical_name: string | null }): number | null => {
    const match = m.canonical_name?.match(/^map(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  };
  if (selectedMapId) {
    const m = workMaps.find(w => w.map_id === selectedMapId);
    const slot = m ? slotOf(m) : null;
    return slot != null ? Math.pow(10, slot) : 1;
  }
  // "All work areas": bitmask of every work map (map0+map1+map2 → 111).
  const area = workMaps.reduce((sum, m) => {
    const slot = slotOf(m);
    return slot != null ? sum + Math.pow(10, slot) : sum;
  }, 0);
  return area > 0 ? area : 1;
}

function triggerSchedule(row: ScheduleRow) {
  // Bereken effectieve richting (met alternerende rotatie).
  // Rotatie draait op trigger_count, NIET op work_records: de maaier stuurt
  // geen scheduleId mee in saveCutGrassRecord bij runner-gestarte mows, dus
  // die count bleef altijd 0 en de richting roteerde nooit.
  let effectiveDirection = row.path_direction;
  if (row.alternate_direction === 1) {
    const count = row.trigger_count ?? 0;
    // Modulo 180: een maairichting is een lijn-oriëntatie (240° == 60°).
    // Met stap 90 alterneert een 60°-schema dus netjes tussen 60 en 150.
    effectiveDirection = (row.path_direction + count * (row.alternate_step ?? 90)) % 180;
  }

  // Honour the schedule's map selection (was hardcoded area:1 → always mowed
  // map0 regardless of the chosen map). null map_id = "All work areas".
  const workMaps = mapRepo.findByMowerSnAndType(row.mower_sn, 'work');
  const area = computeScheduleArea(workMaps, row.map_id);

  // Start maaien via centrale mowingService
  const result = startMowing({
    sn: row.mower_sn,
    cuttingHeight: row.cutting_height ?? DEFAULT_CUTTING_HEIGHT_CM,
    pathDirection: effectiveDirection,
    area,
  });
  if (result.ok) {
    // Alleen bij een geslaagde start doorschuiven — een regen-skip of busy-
    // afwijzing mag de volgende richting niet opschuiven.
    scheduleRepo.incrementTriggerCount(row.schedule_id);
    logScheduleDecision(row, true, 'STARTED', `area=${area} height=${row.cutting_height ?? DEFAULT_CUTTING_HEIGHT_CM}cm dir=${effectiveDirection}°`);

    // Elke geslaagde geplande start VERVANGT de watcher-state voor deze
    // maaier: een eventueel nog hangende arm van een eerdere (bv. ambigu
    // afgebroken) beurt hoort bij die eerdere beurt en mag deze nieuwe beurt
    // niet adopteren (finding 4).
    disarmEdgeWatch(row.mower_sn, `nieuwe geplande beurt (${row.schedule_id}) vervangt oude arm`);

    // Rand-dag? Arm de watcher zodat na de maaibeurt een losse randmaai volgt.
    // Alleen bij een geslaagde start: een regen-skip of busy-afwijzing mag nooit
    // iets armen. Weekdag uit de tijdzone van het schema, net als de weekdays-
    // match in getScheduleOccurrence, anders zou een schema in een andere zone
    // rond middernacht op de verkeerde dag als rand-dag tellen.
    const weekday = wallClock(new Date(), row.timezone ?? null).weekday; // 0=zondag
    if (isEdgeDay(row.edge_days, weekday)) {
      const selected = row.map_id ? workMaps.find(w => w.map_id === row.map_id) : undefined;
      // Bekende beperking: bij "Alle werkgebieden" (map_id NULL) of een map
      // zonder canonieke mapN-naam valt de randmaai terug op map0. Een
      // meerzone-schema maait dus wel alle zones, maar randmaait alleen map0;
      // start_edge_cut accepteert maar een mapName per aanroep.
      const mapName = selected?.canonical_name?.match(/^map\d+/)?.[0] ?? 'map0';
      pendingEdge.set(row.mower_sn, {
        scheduleId: row.schedule_id,
        bladeHeightMm: edgeBladeHeightMm(row.cutting_height ?? DEFAULT_CUTTING_HEIGHT_CM),
        mapName,
        armedAt: Date.now(),
        sawMowing: false,
      });
      logScheduleDecision(row, true, 'EDGE ARMED', `na maaibeurt randmaai op ${mapName} (dag ${weekday})`);
    }
  } else {
    // Most common cause: startMowing's isMowerBusy guard rejected the start
    // because the mower is in an active task (or was wrongly parked as "busy").
    logScheduleDecision(row, false, 'NOT STARTED', `${result.error} (area=${area} height=${row.cutting_height ?? DEFAULT_CUTTING_HEIGHT_CM}cm)`);
  }

  // Update last_triggered_at
  scheduleRepo.updateLastTriggered(row.schedule_id);

  emitScheduleEvent('weather:started', {
    scheduleId: row.schedule_id,
    mowerSn: row.mower_sn,
    effectiveDirection,
  });
}

export function startScheduleRunner(): void {
  if (intervalId) return;
  // Maak de effectieve tijdzone zichtbaar: schema's zonder eigen timezone
  // vuren in DEZE zone. Een ongeldige TZ env valt stil terug op UTC — dat
  // zie je hier dan meteen aan de lokale tijd.
  console.log(
    `[ScheduleRunner] Server-TZ: ${process.env.TZ ?? '(niet gezet — UTC)'} — lokale tijd nu: ${new Date().toLocaleString('en-CA', { hour12: false })}. ` +
    `Schema's met eigen timezone (browser/app) vuren in hun eigen zone.`,
  );
  checkSchedules();
  intervalId = setInterval(checkSchedules, CHECK_INTERVAL_MS);
  console.log(`[ScheduleRunner] Started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

export function stopScheduleRunner(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[ScheduleRunner] Stopped');
  }
}
