/**
 * Demo/Simulatie Modus — simuleert maaier-gedrag server-side.
 *
 * Wanneer demo mode actief is voor een SN, worden commando's (start_run, pause, etc.)
 * NIET naar de echte maaier gestuurd maar verwerkt door de simulator.
 * De simulator genereert nep-sensordata die door de normale pipeline stroomt:
 *   updateDeviceData() → forwardToDashboard() → Socket.io → dashboard UI
 *
 * Hierdoor werkt het volledige frontend ongewijzigd: kaart, GPS trail, progress, battery.
 */
import { db } from '../db/database.js';
import { updateDeviceData, getDeviceSnapshot, clearGpsTrail } from '../mqtt/sensorData.js';
import { forwardToDashboard, emitDeviceOnline, emitDeviceOffline, emitTrailClear, emitCoveredLanes, setDemoModeChecker } from '../dashboard/socketHandler.js';
import { isDeviceOnline } from '../mqtt/broker.js';
import { setDemoInterceptor } from '../mqtt/mapSync.js';
import { localToGps, type GpsPoint, type LocalPoint } from '../mqtt/mapConverter.js';

const TAG = '[DEMO]';

// Registreer isDemoMode checker bij socketHandler (voor Socket.io snapshot)
setDemoModeChecker((sn: string) => isDemoMode(sn));

// Registreer MQTT boundary interceptor — onderschept commando's op het punt van MQTT publish
setDemoInterceptor((sn: string, command: Record<string, unknown>): boolean => {
  if (!isDemoMode(sn)) return false;
  return handleDemoCommand(sn, command);
});

// ── Types ─────────────────────────────────────────────────────────

type DemoState = 'idle' | 'mowing' | 'returning' | 'charging' | 'paused';

interface DemoSession {
  sn: string;
  enabled: boolean;
  state: DemoState;
  timer: ReturnType<typeof setInterval> | null;

  // Polygon & charger
  polygon: GpsPoint[];       // GPS vertices van het werkgebied
  chargerGps: GpsPoint;      // GPS positie charger

  // Pre-computed mow path (boustrophedon stripe pattern, GPS coords)
  mowPath: GpsPoint[];
  pathIndex: number;
  skipIndices: Set<number>;  // pathIndex waarden waarna instant geteleporteerd wordt (concave gaps)

  // Preview path cache — hergebruikt bij start_run als richting matcht
  lastPreviewPath: GpsPoint[];
  lastPreviewDirection: number;

  // Mowing parameters
  pathDirection: number;     // graden, uit start_run command
  laneWidth: number;         // meters (standaard 0.28 = Novabot maaibreedte)
  tickIntervalMs: number;    // hoe vaak updates (2000ms)
  stepSizeM: number;         // meters per tick (0.4 m/s * 2s = 0.8m)

  // Dynamic state
  battery: number;           // 0-100
  mowingProgress: number;    // 0-100
  heading: number;           // graden
  currentLat: number;
  currentLng: number;
  coveredArea: number;       // m²
  totalArea: number;         // m² van polygon
  bladeWorkTime: number;     // seconden
  tickCount: number;         // voor verspreide reports
  segmentDist: number;       // afstand afgelegd binnen huidig segment
  totalPathDist: number;     // totale pad-lengte (eenmalig berekend)
  distTraveled: number;      // totale afstand afgelegd
}

// ── Session storage ───────────────────────────────────────────────

const demoSessions = new Map<string, DemoSession>();

// Demo mode standaard aan voor de maaier
const DEFAULT_DEMO_SN = 'LFIN2230700238';
setTimeout(() => setDemoMode(DEFAULT_DEMO_SN, true), 1000);

// ── Public API ────────────────────────────────────────────────────

export function setDemoMode(sn: string, enabled: boolean): void {
  if (enabled) {
    if (!demoSessions.has(sn)) {
      demoSessions.set(sn, createSession(sn));
    }
    demoSessions.get(sn)!.enabled = true;
    console.log(`${TAG} Demo mode ENABLED for ${sn}`);
  } else {
    const session = demoSessions.get(sn);
    if (session) {
      stopSimulation(session);
      demoSessions.delete(sn);
    }
    // Herstel juiste online status: als echte maaier offline is, emit offline event
    if (!isDeviceOnline(sn)) {
      emitDeviceOffline(sn);
    }
    console.log(`${TAG} Demo mode DISABLED for ${sn}`);
  }
}

