/** Parse het TGR1 display-grid van GET /api/dashboard/terrain/:sn. */
export interface TerrainData {
  cellSize: number;
  ix: Int32Array;
  iy: Int32Array;
  h: Float32Array;
  cnt: Uint32Array;
}

export function parseTerrain(buf: ArrayBuffer): TerrainData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TGR1') throw new Error('bad magic');
  const cellSize = dv.getFloat64(4, true);
  const n = dv.getInt32(12, true);
  const ix = new Int32Array(n), iy = new Int32Array(n);
  const h = new Float32Array(n); const cnt = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 16;
    ix[i] = dv.getInt32(o, true);
    iy[i] = dv.getInt32(o + 4, true);
    h[i] = dv.getFloat32(o + 8, true);
    cnt[i] = dv.getUint32(o + 12, true);
  }
  return { cellSize, ix, iy, h, cnt };
}

/** Parse het TGO1 display-objectgrid van GET /api/dashboard/terrain-objects/:sn. */
export interface ObjectData {
  cellSize: number;
  ix: Int32Array;
  iy: Int32Array;
  label: Uint8Array;
  h: Float32Array;
  cnt: Uint32Array;
}

export function parseObjects(buf: ArrayBuffer): ObjectData {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'TGO1') throw new Error('bad magic');
  const cellSize = dv.getFloat64(4, true);
  const n = dv.getInt32(12, true);
  const ix = new Int32Array(n), iy = new Int32Array(n);
  const label = new Uint8Array(n); const h = new Float32Array(n); const cnt = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const o = 16 + i * 17;
    ix[i] = dv.getInt32(o, true); iy[i] = dv.getInt32(o + 4, true);
    label[i] = dv.getUint8(o + 8); h[i] = dv.getFloat32(o + 9, true); cnt[i] = dv.getUint32(o + 13, true);
  }
  return { cellSize, ix, iy, label, h, cnt };
}

// label → kleur: 10=laadstation (blauw), 8=struik (groen), 5/6=obstakel (oranje)
export const LABEL_COLORS: Record<number, string> = { 10: '#3b82f6', 8: '#22c55e', 5: '#f97316', 6: '#f97316' };
export const LABEL_DEFAULT_COLOR = '#d6d3d1';
