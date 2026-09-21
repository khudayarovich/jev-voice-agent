/**
 * Generates macOS menu-bar "Template" icons.
 *
 * Template images must be black pixels carrying shape in the ALPHA channel;
 * macOS then tints them automatically for light/dark menu bars and for the
 * highlighted (clicked) state. The filename must end in `Template` and ship a
 * matching `@2x`, or the tinting and the retina rendering both fail.
 *
 * Everything is rendered at 8x and box-downsampled, which is a cheap way to get
 * clean antialiasing without pulling in a canvas dependency.
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../resources/icons");
const SS = 8; // supersampling factor

// --- tiny alpha rasterizer -------------------------------------------------

class Mask {
  constructor(size) {
    this.n = size * SS;
    this.a = new Float32Array(this.n * this.n);
  }
  _px(x, y, v) {
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    const i = y * this.n + x;
    if (v > this.a[i]) this.a[i] = v;
  }
  rect(x, y, w, h, v = 1) {
    const n = this.n;
    const x0 = Math.round(x * n), y0 = Math.round(y * n);
    const x1 = Math.round((x + w) * n), y1 = Math.round((y + h) * n);
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this._px(xx, yy, v);
  }
  roundRect(x, y, w, h, r, v = 1) {
    const n = this.n;
    const X0 = x * n, Y0 = y * n, W = w * n, H = h * n, R = Math.min(r * n, W / 2, H / 2);
    for (let yy = Math.floor(Y0); yy < Math.ceil(Y0 + H); yy++) {
      for (let xx = Math.floor(X0); xx < Math.ceil(X0 + W); xx++) {
        const cx = Math.min(Math.max(xx + 0.5, X0 + R), X0 + W - R);
        const cy = Math.min(Math.max(yy + 0.5, Y0 + R), Y0 + H - R);
        const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy;
        if (dx * dx + dy * dy <= R * R) this._px(xx, yy, v);
      }
    }
  }
  circle(cx, cy, r, v = 1) {
    const n = this.n, CX = cx * n, CY = cy * n, R = r * n;
    for (let yy = Math.floor(CY - R); yy <= Math.ceil(CY + R); yy++)
      for (let xx = Math.floor(CX - R); xx <= Math.ceil(CX + R); xx++) {
        const dx = xx + 0.5 - CX, dy = yy + 0.5 - CY;
        if (dx * dx + dy * dy <= R * R) this._px(xx, yy, v);
      }
  }
  ring(cx, cy, r, thickness, v = 1, a0 = 0, a1 = Math.PI * 2) {
    const n = this.n, CX = cx * n, CY = cy * n, R = r * n, T = (thickness * n) / 2;
    for (let yy = Math.floor(CY - R - T); yy <= Math.ceil(CY + R + T); yy++)
      for (let xx = Math.floor(CX - R - T); xx <= Math.ceil(CX + R + T); xx++) {
        const dx = xx + 0.5 - CX, dy = yy + 0.5 - CY;
        const d = Math.hypot(dx, dy);
        if (Math.abs(d - R) > T) continue;
        let ang = Math.atan2(dy, dx);
        if (ang < 0) ang += Math.PI * 2;
        if (a1 > a0 ? ang >= a0 && ang <= a1 : ang >= a0 || ang <= a1) this._px(xx, yy, v);
      }
  }
  line(x0, y0, x1, y1, thickness, v = 1) {
    const n = this.n, T = (thickness * n) / 2;
    const ax = x0 * n, ay = y0 * n, bx = x1 * n, by = y1 * n;
    const minX = Math.floor(Math.min(ax, bx) - T), maxX = Math.ceil(Math.max(ax, bx) + T);
    const minY = Math.floor(Math.min(ay, by) - T), maxY = Math.ceil(Math.max(ay, by) + T);
    const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1;
    for (let yy = minY; yy <= maxY; yy++)
      for (let xx = minX; xx <= maxX; xx++) {
        const px = xx + 0.5 - ax, py = yy + 0.5 - ay;
        const t = Math.max(0, Math.min(1, (px * vx + py * vy) / len2));
        const d = Math.hypot(px - vx * t, py - vy * t);
        if (d <= T) this._px(xx, yy, v);
      }
  }
  /** Box-downsample to `size` and emit RGBA (black + computed alpha). */
  toRGBA(size) {
    const out = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        let s = 0;
        for (let sy = 0; sy < SS; sy++)
          for (let sx = 0; sx < SS; sx++) s += this.a[(y * SS + sy) * this.n + (x * SS + sx)];
        const a = Math.round((s / (SS * SS)) * 255);
        const i = (y * size + x) * 4;
        out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = a;
      }
    return out;
  }
}

