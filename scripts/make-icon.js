// Generates icon.png (original artwork: terminal prompt + sound waves). Run: node scripts/make-icon.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const SS = 4; // supersampling

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function roundRectDist(px, py, x, y, w, h, r) {
  const cx = x + w / 2, cy = y + h / 2;
  const qx = Math.abs(px - cx) - w / 2 + r;
  const qy = Math.abs(py - cy) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function arcDist(px, py, cx, cy, radius, a0, a1) {
  const ang = Math.atan2(py - cy, px - cx);
  if (ang >= a0 && ang <= a1) return Math.abs(Math.hypot(px - cx, py - cy) - radius);
  const e0 = [cx + radius * Math.cos(a0), cy + radius * Math.sin(a0)];
  const e1 = [cx + radius * Math.cos(a1), cy + radius * Math.sin(a1)];
  return Math.min(Math.hypot(px - e0[0], py - e0[1]), Math.hypot(px - e1[0], py - e1[1]));
}

function mix(a, b, t) { return a.map((v, i) => v + (b[i] - v) * t); }

function sample(x, y) {
  // returns [r,g,b,a] in 0..1
  if (roundRectDist(x, y, 8, 8, 240, 240, 52) > 0) return [0, 0, 0, 0];
  const t = (x + y) / (2 * S);
  let c = mix([0.07, 0.20, 0.33], [0.05, 0.47, 0.52], t); // deep navy -> teal

  const white = [0.96, 0.98, 1.0];
  const accent = [0.99, 0.80, 0.30]; // amber
  const w = 11; // half stroke width

  // ">" chevron
  const chev = Math.min(segDist(x, y, 58, 92, 112, 136), segDist(x, y, 112, 136, 58, 180));
  // "_" cursor
  const under = segDist(x, y, 128, 180, 178, 180);
  if (chev <= w || under <= w) c = white;

  // sound waves (top-right)
  const cx = 146, cy = 98;
  const a0 = -Math.PI / 3.2, a1 = Math.PI / 3.2;
  const waves = Math.min(arcDist(x, y, cx, cy, 34, a0, a1), arcDist(x, y, cx, cy, 62, a0, a1));
  if (waves <= 8) c = accent;
  return [...c, 1];
}

const px = Buffer.alloc(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    let acc = [0, 0, 0, 0];
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const s = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        acc = [acc[0] + s[0] * s[3], acc[1] + s[1] * s[3], acc[2] + s[2] * s[3], acc[3] + s[3]];
      }
    }
    const n = SS * SS, a = acc[3] / n, i = (y * S + x) * 4;
    px[i] = a ? Math.round((acc[0] / acc[3]) * 255) : 0;
    px[i + 1] = a ? Math.round((acc[1] / acc[3]) * 255) : 0;
    px[i + 2] = a ? Math.round((acc[2] / acc[3]) * 255) : 0;
    px[i + 3] = Math.round(a * 255);
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, '..', 'icon.png'), png);
console.log('icon.png written');
