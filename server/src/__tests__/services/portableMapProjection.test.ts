import { expect, it } from 'vitest';
import unzipper from 'unzipper';
import { exportBundle } from '../../services/portableMap.js';

it('GeoJSON projects map-frame points from the nonzero dock anchor along the UTM grid', async () => {
  const ref = { lat: 52.140845931081316, lng: 6.2311545451881649 };
  const anchor = { x: -1.21, y: 0.48, orientation: 1.5 };
  const points = [{ x: anchor.x, y: anchor.y + 25 }, { x: anchor.x + 10, y: anchor.y + 25 }, { x: anchor.x, y: anchor.y + 30 }];
  const zip = await exportBundle({
    sn: 'LFIN_PROJECTION', chargerLat: ref.lat, chargerLng: ref.lng,
    chargingPose: anchor, rtkQuality: 4,
    workMaps: [{ canonical: 'map0', alias: 'Garden', points }], obstacles: [],
    unicom: [{ canonical: 'map0tocharge_unicom', targetMapName: 'charge', points: [anchor, points[0]] }],
  });
  const entries = await unzipper.Open.buffer(zip);
  const json = async (name: string) => JSON.parse((await entries.files.find(f => f.path === name)!.buffer()).toString());
  const work = await json('geojson/work.geojson');
  const [lng, lat] = work.features[0].geometry.coordinates[0][0];
  // Independent PROJ reference: +25 m grid north is also 0.95 m west here.
  expect(Math.hypot((lat - 52.14107043698007) * 111265, (lng - 6.231140612434456) * 68477)).toBeLessThan(0.01);
  const dock = await json('geojson/unicom.geojson');
  expect(dock.features[0].geometry.coordinates[0]).toEqual([ref.lng, ref.lat]);
  expect((await json('polygon.json')).points).toEqual(points);
});