export function isDemoMode(sn: string): boolean {
  return demoSessions.get(sn)?.enabled === true;
}

export function getDemoStatus(sn: string): { demoMode: boolean; state: string; progress: number } {
  const session = demoSessions.get(sn);
  if (!session?.enabled) return { demoMode: false, state: 'idle', progress: 0 };
  return { demoMode: true, state: session.state, progress: session.mowingProgress };
}

/**
 * Verwerk een command in demo mode.
 * Returns true als het command is afgehandeld (skip MQTT publish).
 * Returns false als het command door de normale flow moet (bijv. set_para_info caching).
 */
function handleDemoCommand(sn: string, command: Record<string, unknown>): boolean {
  const session = demoSessions.get(sn);
  if (!session?.enabled) return false;

  const cmdName = Object.keys(command)[0];
  const cmdData = command[cmdName] as Record<string, unknown> | undefined;

  switch (cmdName) {
    case 'start_run':
      return handleStartRun(session, cmdData);
    case 'pause_run':
      return handlePause(session);
    case 'resume_run':
      return handleResume(session);
    case 'stop_run':
      return handleStop(session);
    case 'go_to_charge':
      return handleGoToCharge(session);
    case 'set_para_info':
      // Caching gebeurt al in dashboard.ts vóór de publish call — blokkeer MQTT publish
      return true;
    case 'generate_preview_cover_path':
      return handlePreviewPath(session, cmdData);
    default:
      console.log(`${TAG} Ignoring command in demo mode: ${cmdName}`);
      return true;
  }
}

// ── Session factory ───────────────────────────────────────────────

function createSession(sn: string): DemoSession {
  return {
    sn,
    enabled: false,
    state: 'idle',
    timer: null,
    polygon: [],
    chargerGps: { lat: 0, lng: 0 },
    mowPath: [],
    pathIndex: 0,
    skipIndices: new Set(),
    lastPreviewPath: [],
    lastPreviewDirection: -1,
    pathDirection: 0,
    laneWidth: 0.28,
    tickIntervalMs: 2000,
    stepSizeM: 0.8,
    battery: 85,
    mowingProgress: 0,
    heading: 0,
    currentLat: 0,
    currentLng: 0,
    coveredArea: 0,
    totalArea: 0,
    bladeWorkTime: 0,
    tickCount: 0,
    segmentDist: 0,
    totalPathDist: 0,
    distTraveled: 0,
  };
}

// ── Command handlers ──────────────────────────────────────────────

function handleStartRun(session: DemoSession, data?: Record<string, unknown>): boolean {
  // Stop eventuele lopende simulatie
  stopSimulation(session);

  // Haal richting uit command, of uit sensor cache (set_para_info wordt apart gestuurd)
  const cached = getDeviceSnapshot(session.sn);
  session.pathDirection = Number(
    data?.path_direction ?? data?.cov_direction
    ?? cached?.path_direction ?? cached?.cov_direction
    ?? 0
  );

  // Laad polygon uit DB
  const mapData = loadMapData(session.sn);
  if (!mapData) {
    console.error(`${TAG} Geen kaartdata gevonden voor ${session.sn} — kan simulatie niet starten`);
    return true;
  }

  session.polygon = mapData.polygon;
  session.chargerGps = mapData.chargerGps;
  session.totalArea = mapData.areaM2;

  // Hergebruik preview pad als richting matcht, anders genereer nieuw
  if (session.lastPreviewPath.length > 2 && session.lastPreviewDirection === session.pathDirection) {
    session.mowPath = session.lastPreviewPath;
    // skipIndices bleef al bewaard van preview
    console.log(`${TAG} Reusing preview path (${session.mowPath.length} points, direction=${session.pathDirection}°)`);
  } else {
    const result = generateStripePath(
      mapData.localPoints,
      session.pathDirection,
      session.laneWidth,
      mapData.chargerGps,
    );
    session.mowPath = result.path;
    session.skipIndices = result.skipIndices;
  }

  if (session.mowPath.length < 2) {
    console.error(`${TAG} Stripe-pad te kort (${session.mowPath.length} punten)`);
    return true;
  }

  console.log(`${TAG} Starting mow simulation: ${session.mowPath.length} path points, ` +
    `direction=${session.pathDirection}°, area=${session.totalArea.toFixed(1)}m²`);

  // Wis vorige GPS trail (server + dashboard) zodat oude simulatie-banen niet zichtbaar blijven
  clearGpsTrail(session.sn);
  emitTrailClear(session.sn);

  // Reset state
  session.pathIndex = 0;
  session.mowingProgress = 0;
  session.coveredArea = 0;
  session.bladeWorkTime = 0;
  session.tickCount = 0;
  session.segmentDist = 0;
  session.totalPathDist = 0;
  session.distTraveled = 0;
  session.currentLat = session.mowPath[0].lat;
  session.currentLng = session.mowPath[0].lng;
  session.state = 'mowing';

  // Start tick loop
  startSimulation(session);
  return true;
}

