/**
 * What a drone wrote into its photo (#124): where it hung, how high, and
 * which way the camera looked. Enough for a first placement of the photo on
 * the map that is right to a metre or two, so the points the user picks only
 * do the last bit.
 *
 * Two sources, both JPEG APP1 segments. EXIF, a TIFF structure, for the
 * 35 mm equivalent focal length and, as a fallback, GPS. And the XMP packet,
 * where DJI keeps its own drone-dji:* fields for GPS, height above take-off
 * and the gimbal's yaw and pitch. Only what the placement needs is read; a
 * photo without any of it simply yields nothing, never an error.
 */
export interface PhotoMetadata {
  lat?: number;
  lng?: number;
  /** Height above the take-off point, metres (DJI RelativeAltitude). */
  altitudeM?: number;
  /** Camera heading, degrees clockwise from north (DJI GimbalYawDegree). */
  yawDeg?: number;
  /** Camera pitch, degrees; -90 is straight down (DJI GimbalPitchDegree). */
  pitchDeg?: number;
  /** 35 mm equivalent focal length, mm (EXIF FocalLengthIn35mmFormat). */
  focal35?: number;
}

const EXIF_HEAD = 'Exif\0\0';
const XMP_HEAD = 'http://ns.adobe.com/xap/1.0/\0';

export function photoMetadata(buf: Buffer): PhotoMetadata {
  const out: PhotoMetadata = {};
  if (!(buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8)) return out;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;                 // image data: nothing after it is metadata
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i + 4, i + 2 + len);
    if (marker === 0xe1) {
      if (seg.subarray(0, EXIF_HEAD.length).toString('latin1') === EXIF_HEAD) Object.assign(out, exif(seg.subarray(EXIF_HEAD.length)));
      else if (seg.subarray(0, XMP_HEAD.length).toString('latin1') === XMP_HEAD) Object.assign(out, xmp(seg.subarray(XMP_HEAD.length).toString('utf8')));
    }
    i += 2 + len;
  }
  return out;
}

/** DJI's fields sit as attributes (or elements) of the rdf:Description. */
function xmp(text: string): PhotoMetadata {
  const out: PhotoMetadata = {};
  const read = (name: string): number | undefined => {
    const m = new RegExp(`drone-dji:${name}(?:="([^"]*)"|>([^<]*)<)`).exec(text);
    const v = m ? parseFloat(m[1] ?? m[2]) : NaN;
    return Number.isFinite(v) ? v : undefined;
  };
  const lat = read('GpsLatitude'), lng = read('GpsLongitude');
  if (lat !== undefined && lng !== undefined) { out.lat = lat; out.lng = lng; }
  const alt = read('RelativeAltitude'), yaw = read('GimbalYawDegree'), pitch = read('GimbalPitchDegree');
  if (alt !== undefined) out.altitudeM = alt;
  if (yaw !== undefined) out.yawDeg = yaw;
  if (pitch !== undefined) out.pitchDeg = pitch;
  return out;
}

/** TIFF: IFD0 points at the Exif IFD (focal length) and the GPS IFD. */
function exif(t: Buffer): PhotoMetadata {
  const out: PhotoMetadata = {};
  try {
    if (t.length < 8) return out;
    const order = t.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return out;
    const le = order === 'II';
    const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    if (u16(2) !== 42) return out;
    const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const entries = (off: number) => {
      const m = new Map<number, { type: number; count: number; at: number }>();
      const n = u16(off);
      for (let k = 0; k < n; k++) {
        const e = off + 2 + k * 12;
        const type = u16(e + 2), count = u32(e + 4);
        const at = (SIZE[type] ?? 1) * count <= 4 ? e + 8 : u32(e + 8);   // small values sit in the entry itself
        m.set(u16(e), { type, count, at });
      }
      return m;
    };
    const rational = (at: number) => { const n = u32(at), d = u32(at + 4); return d ? n / d : NaN; };
    const top = entries(u32(4));
    const exifIfd = top.get(0x8769), gpsIfd = top.get(0x8825);
    if (exifIfd) {
      const f35 = entries(u32(exifIfd.at)).get(0xa405);
      if (f35 && f35.type === 3 && u16(f35.at) > 0) out.focal35 = u16(f35.at);
    }
    if (gpsIfd) {
      const g = entries(u32(gpsIfd.at));
      const coord = (refTag: number, valTag: number): number | undefined => {
        const ref = g.get(refTag), val = g.get(valTag);
        if (!ref || !val || val.type !== 5 || val.count < 3) return undefined;
        const deg = rational(val.at) + rational(val.at + 8) / 60 + rational(val.at + 16) / 3600;
        const hemi = String.fromCharCode(t[ref.at]);
        return Number.isFinite(deg) ? (hemi === 'S' || hemi === 'W' ? -deg : deg) : undefined;
      };
      const lat = coord(1, 2), lng = coord(3, 4);
      if (lat !== undefined && lng !== undefined) { out.lat = lat; out.lng = lng; }
    }
  } catch {
    // a truncated or odd TIFF: whatever was read before it is still fine
  }
  return out;
}
