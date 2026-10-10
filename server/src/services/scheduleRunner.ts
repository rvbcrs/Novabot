/**
 * Schedule Runner — achtergrondproces dat maaischema's met rain_pause=1 beheert.
 *
 * Schema's met rain_pause worden NIET als timer_task naar de maaier gestuurd.
 * In plaats daarvan checkt deze runner periodiek of een starttijd net is bereikt,
 * controleert het weer via Open-Meteo, en stuurt start_run als het droog is.
 */

import { scheduleRepo, mapRepo, rainSettingsRepo, deviceSettingsRepo } from '../db/repositories/index.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { publishToDevice } from '../mqtt/mapSync.js';
import { deviceCache } from '../mqtt/sensorData.js';
import {
  startMowing, edgeBladeHeightMm, getMowerPhase, startEdgeCut, EDGE_ALWAYS_KEY, edgeAlways,
} from './mowingService.js';
import { getWeatherForecast, shouldPauseForRain, isNight, isFrostExpected } from './weatherService.js';
import { emitScheduleEvent, pushMqttLog } from '../dashboard/socketHandler.js';
import type { ScheduleRow } from '../db/repositories/schedules.js';
import { M, renderMsg, type Lang, type Msg } from './serverText.js';
import { serverTimeZone } from '../utils/serverTimeZone.js';

let intervalId: ReturnType<typeof setInterval> | null = null;
let edgeIntervalId: ReturnType<typeof setInterval> | null = null;
const CHECK_INTERVAL_MS = 30_000;
// The edge watchers look more often than the schedules: the drive home after a
// mow has to be caught before the mower is halfway to the dock.
const EDGE_TICK_MS = 3_000;
// ponytail: fixed floor, a setting if people want it. The edge cut runs outside
// robot_decision and its low-battery return, so it only starts with this much;
// on the dock the watcher waits until the mower has charged to it.
const EDGE_MIN_BATTERY = 30;
// The firmware finished the mow and starts its own drive home (init phases,
// then RETURN_TO_PILE). ALIGN_PILE and later are left alone: it is docking.
const RETURNING_AFTER_MOW = /Mode:COVERAGE Work:FINISHED Prev work:FINISHED_ONCE Recharge: (REQUEST_START|SYSTEM_CHECK_INIT|LOCALIZATION_UTM_INIT|LOCALIZATION_INIT|SENSOR_INIT|MAP_INIT|INIT_SUCCESS|RETURN_TO_PILE)\b/;
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

// "Altijd randmaaien" (device_settings edge_always): dezelfde watcher, maar
// gearmd door elke coverage-taak, wie hem ook startte (app, dashboard, schema,
// stock-app, de maaier zelf). sn → zat de maaier op de vorige tick in een
// coverage-taak.
const wasCovering = new Map<string, boolean>();

/** Eerste zone uit current_map_ids, een decimaal positioneel bitmasker
 *  (map0 = "1", map3 = "1000"). start_edge_cut neemt één mapName, dus bij een
 *  meerzone-beurt alleen de eerste zone; zelfde beperking als de rand-dag. */
export function firstMapName(mapIds: string | undefined): string {
  const i = [...(mapIds ?? '')].reverse().indexOf('1');
  return i >= 0 ? `map${i}` : 'map0';
}