function handlePause(session: DemoSession): boolean {
  if (session.state !== 'mowing') return true;
  session.state = 'paused';
  emitState(session);
  console.log(`${TAG} Simulation paused`);
  return true;
}

function handleResume(session: DemoSession): boolean {
  if (session.state !== 'paused') return true;
  session.state = 'mowing';
  emitState(session);
  console.log(`${TAG} Simulation resumed`);
  return true;
}

function handleStop(session: DemoSession): boolean {
  stopSimulation(session);
  session.state = 'idle';
  session.mowingProgress = 0;
  emitState(session);
  console.log(`${TAG} Simulation stopped`);
  return true;
}

function handlePreviewPath(session: DemoSession, data?: Record<string, unknown>): boolean {
  const direction = Number(data?.cov_direction ?? data?.path_direction ?? 0);

  const mapData = loadMapData(session.sn);
  if (!mapData) {
    console.log(`${TAG} Preview path: geen kaartdata voor ${session.sn}`);
    return true;
  }

  const result = generateStripePath(mapData.localPoints, direction, session.laneWidth, mapData.chargerGps);
  session.lastPreviewPath = result.path;
  session.lastPreviewDirection = direction;
  session.skipIndices = result.skipIndices;

  console.log(`${TAG} Preview path generated: ${result.path.length} points, direction=${direction}°, skips=${result.skipIndices.size}`);
  return true;
}

function handleGoToCharge(session: DemoSession): boolean {
  session.state = 'returning';
  emitState(session);
  console.log(`${TAG} Simulation: returning to charger`);
  return true;
}

// ── Simulation loop ───────────────────────────────────────────────

function startSimulation(session: DemoSession): void {
  if (session.timer) clearInterval(session.timer);
  // Eerste emit direct
  emitState(session);
  session.timer = setInterval(() => simulationTick(session), session.tickIntervalMs);
}

function stopSimulation(session: DemoSession): void {
  if (session.timer) {
    clearInterval(session.timer);
    session.timer = null;
  }
}

function simulationTick(session: DemoSession): void {
  session.tickCount++;

  switch (session.state) {
    case 'mowing':
      tickMowing(session);
      break;
    case 'paused':
      // Alleen state uitsturen, geen beweging
      break;
    case 'returning':
      tickReturning(session);
      break;
    case 'charging':
      tickCharging(session);
      break;
    case 'idle':
      // Niets doen
      return;
  }

  emitState(session);

  // Elke 5e tick: ook timer data
  if (session.tickCount % 5 === 0) {
    emitTimerData(session);
  }
}