// --- minimal PNG encoder ---------------------------------------------------

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- glyphs ----------------------------------------------------------------

/** Classic microphone silhouette. `solid` fills the capsule, else outlines it. */
function mic(m, { solid = false, alpha = 1 } = {}) {
  const cx = 0.5;
  if (solid) {
    m.roundRect(cx - 0.135, 0.13, 0.27, 0.40, 0.135, alpha);
  } else {
    // outline = big capsule minus an inset one, drawn as a ring-ish stroke
    const t = 0.075;
    m.roundRect(cx - 0.135, 0.13, 0.27, 0.40, 0.135, alpha);
    const inner = new Mask(m.n / SS);
    inner.roundRect(cx - 0.135 + t, 0.13 + t, 0.27 - 2 * t, 0.40 - 2 * t, 0.135 - t, 1);
    for (let i = 0; i < m.a.length; i++) if (inner.a[i] > 0) m.a[i] = 0;
  }
  // cradle arc, stem, base
  m.ring(cx, 0.47, 0.215, 0.075, alpha, Math.PI * 0.08, Math.PI * 0.92);
  m.rect(cx - 0.037, 0.68, 0.074, 0.13, alpha);
  m.roundRect(cx - 0.16, 0.80, 0.32, 0.075, 0.037, alpha);
}

const GLYPHS = {
  // armed and waiting
  idle: (m) => mic(m, { solid: false }),
  // listening turned off
  disabled: (m) => {
    mic(m, { solid: false, alpha: 0.42 });
    m.line(0.16, 0.16, 0.84, 0.84, 0.085, 0.95);
  },
  // capturing speech: an equalizer reads as "hearing" far better than a mic at 16px
  listening: (m) => {
    const bars = [0.30, 0.52, 0.72, 0.46, 0.24];
    bars.forEach((h, i) => {
      const x = 0.115 + i * 0.1725;
      m.roundRect(x - 0.043, 0.5 - h / 2, 0.086, h, 0.043);
    });
  },
  // transcribing / asking Jev
  thinking: (m) => {
    for (let i = 0; i < 3; i++) m.circle(0.22 + i * 0.28, 0.5, 0.085);
  },
  // running the action
  executing: (m) => mic(m, { solid: true }),
  // waiting for a spoken yes/no
  confirming: (m) => {
    mic(m, { solid: false });
    // badge: knock out a gap, then a solid dot, so it reads on any background
    const hole = new Mask(m.n / SS);
    hole.circle(0.80, 0.21, 0.225, 1);
    for (let i = 0; i < m.a.length; i++) if (hole.a[i] > 0) m.a[i] = 0;
    m.circle(0.80, 0.21, 0.155);
  },
  // something failed
  error: (m) => {
    m.roundRect(0.5 - 0.06, 0.16, 0.12, 0.44, 0.06);
    m.circle(0.5, 0.75, 0.085);
  },
};

mkdirSync(OUT, { recursive: true });
let count = 0;
for (const [name, draw] of Object.entries(GLYPHS)) {
  for (const [size, suffix] of [[16, ""], [32, "@2x"]]) {
    const m = new Mask(size);
    draw(m);
    writeFileSync(path.join(OUT, `${name}Template${suffix}.png`), png(m.toRGBA(size), size));
    count++;
  }
}
console.log(`[icons] wrote ${count} files to resources/icons`);
