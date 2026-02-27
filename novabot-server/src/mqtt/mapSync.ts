/**
 * Map Sync — haalt kaarten op van de maaier via MQTT en slaat ze op in de database.
 *
 * Wanneer een maaier (LFIN*) verbindt met de MQTT broker, stuurt deze module
 * automatisch `get_map_list` om de kaarten op te vragen. Vervolgens wordt per
 * kaart `get_map_outline` gestuurd om de polygoon-data op te halen.
 *
 * Responses worden geparsed en opgeslagen in de `maps` tabel.
 */
import { Aedes, AedesPublishPacket } from 'aedes';
import { db } from '../db/database.js';

const TAG = '[MAP-SYNC]';

let aedesBroker: Aedes | null = null;

// Bijhouden voor welke SNs we al een map-request hebben gestuurd (voorkom spam)
const pendingRequests = new Set<string>();

/**
 * Initialiseer mapSync met een referentie naar de Aedes broker.
 */
export function initMapSync(broker: Aedes): void {
  aedesBroker = broker;
}

/**
 * Publiceer een MQTT commando naar een apparaat.
 */
/**
 * Publiceer een raw Buffer naar een apparaat (bijv. AES-versleutelde payload).
 */
export function publishRawToDevice(sn: string, payload: Buffer, qos: 0 | 1 = 1): void {
  if (!aedesBroker) {
    console.error(`${TAG} Broker niet geinitialiseerd`);
    return;
  }
  const topic = `Dart/Send_mqtt/${sn}`;
  const packet = {
    cmd: 'publish' as const,
    qos: qos as 0 | 1,
    dup: false,
    retain: false,
    topic,
    payload,
    brokerId: 'mapSync',
    brokerCounter: 0,
  } satisfies AedesPublishPacket;
  aedesBroker.publish(packet, (err) => {
    if (err) console.error(`${TAG} Raw publish fout naar ${topic}: ${err.message}`);
    else console.log(`${TAG} Raw payload (${payload.length}B) gestuurd naar ${topic} QoS=${qos}`);
  });
}

export function publishToDevice(sn: string, command: Record<string, unknown>): void {
  if (!aedesBroker) {
    console.error(`${TAG} Broker niet geinitialiseerd`);
    return;
  }

  const topic = `Dart/Send_mqtt/${sn}`;
  const payload = JSON.stringify(command);

  const packet = {
    cmd: 'publish' as const,
    qos: 0 as const,
    dup: false,
    retain: false,
    topic,
    payload: Buffer.from(payload),
    brokerId: 'mapSync',
    brokerCounter: 0,
  } satisfies AedesPublishPacket;

  aedesBroker.publish(packet, (err) => {
    if (err) {
      console.error(`${TAG} Publish fout naar ${topic}: ${err.message}`);
    } else {
      console.log(`${TAG} Gestuurd naar ${topic}: ${payload}`);
    }
  });
}

/**
 * Vraag de kaartlijst op van een maaier.
 */
export function requestMapList(sn: string): void {
  console.log(`${TAG} Opvragen kaartlijst van ${sn}...`);
  publishToDevice(sn, { get_map_list: {} });
}

/**
 * Vraag de outline/polygoon op van een specifieke kaart.
 */
export function requestMapOutline(sn: string, mapId: string): void {
  console.log(`${TAG} Opvragen outline voor kaart ${mapId} van ${sn}...`);
  publishToDevice(sn, { get_map_outline: { map_id: mapId } });
}

/**
 * Automatisch kaarten opvragen wanneer een maaier verbindt.
 * Wordt aangeroepen vanuit broker.ts authenticate handler.
 * Wacht 3 seconden zodat de maaier tijd heeft om te settlen.
 */
export function onMowerConnected(sn: string): void {
  if (!sn.startsWith('LFIN')) return;
  if (pendingRequests.has(sn)) return;

  pendingRequests.add(sn);
  console.log(`${TAG} Maaier ${sn} verbonden — kaarten opvragen over 3s...`);

  setTimeout(() => {
    requestMapList(sn);
    // Na 30 seconden de pending flag resetten zodat bij reconnect opnieuw gevraagd kan worden
    setTimeout(() => pendingRequests.delete(sn), 30_000);
  }, 3000);
}

/**
 * Verwerk een inkomend MQTT bericht dat kaart-gerelateerd kan zijn.
 * Retourneert true als het bericht afgehandeld is.
 */
export function handleMapMessage(sn: string, parsed: Record<string, unknown>): boolean {
  const command = Object.keys(parsed)[0];
  if (!command) return false;

  switch (command) {
    case 'get_map_list_respond':
      handleMapListResponse(sn, parsed[command]);
      return true;

    case 'report_state_map_outline':
      handleMapOutlineResponse(sn, parsed[command]);
      return true;

    default:
      return false;
  }
}

/**
 * Verwerk get_map_list_respond — bevat lijst van alle kaarten op de maaier.
 *
 * Verwachte formaten (op basis van APK analyse):
 * - { map_ids: ["id1", "id2", ...] }
 * - { maps: [{ map_id, map_name, map_type }, ...] }
 * - { result: 0, value: { ... } }
 */