function tickMowing(session: DemoSession): void {
  // Bereken totale pad-lengte eenmalig — alleen maai-segmenten (even→oneven), NIET teleportaties
  if (session.totalPathDist === 0 && session.mowPath.length > 1) {
    for (let i = 0; i < session.mowPath.length - 1; i += 2) {
      session.totalPathDist += gpsDistance(session.mowPath[i], session.mowPath[i + 1]);
    }
  }

  // Verplaats langs het pad — track afstand BINNEN huidig segment
  let remaining = session.stepSizeM;

  while (remaining > 0 && session.pathIndex < session.mowPath.length - 1) {
    // Oneven pathIndex = einde van een lane → teleporteer instant naar start volgende lane
    // Dit voorkomt dat de maaier buiten de polygon rijdt bij bochten/concave gebieden
    if (session.pathIndex % 2 === 1) {
      session.pathIndex++;
      session.segmentDist = 0;
      const target = session.mowPath[session.pathIndex];
      session.currentLat = target.lat;
      session.currentLng = target.lng;
      continue;
    }

    const current = session.mowPath[session.pathIndex];
    const next = session.mowPath[session.pathIndex + 1];
    const segLength = gpsDistance(current, next);
    const segRemaining = segLength - session.segmentDist;

    if (segRemaining <= remaining) {
      // Voltooi dit segment, ga naar volgende
      remaining -= segRemaining;
      session.distTraveled += segRemaining;
      session.pathIndex++;
      session.segmentDist = 0;
      session.currentLat = next.lat;
      session.currentLng = next.lng;
    } else {
      // Verplaats BINNEN dit segment
      session.segmentDist += remaining;
      session.distTraveled += remaining;
      const fraction = session.segmentDist / segLength;
      session.currentLat = current.lat + (next.lat - current.lat) * fraction;
      session.currentLng = current.lng + (next.lng - current.lng) * fraction;
      remaining = 0;
    }
  }

  // Heading berekenen richting volgende punt
  if (session.pathIndex < session.mowPath.length - 1) {
    session.heading = bearing(
      { lat: session.currentLat, lng: session.currentLng },
      session.mowPath[session.pathIndex + 1],
    );
  }

  // Progress berekenen
  session.mowingProgress = session.totalPathDist > 0
    ? Math.min(100, Math.round((session.distTraveled / session.totalPathDist) * 100))
    : 0;
  session.coveredArea = (session.mowingProgress / 100) * session.totalArea;
  session.bladeWorkTime += session.tickIntervalMs / 1000;

  // Battery drain: ~0.05% per tick (2s) → ~90 min voor volledig leeg
  session.battery = Math.max(0, session.battery - 0.05);

  // Check: pad afgerond of battery laag → returning
  if (session.mowingProgress >= 100 || session.pathIndex >= session.mowPath.length - 1) {
    session.mowingProgress = 100;
    console.log(`${TAG} Mowing complete — returning to charger`);
    session.state = 'returning';
  } else if (session.battery < 10) {
    console.log(`${TAG} Battery low (${session.battery.toFixed(0)}%) — returning to charger`);
    session.state = 'returning';
  }
}

function tickReturning(session: DemoSession): void {
  // Instant teleporteer naar charger — voorkomt rechte lijn door concave polygon
  session.currentLat = session.chargerGps.lat;
  session.currentLng = session.chargerGps.lng;
  session.heading = 0;
  session.state = 'charging';
  console.log(`${TAG} Returned to charger — charging`);
}

function tickCharging(session: DemoSession): void {
  // Versneld opladen: +2% per tick (2s) → ~100s van 0→100%
  session.battery = Math.min(100, session.battery + 2);

  if (session.battery >= 100) {
    session.state = 'idle';
    stopSimulation(session);
    console.log(`${TAG} Fully charged — simulation complete`);
  }
}

// ── Sensor data emissie ───────────────────────────────────────────

function workStatusCode(state: DemoState): number {
  switch (state) {
    case 'idle': return 0;
    case 'mowing': return 1;
    case 'charging': return 2;
    case 'returning': return 3;
    case 'paused': return 4;
  }
}

function emitState(session: DemoSession): void {
  const payload = {
    report_state_robot: {
      work_status: workStatusCode(session.state),
      battery_power: Math.round(session.battery),
      battery_state: session.state === 'charging' ? 'CHARGING' : 'DISCHARGING',
      mowing_progress: session.mowingProgress,
      latitude: session.currentLat,
      longitude: session.currentLng,
      x: 0,
      y: 0,
      z: Math.round(session.heading),
      covering_area: session.totalArea.toFixed(2),
      finished_area: session.coveredArea.toFixed(2),
      cov_direction: session.pathDirection,
      mow_speed: session.state === 'mowing' ? '0.4' : '0',
      mow_blade_work_time: Math.round(session.bladeWorkTime),
      working_hours: (session.bladeWorkTime / 3600).toFixed(1),
      cpu_temperature: 42 + Math.floor(Math.random() * 8),
      loc_quality: 92 + Math.floor(Math.random() * 8),
      error_status: 0,
      error_code: 0,
      sw_version: 'v6.0.2-demo',
      ota_state: 'idle',
    },
  };

  // Zorg dat het dashboard de maaier als online ziet (ook als echte MQTT offline is)
  emitDeviceOnline(session.sn);

  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  const changes = updateDeviceData(session.sn, buf);
  forwardToDashboard(session.sn, changes);

  // Stuur afgelegde banen naar dashboard (elke 2 mowPath punten = 1 lane)
  if (session.state === 'mowing' && session.mowPath.length >= 2) {
    const completedLaneCount = Math.floor(session.pathIndex / 2);
    const lanes: Array<{ lat1: number; lng1: number; lat2: number; lng2: number }> = [];
    for (let i = 0; i < completedLaneCount; i++) {
      const a = session.mowPath[i * 2];
      const b = session.mowPath[i * 2 + 1];
      lanes.push({ lat1: a.lat, lng1: a.lng, lat2: b.lat, lng2: b.lng });
    }
    // Voeg de huidige (gedeeltelijk afgelegde) lane toe
    if (session.pathIndex % 2 === 1 || session.segmentDist > 0) {
      const laneStart = session.mowPath[completedLaneCount * 2];
      if (laneStart) {
        lanes.push({
          lat1: laneStart.lat, lng1: laneStart.lng,
          lat2: session.currentLat, lng2: session.currentLng,
        });
      }
    }
    emitCoveredLanes(session.sn, lanes);
  }
}

