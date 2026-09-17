/**
 * The pixel size of a JPEG, PNG or WebP, read from its header.
 *
 * Kept to headers on purpose: this service does not decode or transform images
 * (see `ProductImagesService`), it only needs to know how big a picture is so
 * the storefront can reserve the space before the picture loads -- and to
 * refuse a file that claims to be an image and is not one.
 */
export function imageSize(bytes: Buffer): { width: number; height: number; type: 'png' | 'jpeg' | 'webp' } | null {
  // PNG: signature, then the IHDR chunk with width and height as big-endian u32s.
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), type: 'png' };
  }

  // JPEG: walk the markers to the first start-of-frame, which carries the size.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1]!;
      // Fill bytes between markers.
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      const length = bytes.readUInt16BE(offset + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5), type: 'jpeg' };
      }
      if (length < 2) return null;
      offset += 2 + length;
    }
    return null;
  }

  // WebP: RIFF container, then a lossy, lossless or extended chunk.
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') {
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff, type: 'webp' };
    }
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, type: 'webp' };
    }
    if (chunk === 'VP8X') {
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1, type: 'webp' };
    }
  }
  return null;
}
