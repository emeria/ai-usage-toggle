// Generates icon.png (128x128): a flat toggle switch. Run: node scripts/make-icon.mjs
import fs from 'node:fs';
import zlib from 'node:zlib';

const N = 128;
const SS = 4; // supersampling per axis
const BG = [15, 118, 110];
const PILL = [245, 245, 244];
const KNOB = [15, 118, 110];

const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

function sample(x, y) {
  if (!inRoundRect(x, y, 0, 0, N, N, 26)) {
    return [0, 0, 0, 0];
  }
  if (inRoundRect(x, y, 20, 42, 108, 86, 22)) {
    return (x - 84) ** 2 + (y - 64) ** 2 <= 15 ** 2 ? [...KNOB, 255] : [...PILL, 255];
  }
  return [...BG, 255];
}

const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) {
  raw[y * (N * 4 + 1)] = 0;
  for (let x = 0; x < N; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [pr, pg, pb, pa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
      }
    }
    const o = y * (N * 4 + 1) + 1 + x * 4;
    raw[o] = a ? Math.round(r / a) : 0;
    raw[o + 1] = a ? Math.round(g / a) : 0;
    raw[o + 2] = a ? Math.round(b / a) : 0;
    raw[o + 3] = Math.round(a / (SS * SS));
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0);
ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
fs.writeFileSync(
  'icon.png',
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]),
);
