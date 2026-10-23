// Generates icon.png: the base icon (scripts/icon-base.png) with a terminal badge in the bottom-right.
// Run: npm run icon
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── minimal PNG decode (8-bit RGBA, non-interlaced) ──
function decode(buf) {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) throw new Error('expected 8-bit RGBA, non-interlaced PNG');
  const idat = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    if (type === 'IDAT') idat.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4, px = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? px[y * stride + x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? px[(y - 1) * stride + x - 4] : 0;
      let p;
      if (f === 0) p = v;
      else if (f === 1) p = v + a;
      else if (f === 2) p = v + b;
      else if (f === 3) p = v + ((a + b) >> 1);
      else { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); p = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); }
      px[y * stride + x] = p & 255;
    }
  }
  return { w, h, px };
}

// ── PNG encode ──
const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
function encode({ w, h, px }) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) px.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── badge geometry (relative to a 256 canvas, scaled to the image) ──
const seg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const rrect = (px, py, x, y, w, h, r) => {
  const qx = Math.abs(px - (x + w / 2)) - w / 2 + r, qy = Math.abs(py - (y + h / 2)) - h / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
// Same colours as the base icon: Claude orange #D97757 and cream #FAF9F5
const ORANGE = [217, 119, 87], CREAM = [250, 249, 245], WHITE = CREAM, INK = ORANGE;
// Fully inside the round base: the farthest corner point stays ~8px inside the circle (r = 128).
const B = { x: 136, y: 136, s: 80, r: 24, ring: 6 };
function badge(x, y) {
  const outer = rrect(x, y, B.x - B.ring, B.y - B.ring, B.s + 2 * B.ring, B.s + 2 * B.ring, B.r + B.ring);
  if (outer > 0) return null;
  if (rrect(x, y, B.x, B.y, B.s, B.s, B.r) > 0) return WHITE; // separation ring
  const cx = B.x, cy = B.y;
  const chev = Math.min(seg(x, y, cx + 19, cy + 24, cx + 37, cy + 40), seg(x, y, cx + 37, cy + 40, cx + 19, cy + 56));
  if (chev <= 5.5 || seg(x, y, cx + 45, cy + 56, cx + 62, cy + 56) <= 5.5) return CREAM;
  return INK;
}

const base = decode(fs.readFileSync(path.join(__dirname, 'icon-base.png')));
const k = 256 / base.w, SS = 4;
for (let y = 0; y < base.h; y++) {
  for (let x = 0; x < base.w; x++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
      const c = badge((x + (sx + 0.5) / SS) * k, (y + (sy + 0.5) / SS) * k);
      if (c) { r += c[0]; g += c[1]; b += c[2]; n++; }
    }
    if (!n) continue;
    const a = n / (SS * SS), i = (y * base.w + x) * 4, ba = base.px[i + 3] / 255;
    const outA = a + ba * (1 - a);
    base.px[i] = Math.round((r / n * a + base.px[i] * ba * (1 - a)) / outA);
    base.px[i + 1] = Math.round((g / n * a + base.px[i + 1] * ba * (1 - a)) / outA);
    base.px[i + 2] = Math.round((b / n * a + base.px[i + 2] * ba * (1 - a)) / outA);
    base.px[i + 3] = Math.round(outA * 255);
  }
}
fs.writeFileSync(path.join(__dirname, '..', 'icon.png'), encode(base));
console.log('icon.png written');