function emitTimerData(session: DemoSession): void {
  const payload = {
    report_state_timer_data: {
      localization: {
        gps_position: {
          latitude: session.currentLat,
          longitude: session.currentLng,
          altitude: 0,
          state: 'ENABLE',
        },
        localization_state: 'INITIALIZED',
      },
    },
  };

  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  const changes = updateDeviceData(session.sn, buf);
  forwardToDashboard(session.sn, changes);
}

// ── Map data laden ────────────────────────────────────────────────

interface MapData {
  polygon: GpsPoint[];
  localPoints: LocalPoint[];
  chargerGps: GpsPoint;
  areaM2: number;
}

function loadMapData(sn: string): MapData | null {
  // Haal charger GPS positie
  const cal = db.prepare(
    'SELECT charger_lat, charger_lng FROM map_calibration WHERE mower_sn = ?'
  ).get(sn) as { charger_lat: number | null; charger_lng: number | null } | undefined;

  if (!cal?.charger_lat || !cal?.charger_lng) {
    console.error(`${TAG} Geen charger GPS positie voor ${sn}`);
    return null;
  }

  const chargerGps: GpsPoint = { lat: cal.charger_lat, lng: cal.charger_lng };

  // Haal eerste work-polygon uit DB (lokale meters)
  const row = db.prepare(
    "SELECT map_area FROM maps WHERE mower_sn = ? AND map_type = 'work' AND map_area IS NOT NULL ORDER BY map_id LIMIT 1"
  ).get(sn) as { map_area: string } | undefined;

  if (!row?.map_area) {
    console.error(`${TAG} Geen work-polygon gevonden voor ${sn}`);
    return null;
  }

  const localPoints: LocalPoint[] = JSON.parse(row.map_area);
  if (!localPoints || localPoints.length < 3) {
    console.error(`${TAG} Polygon te klein (${localPoints?.length ?? 0} punten)`);
    return null;
  }

  // Bereken oppervlakte (Shoelace)
  let area = 0;
  for (let i = 0; i < localPoints.length; i++) {
    const j = (i + 1) % localPoints.length;
    area += localPoints[i].x * localPoints[j].y;
    area -= localPoints[j].x * localPoints[i].y;
  }
  const areaM2 = Math.abs(area) / 2;

  // Converteer naar GPS
  const polygon = localPoints.map(p => localToGps(p, chargerGps));

  return { polygon, localPoints, chargerGps, areaM2 };
}

// ── Stripe pad generator (boustrophedon) ──────────────────────────

/**
 * Genereer een heen-en-weer stripe patroon binnen een polygoon.
 *
 * 1. Roteer polygon zodat maairichting langs Y-as uitlijnt
 * 2. Genereer verticale scanlijnen (constant X) op laneWidth interval
 *    → stripes lopen langs Y = de maairichting
 * 3. Vind snijpunten met polygoonranden
 * 4. Verbind in boustrophedon (zigzag) patroon
 * 5. Roteer terug en converteer naar GPS
 */