function armAlwaysEdge(nowMs: number): void {
  for (const { sn } of deviceSettingsRepo.listAll().filter(r => r.key === EDGE_ALWAYS_KEY && r.value === '1')) {
    const cache = deviceCache.get(sn);
    // Alleen een echte coverage-taak: Work:COVERING, niet MOVING/RUNNING. Een rit
    // naar het dock (ook na de randmaai) kan als Mode:COVERAGE Work:MOVING
    // rapporteren en zou dan een nieuwe randmaai armen. Ook niet de randmaai
    // zelf (edge_active, gaat buiten robot_decision om) en niet mapping.
    const covering = /Mode:COVERAGE Work:COVERING\b/.test(cache?.get('msg') ?? '')
      && cache?.get('edge_active') !== '1';
    const started = covering && !wasCovering.get(sn);
    wasCovering.set(sn, covering);
    // Alleen op de overgang naar maaien: een stop of "naar huis" via de server
    // ontwapent de watcher terwijl de maaier nog even als maaiend rapporteert,
    // en die beurt mag dan niet opnieuw gearmd worden.
    if (!started || pendingEdge.has(sn)) continue;
    const wire = parseInt(cache?.get('target_height') ?? '', 10); // cutterhigh, cm − 2
    const entry: EdgeWatchEntry = {
      scheduleId: null,
      bladeHeightMm: edgeBladeHeightMm(Number.isFinite(wire) ? wire + 2 : DEFAULT_CUTTING_HEIGHT_CM),
      mapName: firstMapName(cache?.get('current_map_ids')),
      armedAt: nowMs,
      sawMowing: true,
    };
    pendingEdge.set(sn, entry);
    console.log(`[ScheduleRunner] EDGE ARMED (altijd) sn=${sn} map=${entry.mapName} blade=${entry.bladeHeightMm}mm`);
  }
}

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
const RESULT_FOR_OUTCOME: Record<string, string> = {
  'STARTED': 'started', 'SKIPPED': 'skipped', 'NOT STARTED': 'failed', 'MISSED': 'missed',
};
function isMsg(v: unknown): v is Msg {
  return !!v && typeof v === 'object' && typeof (v as Msg).key === 'string' && Array.isArray((v as Msg).values);
}

/** A stored message whose values may themselves be messages (a refusal
 *  from mowingService inside "… (area=… height=…)"). */
function renderNested(lang: Lang, msg: Msg): string {
  return renderMsg(lang, { key: msg.key, values: msg.values.map(v => (isMsg(v) ? renderNested(lang, v) : v)) });
}

/**
 * last_result_reason in the reader's language. A human reason is stored as a
 * Msg in JSON (the runner has no reader); older rows and the technical
 * STARTED detail are plain text and come back unchanged.
 */
export function renderScheduleReason(lang: Lang, stored: string | null | undefined): string | null {
  if (!stored) return stored ?? null;
  if (!stored.startsWith('{')) return stored;
  try {
    const parsed: unknown = JSON.parse(stored);
    return isMsg(parsed) ? renderNested(lang, parsed) : stored;
  } catch {
    return stored;
  }
}

/**
 * A started run stores only technical detail (plain text), which the clients
 * do not show. A human reason (a Msg) on a started run is a warning the user
 * should see: it started without the weather check because that could not run.
 */
export function isScheduleWarning(result: string | null | undefined, stored: string | null | undefined): boolean {
  if (result !== 'started' || !stored?.startsWith('{')) return false;
  try {
    return isMsg(JSON.parse(stored));
  } catch {
    return false;
  }
}