function handleMapListResponse(sn: string, data: unknown): void {
  console.log(`${TAG} Ontvangen kaartlijst van ${sn}:`, JSON.stringify(data));

  if (!data || typeof data !== 'object') {
    console.log(`${TAG} Lege of ongeldige kaartlijst response`);
    return;
  }

  const d = data as Record<string, unknown>;

  // Probeer map_ids array te vinden
  let mapIds: string[] = [];

  if (Array.isArray(d.map_ids)) {
    mapIds = d.map_ids.filter((id): id is string => typeof id === 'string');
  } else if (Array.isArray(d.maps)) {
    // Volledige map objecten
    for (const map of d.maps) {
      if (typeof map === 'object' && map !== null) {
        const m = map as Record<string, unknown>;
        const mapId = String(m.map_id ?? m.mapId ?? '');
        if (mapId) {
          mapIds.push(mapId);
          // Sla eventuele metadata alvast op
          upsertMapMetadata(sn, mapId, m);
        }
      }
    }
  } else if (d.result !== undefined && d.value && typeof d.value === 'object') {
    // Wrapped in result/value
    return handleMapListResponse(sn, d.value);
  }

  if (mapIds.length === 0) {
    console.log(`${TAG} Geen kaarten gevonden op maaier ${sn}`);
    return;
  }

  console.log(`${TAG} ${mapIds.length} kaart(en) gevonden op ${sn}: ${mapIds.join(', ')}`);

  // Vraag de outline op voor elke kaart
  for (const mapId of mapIds) {
    setTimeout(() => {
      requestMapOutline(sn, mapId);
    }, 500);
  }
}

/**
 * Verwerk report_state_map_outline — bevat polygoon data voor een kaart.
 *
 * Verwacht formaat (op basis van APK MapEntity):
 * - { map_id, map_name, map_type, map_position: [{lat, lng}, ...] }
 * - Of: { map_id, map_name, map_type, outline: [[lat,lng], ...] }
 */
function handleMapOutlineResponse(sn: string, data: unknown): void {
  console.log(`${TAG} Ontvangen kaart-outline van ${sn}:`, JSON.stringify(data)?.slice(0, 500));

  if (!data || typeof data !== 'object') return;

  const d = data as Record<string, unknown>;
  const mapId = String(d.map_id ?? d.mapId ?? '');
  if (!mapId) {
    console.log(`${TAG} Outline response zonder map_id`);
    return;
  }

  const mapName = String(d.map_name ?? d.mapName ?? d.map_type ?? '');
  const mapType = String(d.map_type ?? d.mapType ?? '');

  // Probeer polygoon punten te vinden
  let points: { lat: number; lng: number }[] = [];

  // Formaat 1: map_position als array van {lat, lng}
  if (Array.isArray(d.map_position)) {
    points = parsePositionArray(d.map_position);
  }
  // Formaat 2: outline als array van [lat, lng]
  else if (Array.isArray(d.outline)) {
    points = parsePositionArray(d.outline);
  }
  // Formaat 3: points als array
  else if (Array.isArray(d.points)) {
    points = parsePositionArray(d.points);
  }

  if (points.length === 0) {
    console.log(`${TAG} Geen polygoon punten in outline voor ${mapId}`);
    // Sla metadata op zonder polygoon
    upsertMapMetadata(sn, mapId, d);
    return;
  }

  // Bereken bounds
  const lats = points.map(p => p.lat);
  const lngs = points.map(p => p.lng);
  const bounds = {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };

  // Sla op in database
  const displayName = mapName || mapType || `Map ${mapId.slice(0, 8)}`;

  db.prepare(`
    INSERT INTO maps (map_id, mower_sn, map_name, map_area, map_max_min, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(map_id) DO UPDATE SET
      map_name    = excluded.map_name,
      map_area    = excluded.map_area,
      map_max_min = excluded.map_max_min,
      updated_at  = datetime('now')
  `).run(
    mapId,
    sn,
    displayName,
    JSON.stringify(points),
    JSON.stringify(bounds),
  );

  console.log(`${TAG} Kaart "${displayName}" (${mapId}) opgeslagen: ${points.length} punten, bounds: ${JSON.stringify(bounds)}`);
}

/**
 * Parse een array van positie-objecten naar {lat, lng}[].
 * Ondersteunt: [{lat,lng}], [[lat,lng]], [{x,y}], [{latitude,longitude}]
 */
function parsePositionArray(arr: unknown[]): { lat: number; lng: number }[] {
  const points: { lat: number; lng: number }[] = [];

  for (const item of arr) {
    if (Array.isArray(item) && item.length >= 2) {
      const lat = Number(item[0]);
      const lng = Number(item[1]);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        points.push({ lat, lng });
      }
    } else if (typeof item === 'object' && item !== null) {
      const o = item as Record<string, unknown>;
      const lat = Number(o.lat ?? o.latitude ?? o.y ?? 0);
      const lng = Number(o.lng ?? o.longitude ?? o.x ?? 0);
      if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
        points.push({ lat, lng });
      }
    }
  }

  return points;
}

/**
 * Sla kaart metadata op (naam, type) zonder polygoon data.
 */
function upsertMapMetadata(sn: string, mapId: string, meta: Record<string, unknown>): void {
  const mapName = String(meta.map_name ?? meta.mapName ?? meta.map_type ?? '');

  // Alleen inserteren als de kaart nog niet bestaat
  db.prepare(`
    INSERT OR IGNORE INTO maps (map_id, mower_sn, map_name, created_at, updated_at)
    VALUES (?, ?, ?, datetime('now'), datetime('now'))
  `).run(mapId, sn, mapName || null);
}
