import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from './image-size.js';

/** A PNG header for the given size: enough bytes for the reader, not a whole image. */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A JPEG with an APP0 segment before its start-of-frame, as cameras and editors write them. */
function jpegHeader(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(17, 2);
  sof[4] = 8;
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

test('reads the size of a PNG and a JPEG from their headers', () => {
  assert.deepEqual(imageSize(pngHeader(1920, 853)), { width: 1920, height: 853, type: 'png' });
  assert.deepEqual(imageSize(jpegHeader(1040, 500)), { width: 1040, height: 500, type: 'jpeg' });
});

test('refuses bytes that are not an image it knows', () => {
  assert.equal(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null);
  assert.equal(imageSize(Buffer.alloc(0)), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), null);
});