function logScheduleDecision(row: ScheduleRow, ok: boolean, outcome: string, reason?: string | Msg): void {
  const detail = reason === undefined ? undefined : isMsg(reason) ? renderNested('en', reason) : reason;
  const stored = reason === undefined ? null : isMsg(reason) ? JSON.stringify(reason) : reason;
  const dayKey = new Date().toISOString().slice(0, 10);
  const dedupeKey = `${dayKey}:${outcome}:${detail ?? ''}`;
  if (lastLoggedDecision.get(row.schedule_id) === dedupeKey) return;
  lastLoggedDecision.set(row.schedule_id, dedupeKey);
  const text = `${outcome}${detail ? ` — ${detail}` : ''}`;
  // Op het schema zelf, zodat dashboard en app kunnen tonen waarom een
  // beurt niet liep. EDGE ARMED is een vervolg op een start, geen beslissing.
  const result = RESULT_FOR_OUTCOME[outcome];
  if (result) {
    scheduleRepo.update(row.schedule_id, {
      last_result_at: new Date().toISOString(), last_result: result, last_result_reason: stored,
    });
  }
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
/** De Novabot-app stuurt "GMT+2:00" i.p.v. een IANA-naam. Hele uren zijn als
 *  Etc/GMT-2 uit te drukken (teken omgekeerd, POSIX); halve uren niet. */
export function normalizeTimezone(tz: string | null): string | null {
  if (!tz) return null;
  const m = tz.match(/^(?:GMT|UTC)\s*([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!m) return tz;
  if (m[3] && m[3] !== '00') return tz;
  const hours = Number(m[2]);
  if (hours === 0) return 'Etc/GMT';
  return `Etc/GMT${m[1] === '+' ? '-' : '+'}${hours}`;
}
function wallClock(now: Date, tz: string | null) {
  tz = normalizeTimezone(tz);
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
   *  wordt gecontroleerd of dat schema nog bestaat en aan staat. null = gearmd
   *  door de instelling "altijd randmaaien"; dan moet die nog aan staan. */
  scheduleId: string | null;
  bladeHeightMm: number;
  mapName: string;
  /** Moment van armen = starttijd van de maaibeurt waarvoor gearmd is (de arm
   *  wordt direct na een geaccepteerde start_navigation gezet). */
  armedAt: number;
  sawMowing: boolean;
  /** stop_to_charge sent to break off the drive home after the mow. */
  cancelSentAt?: number;
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

/** Is the edge cut this watcher was armed for still wanted? The schedule that
 *  armed it must still exist and be on (finding 4: this catches every delete or
 *  disable path, not only the routes that call disarmEdgeWatchForSchedule), or
 *  "edge cut after every mow" must still be on. Returns why not, or null. */
function edgeNotWanted(sn: string, entry: EdgeWatchEntry): string | null {
  if (entry.scheduleId === null) return edgeAlways(sn) ? null : '"altijd randmaaien" staat inmiddels uit';
  return scheduleRepo.findById(entry.scheduleId)?.enabled ? null : `schema ${entry.scheduleId} bestaat niet meer of staat uit`;
}

function checkEdgeWatchers(): void {
  const now = Date.now();
  armAlwaysEdge(now);
  // Kopie van de entries zodat delete/set tijdens de iteratie veilig is. State
  // steeds EERST bijwerken, het bewegingscommando als LAATSTE: gooit de
  // publish-keten een fout, dan kan dezelfde entry niet nog eens vuren.
  for (const [sn, entry] of [...pendingEdge]) {
    const cache = deviceCache.get(sn);
    const msg = cache?.get('msg') ?? '';
    const battery = parseInt(cache?.get('battery_power') ?? cache?.get('battery_capacity') ?? '', 10);
    const batteryOk = !Number.isFinite(battery) || battery >= EDGE_MIN_BATTERY;
    // mow_zone_drive breaks off the firmware's drive home itself when it takes
    // the wheels; while it is busy the server stays out. "done" = coverage was
    // handed to the firmware.
    const zoneDriveBusy = !['', 'done', 'error'].includes(cache?.get('mow_zone_phase') ?? '');

    // Direct: the mow just finished and the firmware starts its drive home.
    // Break that off (stop_to_charge, the stop button of the app and the
    // dashboard) and cut the edge from where the mower is. If the firmware
    // does not let go it docks, and the dock path below takes over.
    if (entry.sawMowing && !entry.cancelSentAt && batteryOk && !zoneDriveBusy
        && RETURNING_AFTER_MOW.test(msg) && !edgeNotWanted(sn, entry)) {
      pendingEdge.set(sn, { ...entry, cancelSentAt: now });
      publishToDevice(sn, { stop_to_charge: {} });
      console.log(`[ScheduleRunner] EDGE: maaibeurt klaar, terugrit afbreken voor randmaai sn=${sn}`);
      continue;
    }
    if (entry.cancelSentAt && /Work:FINISHED\b/.test(msg) && /Recharge: (CANCELLED|WAIT)\b/.test(msg)) {
      pendingEdge.delete(sn);
      const why = edgeNotWanted(sn, entry);
      if (why) { console.log(`[ScheduleRunner] EDGE NIET GESTART sn=${sn}: ${why}`); continue; }
      const r = startEdgeCut(sn, entry.mapName, entry.bladeHeightMm, false);
      console.log(`[ScheduleRunner] EDGE ${r.ok ? 'STARTED' : 'FAILED'} (direct na maaien) sn=${sn} map=${entry.mapName} blade=${entry.bladeHeightMm}mm ${r.error ?? ''}`);
      continue;
    }

    // Dock: the mower docked after the mow (the drive home was not broken off).
    const { next, fire } = advanceEdgeWatch(entry, getMowerPhase(sn), now, EDGE_WATCH_TIMEOUT_MS);
    if (fire && !batteryOk) { pendingEdge.set(sn, entry); continue; } // charge first
    if (next === null) pendingEdge.delete(sn);
    else pendingEdge.set(sn, next);
    if (fire) {
      const why = edgeNotWanted(sn, entry);
      if (why) { console.log(`[ScheduleRunner] EDGE NIET GESTART sn=${sn}: ${why}`); continue; }
      // departFromDock: de watcher vuurt hier op fase 'charging' (gedockt);
      // zonder deze vlag blijft het chassis magnetisch aan het dock vergrendeld
      // en plant NTCP vanaf een bijna-lethal positie.
      const r = startEdgeCut(sn, entry.mapName, entry.bladeHeightMm, true);
      console.log(`[ScheduleRunner] EDGE ${r.ok ? 'STARTED' : 'FAILED'} sn=${sn} map=${entry.mapName} blade=${entry.bladeHeightMm}mm ${r.error ?? ''}`);
    }
  }
}

function checkSchedules() {
  const now = new Date();

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
      // Buiten trigger window. Is het venster voorbij zonder dat er ooit een
      // beslissing over deze occurrence viel, dan draaide de server niet op
      // dat moment (herstart, update, uit). Eén keer vastleggen als 'missed',
      // zodat het niet lijkt alsof er niets gebeurd is.
      if (sinceScheduledMs > TRIGGER_WINDOW_MS) {
        const lastResultAt = row.last_result_at ? Date.parse(row.last_result_at) : NaN;
        const lastTriggered = row.last_triggered_at ? Date.parse(row.last_triggered_at.replace(' ', 'T') + 'Z') : NaN;
        const createdAt = row.created_at ? Date.parse(row.created_at.replace(' ', 'T') + 'Z') : NaN;
        const decided = (Number.isFinite(lastResultAt) && lastResultAt >= scheduledAt.getTime())
          || (Number.isFinite(lastTriggered) && lastTriggered >= scheduledAt.getTime());
        const existedThen = !Number.isFinite(createdAt) || createdAt <= scheduledAt.getTime();
        if (!decided && existedThen) {
          logScheduleDecision(row, false, 'MISSED', M`de server draaide niet om ${row.start_time}`);
        }
      }
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
        logScheduleDecision(row, false, 'SKIPPED', M`overgeslagen door de gebruiker (${todayKey})`);
        continue;
      }
      if (row.skip_date < todayKey) {
        scheduleRepo.update(row.schedule_id, { skip_date: null });
      }
    }

    // Check of maaier online is
    if (!isDeviceOnline(row.mower_sn)) {
      logScheduleDecision(row, false, 'SKIPPED', M`maaier offline`);
      continue;
    }

    // Weercheck als regen (per schema), nacht of vorst (per maaier) aan staat;
    // anders direct starten.
    //
    // Kan de check niet (geen GPS-positie van het laadstation, of het
    // weerbericht faalt), dan start de beurt toch, zoals sinds de eerste
    // versie. Maar niet stil: de reden komt op het schema, in de MQTT-log en
    // als event, anders lijkt de nachtbewaking gewoon kapot.
    const guards = rainSettingsRepo.getEffective(row.mower_sn);
    if (row.rain_pause || guards.nightGuard || guards.frostGuard) {
      const gps = getChargerGps(row.mower_sn);
      if (!gps) {
        triggerWithoutWeatherCheck(row, 'no_gps', M`zonder nacht-, vorst- of regencheck: geen GPS-positie van het laadstation`);
        continue;
      }
      checkWeatherAndTrigger(row, gps, guards).catch(err => {
        console.error(`[ScheduleRunner] Weather check failed for ${row.schedule_id}:`, err);
        const why = err instanceof Error ? err.message : String(err);
        triggerWithoutWeatherCheck(row, 'forecast_failed', M`zonder nacht-, vorst- of regencheck: weerbericht niet opgehaald (${why})`);
      });
    } else {
      triggerSchedule(row);
    }
  }
}

async function checkWeatherAndTrigger(
  row: ScheduleRow,
  gps: { lat: number; lng: number },
  guards: { nightGuard: boolean; frostGuard: boolean; frostThresholdC: number },
) {
  const forecast = await getWeatherForecast(gps.lat, gps.lng);
  const now = Date.now();

  let skip: { reason: 'night' | 'frost' | 'rain'; detail: Msg } | null = null;
  if (guards.nightGuard && isNight(forecast, now)) {
    skip = { reason: 'night', detail: M`nachtbewaking: tussen zonsondergang en zonsopgang` };
  } else if (guards.frostGuard && isFrostExpected(forecast, guards.frostThresholdC, now)) {
    skip = { reason: 'frost', detail: M`vorstbewaking: onder ${guards.frostThresholdC}°C` };
  } else if (row.rain_pause && shouldPauseForRain(
    forecast, row.rain_threshold_mm, row.rain_threshold_probability, row.rain_check_hours,
  )) {
    skip = { reason: 'rain', detail: M`regen verwacht (weercheck voor de start)` };
  }

  if (skip) {
    logScheduleDecision(row, false, 'SKIPPED', skip.detail);
    emitScheduleEvent('weather:paused', {
      scheduleId: row.schedule_id,
      mowerSn: row.mower_sn,
      reason: skip.reason,
    });
    // Update last_triggered_at zodat we niet elke seconde opnieuw checken
    scheduleRepo.updateLastTriggered(row.schedule_id);
    return;
  }

  console.log(`[ScheduleRunner] ${row.schedule_id}: weer OK, start maaier`);
  triggerSchedule(row);
}

/** Start zonder weercheck omdat die niet kon; `why` gaat als reden mee. */
function triggerWithoutWeatherCheck(row: ScheduleRow, reason: 'no_gps' | 'forecast_failed', why: Msg) {
  emitScheduleEvent('weather:unchecked', {
    scheduleId: row.schedule_id,
    mowerSn: row.mower_sn,
    reason,
  });
  triggerSchedule(row, why);
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

/**
 * `warning`: iets wat de gebruiker over een geslaagde start moet weten (de
 * weercheck kon niet). Dat wordt dan de reden op het schema in plaats van de
 * technische details, die alleen naar de console gaan.
 */
function triggerSchedule(row: ScheduleRow, warning?: Msg) {
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
    const startDetail = `area=${area} height=${row.cutting_height ?? DEFAULT_CUTTING_HEIGHT_CM}cm dir=${effectiveDirection}°`;
    if (warning) console.log(`[ScheduleRunner] ${row.schedule_id}: ${startDetail}`);
    // Met waarschuwing als 'error' in de MQTT-log, zodat hij opvalt.
    logScheduleDecision(row, !warning, 'STARTED', warning ?? startDetail);

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
    logScheduleDecision(row, false, 'NOT STARTED',
      M`${result.errorMsg ?? result.error} (gebied=${area} hoogte=${row.cutting_height ?? DEFAULT_CUTTING_HEIGHT_CM} cm)`);
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
  // zie je hier dan meteen aan de lokale tijd; serverTimeZone() waarschuwt bij boot.
  serverTimeZone();
  console.log(
    `[ScheduleRunner] Server-TZ: ${process.env.TZ ?? '(niet gezet — UTC)'} — lokale tijd nu: ${new Date().toLocaleString('en-CA', { hour12: false })}. ` +
    `Schema's met eigen timezone (browser/app) vuren in hun eigen zone.`,
  );
  checkEdgeWatchers();
  checkSchedules();
  intervalId = setInterval(checkSchedules, CHECK_INTERVAL_MS);
  edgeIntervalId = setInterval(checkEdgeWatchers, EDGE_TICK_MS);
  console.log(`[ScheduleRunner] Started, checking every ${CHECK_INTERVAL_MS / 1000}s`);
}

export function stopScheduleRunner(): void {
  if (edgeIntervalId) { clearInterval(edgeIntervalId); edgeIntervalId = null; }
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[ScheduleRunner] Stopped');
  }
}
