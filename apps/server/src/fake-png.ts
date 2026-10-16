// Minimal PNG encoder for the fake runtime's failure screenshots (no image dependency).
import zlib from 'node:zlib';

export type Pixel = (x: number, y: number) => [number, number, number];

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** Encode an RGB image (8-bit, no alpha) from a per-pixel function. */
export function encodePng(width: number, height: number, pixel: Pixel): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * stride + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A stylised checkout page: nav bar, alert/success banner, and a card with text placeholders. */
export function screenshotPixels(kind: 'fail' | 'pass'): Pixel {
  const banner: [number, number, number] = kind === 'fail' ? [0xc0, 0x39, 0x2b] : [0x2e, 0x7d, 0x32];
  const page: [number, number, number] = [0xf5, 0xf5, 0xf7];
  const bars = [420, 300, 380, 220, 260];
  return (x, y) => {
    if (y < 40) return [0x1d, 0x1d, 0x1f];
    if (y >= 60 && y < 96 && x >= 60 && x < 580) return banner;
    if (x < 60 || x >= 580 || y < 120 || y >= 300) return page;
    const row = Math.floor((y - 136) / 26);
    if (row >= 0 && row < bars.length && (y - 136) % 26 < 9 && x >= 80 && x < 80 + bars[row]!) {
      return [0xb0, 0xb0, 0xb8];
    }
    return [0xff, 0xff, 0xff];
  };
}
