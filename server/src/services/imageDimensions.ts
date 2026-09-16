/**
 * Pixel size of a JPEG or PNG from its header, nothing more.
 *
 * The drone overlay needs the aspect ratio to turn a width in metres into a
 * height in metres, and reading two bytes out of a header is not worth an
 * image library in the container. Anything that is not a JPEG or PNG, or a
 * truncated one, comes back null and the upload is refused.
 */
export interface ImageDimensions {
  width: number;
  height: number;
  mime: 'image/jpeg' | 'image/png';
}

export function imageDimensions(buf: Buffer): ImageDimensions | null {
  // PNG: 8-byte signature, then the IHDR chunk with width and height.
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height, mime: 'image/png' } : null;
  }
  // JPEG: walk the markers until a start-of-frame, which carries the size.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      const sof = (marker >= 0xc0 && marker <= 0xcf) && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) {
        const height = buf.readUInt16BE(i + 5);
        const width = buf.readUInt16BE(i + 7);
        return width > 0 && height > 0 ? { width, height, mime: 'image/jpeg' } : null;
      }
      if (marker === 0xd9 || marker === 0xda) return null;   // end of image / scan without a frame
      i += 2 + len;
    }
  }
  return null;
}
