/**
 * Reading a drone's metadata out of a JPEG (#124), and the first placement
 * made from it. The JPEGs are built by hand: a TIFF with an Exif IFD and a
 * GPS IFD the way cameras write them, and an XMP packet the way DJI does.
 */
import { describe, it, expect } from 'vitest';
import { photoMetadata } from '../../services/photoMetadata.js';
import { firstPlacement, similarityCorners } from '../../routes/droneOverlay.js';

/** Little-endian TIFF: IFD0 -> Exif IFD (FocalLengthIn35mmFormat 24) and GPS IFD (52°08'27.2"N 6°13'51.73"E). */
export function tiff(): Buffer {
  const b = Buffer.alloc(158);
  b.write('II', 0, 'latin1'); b.writeUInt16LE(42, 2); b.writeUInt32LE(8, 4);
  const entry = (off: number, tag: number, type: number, count: number, value: number) => {
    b.writeUInt16LE(tag, off); b.writeUInt16LE(type, off + 2); b.writeUInt32LE(count, off + 4); b.writeUInt32LE(value, off + 8);
  };
  b.writeUInt16LE(2, 8); entry(10, 0x8769, 4, 1, 38); entry(22, 0x8825, 4, 1, 56); b.writeUInt32LE(0, 34);
  b.writeUInt16LE(1, 38); entry(40, 0xa405, 3, 1, 24); b.writeUInt32LE(0, 52);
  b.writeUInt16LE(4, 56);
  entry(58, 1, 2, 2, 0); b.write('N\0', 66, 'latin1');
  entry(70, 2, 5, 3, 110);
  entry(82, 3, 2, 2, 0); b.write('E\0', 90, 'latin1');
  entry(94, 4, 5, 3, 134);
  b.writeUInt32LE(0, 106);
  const rat = (off: number, n: number, d: number) => { b.writeUInt32LE(n, off); b.writeUInt32LE(d, off + 4); };
  rat(110, 52, 1); rat(118, 8, 1); rat(126, 27200, 1000);
  rat(134, 6, 1); rat(142, 13, 1); rat(150, 51730, 1000);
  return b;
}

export const DJI_XMP = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">'
  + '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="DJI Meta Data"'
  + ' xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/" drone-dji:GpsLatitude="+52.14088900" drone-dji:GpsLongitude="+6.23103600"'
  + ' drone-dji:AbsoluteAltitude="+52.30" drone-dji:RelativeAltitude="+40.00" drone-dji:GimbalRollDegree="+0.00"'
  + ' drone-dji:GimbalYawDegree="+17.30" drone-dji:GimbalPitchDegree="-90.00" drone-dji:FlightYawDegree="+16.90"/>'
  + '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';

function app1(payload: Buffer): Buffer {
  const head = Buffer.alloc(4); head[0] = 0xff; head[1] = 0xe1; head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
/** SOI, the APP1 segments given, then an SOF0 frame header for width x height. */
export function droneJpeg(width: number, height: number, opts: { exif?: boolean; xmp?: string | null } = {}): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  if (opts.exif !== false) parts.push(app1(Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff()])));
  if (opts.xmp !== null) parts.push(app1(Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(opts.xmp ?? DJI_XMP, 'utf8')])));
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7);
  parts.push(sof);
  return Buffer.concat(parts);
}

const metres = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
  Math.hypot((a.lat - b.lat) * 111_320, (a.lng - b.lng) * 111_320 * Math.cos(a.lat * Math.PI / 180));

describe('photo metadata', () => {
  it('reads DJI XMP and the EXIF focal length from a photo', () => {
    expect(photoMetadata(droneJpeg(4000, 3000))).toEqual({
      lat: 52.140889, lng: 6.231036, altitudeM: 40, yawDeg: 17.3, pitchDeg: -90, focal35: 24,
    });
  });

  it('falls back to the EXIF GPS IFD when there is no XMP', () => {
    const m = photoMetadata(droneJpeg(4000, 3000, { xmp: null }));
    expect(m.focal35).toBe(24);
    expect(m.lat).toBeCloseTo(52.140889, 6);
    expect(m.lng).toBeCloseTo(6.231036, 6);
    expect(m.altitudeM).toBeUndefined();
  });

  it('reads DJI fields written as elements too, and ignores junk', () => {
    const xmp = '<rdf:Description><drone-dji:GpsLatitude>-33.5</drone-dji:GpsLatitude><drone-dji:GpsLongitude>151.2</drone-dji:GpsLongitude><drone-dji:RelativeAltitude>abc</drone-dji:RelativeAltitude></rdf:Description>';
    expect(photoMetadata(droneJpeg(100, 100, { exif: false, xmp }))).toEqual({ lat: -33.5, lng: 151.2 });
    expect(photoMetadata(Buffer.from('GIF89a'))).toEqual({});
    expect(photoMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x08, 0x45, 0x78]))).toEqual({});   // truncated APP1
  });

  it('is not fooled by a photo with the sensor size but no drone', () => {
    expect(photoMetadata(droneJpeg(4000, 3000, { exif: false, xmp: null }))).toEqual({});
  });
});

describe('first placement', () => {
  const dims = { width: 4000, height: 3000 };
  const m = photoMetadata(droneJpeg(4000, 3000));

  it('sits on the GPS position, as wide as the lens sees from that height, turned to the heading', () => {
    const p = firstPlacement(m, dims, { lat: 1, lng: 1 })!;
    const centre = { lat: (p.corners[0].lat + p.corners[2].lat) / 2, lng: (p.corners[0].lng + p.corners[2].lng) / 2 };
    expect(metres(centre, { lat: 52.140889, lng: 6.231036 })).toBeLessThan(1e-3);
    // 24 mm on the 43.27 mm diagonal: 84.1° diagonal, 71.6° across a 4:3 frame; at 40 m that is 57.7 m
    const halfH = Math.atan(Math.tan(Math.atan(43.27 / 48)) * 4 / 5);
    expect(metres(p.corners[0], p.corners[1])).toBeCloseTo(2 * 40 * Math.tan(halfH), 2);
    expect(metres(p.corners[0], p.corners[1])).toBeCloseTo(57.7, 0);
    // the top edge points 17.3° east of north... as a heading: the photo's top is turned 17.3° clockwise
    const want = similarityCorners({ lat: 52.140889, lng: 6.231036 }, 2 * 40 * Math.tan(halfH), 17.3, 4 / 3);
    for (let i = 0; i < 4; i++) expect(metres(p.corners[i], want[i])).toBeLessThan(1e-3);
    expect(p.opacity).toBe(0.8);
  });

  it('uses 60 m and north up without height or lens, and the map centre without GPS', () => {
    const noHeight = firstPlacement({ lat: 52.14, lng: 6.23, focal35: 24 }, dims, null)!;
    expect(metres(noHeight.corners[0], noHeight.corners[1])).toBeCloseTo(60, 3);
    const noGps = firstPlacement({ altitudeM: 40, focal35: 24 }, dims, { lat: 52.1, lng: 6.2 })!;
    expect(metres(noGps.corners[0], noGps.corners[1])).toBeCloseTo(57.7, 0);
    expect((noGps.corners[0].lat + noGps.corners[2].lat) / 2).toBeCloseTo(52.1, 9);
    expect(firstPlacement({ lat: 0, lng: 0 }, dims, null)).toBeNull();   // null island is no position
  });
});