function generateStripePath(
  localPoints: LocalPoint[],
  directionDeg: number,
  laneWidth: number,
  chargerGps: GpsPoint,
): { path: GpsPoint[]; skipIndices: Set<number> } {
  const dirRad = (directionDeg * Math.PI) / 180;
  // Roteer met +dirRad zodat maairichting (bearing) op Y-as uitkomt
  // Bearing θ → richting (sinθ, cosθ) in lokaal (x=oost, y=noord)
  // R(+θ) × (sinθ, cosθ) = (0, 1) → Y-as ✓
  const cos = Math.cos(dirRad);
  const sin = Math.sin(dirRad);

  // Roteer polygon zodat maairichting langs Y-as
  const rotated = localPoints.map(p => ({
    x: p.x * cos - p.y * sin,
    y: p.x * sin + p.y * cos,
  }));

  // Bounding box
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of rotated) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }

  // Genereer verticale scanlijnen (constant X, mower beweegt langs Y = maairichting)
  const pathPoints: LocalPoint[] = [];
  const skipAfter = new Set<number>();  // indices waarna geteleporteerd wordt
  let forward = true;
  const edgeMargin = laneWidth * 0.05; // minimale marge zodat clipping de rest doet

  for (let x = minX + laneWidth * 0.5; x <= maxX; x += laneWidth) {
    // Vind Y-snijpunten van verticale lijn x met polygoonranden
    const intersections: number[] = [];
    const n = rotated.length;

    for (let i = 0; i < n; i++) {
      const a = rotated[i];
      const b = rotated[(i + 1) % n];

      // Check of de rand de scanlijn kruist
      if ((a.x <= x && b.x > x) || (b.x <= x && a.x > x)) {
        // Y-positie van snijpunt
        const t = (x - a.x) / (b.x - a.x);
        intersections.push(a.y + t * (b.y - a.y));
      }
    }

    if (intersections.length < 2) continue;
    intersections.sort((a, b) => a - b);

    // Gebruik opeenvolgende paren (enter/exit) zodat concave gaten worden overgeslagen
    const segments: Array<{ yStart: number; yEnd: number }> = [];
    for (let j = 0; j < intersections.length - 1; j += 2) {
      const yS = intersections[j] + edgeMargin;
      const yE = intersections[j + 1] - edgeMargin;
      if (yS < yE) segments.push({ yStart: yS, yEnd: yE });
    }

    // Voeg segmenten toe in boustrophedon volgorde
    const ordered = forward ? segments : [...segments].reverse();
    for (let si = 0; si < ordered.length; si++) {
      const seg = ordered[si];
      // Bij 2+ segmenten per scanlijn: markeer transitie als "skip" (teleporteer)
      if (si > 0 && pathPoints.length > 0) {
        skipAfter.add(pathPoints.length - 1);
      }
      if (forward) {
        pathPoints.push({ x, y: seg.yStart });
        pathPoints.push({ x, y: seg.yEnd });
      } else {
        pathPoints.push({ x, y: seg.yEnd });
        pathPoints.push({ x, y: seg.yStart });
      }
    }
    if (segments.length > 0) forward = !forward;
  }

  const laneCount = pathPoints.length / 2;
  console.log(`${TAG} Stripe generator: bbox X=[${minX.toFixed(2)}, ${maxX.toFixed(2)}] (${(maxX-minX).toFixed(2)}m), ` +
    `Y=[${minY.toFixed(2)}, ${maxY.toFixed(2)}] (${(maxY-minY).toFixed(2)}m), ` +
    `laneWidth=${laneWidth}m → ${laneCount} lanes, ${pathPoints.length} points`);

  if (pathPoints.length === 0) {
    console.warn(`${TAG} Stripe path generator produced 0 points`);
    return { path: [], skipIndices: new Set<number>() };
  }

  if (skipAfter.size > 0) {
    console.log(`${TAG} Concave skip points: ${[...skipAfter].join(', ')}`);
  }

  // Roteer terug naar origineel coördinatensysteem (inverse = -dirRad)
  const cosBack = Math.cos(-dirRad);
  const sinBack = Math.sin(-dirRad);
  const originalPoints = pathPoints.map(p => ({
    x: p.x * cosBack - p.y * sinBack,
    y: p.x * sinBack + p.y * cosBack,
  }));

  // Converteer naar GPS
  return {
    path: originalPoints.map(p => localToGps(p, chargerGps)),
    skipIndices: skipAfter,
  };
}

// ── Geo helpers ───────────────────────────────────────────────────

/** Afstand tussen twee GPS punten in meters (haversine vereenvoudigd voor korte afstanden). */
function gpsDistance(a: GpsPoint, b: GpsPoint): number {
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180) * 111320;
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Bearing van punt a naar punt b in graden (0 = noord, 90 = oost). */
function bearing(a: GpsPoint, b: GpsPoint): number {
  const dLng = (b.lng - a.lng) * Math.cos(a.lat * Math.PI / 180);
  const dLat = b.lat - a.lat;
  const rad = Math.atan2(dLng, dLat);
  return ((rad * 180 / Math.PI) + 360) % 360;
}
