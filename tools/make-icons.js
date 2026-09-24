/* Génère les icônes PNG de l'appli (sans dépendance) : node tools/make-icons.js
   Motif : fond sombre, trois barres montantes (DCA) et une courbe de croissance. */
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BG = [13, 13, 13], BAR = [57, 135, 229], LINE = [25, 158, 112];
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** scale < 1 : contenu réduit (zone de sécurité des icônes « maskable »). */
function draw(scale) {
  return (x, y, S) => {
    // coordonnées normalisées 0..1 centrées
    const u = 0.5 + (x / S - 0.5) / scale, v = 0.5 + (y / S - 0.5) / scale;
    const aa = 1 / (S * scale); // largeur d'anticrénelage en unités normalisées
    let col = BG;
    // Barres (x0, largeur, hauteur) posées sur y = 0.78
    for (const [x0, h] of [[0.22, 0.18], [0.42, 0.30], [0.62, 0.44]]) {
      const w = 0.14, base = 0.78, top = base - h;
      const dx = Math.max(x0 - u, u - (x0 + w), 0), dy = Math.max(top - v, v - base, 0);
      const d = Math.hypot(dx, dy) - 0.0; // rectangle net
      if (d < aa) col = mix(col, BAR, Math.min(1, (aa - d) / aa));
    }
    // Courbe de croissance
    const pts = [[0.18, 0.56], [0.40, 0.44], [0.58, 0.34], [0.82, 0.18]];
    let d = Infinity;
    for (let i = 0; i < pts.length - 1; i++) d = Math.min(d, distSeg(u, v, ...pts[i], ...pts[i + 1]));
    const half = 0.028;
    if (d < half + aa) col = mix(col, LINE, Math.min(1, (half + aa - d) / aa));
    return col;
  };
}

const out = path.join(__dirname, '..', 'icons');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-192.png'), png(192, draw(1)));
fs.writeFileSync(path.join(out, 'icon-512.png'), png(512, draw(1)));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), png(180, draw(1)));
fs.writeFileSync(path.join(out, 'icon-maskable-512.png'), png(512, draw(0.8)));
console.log('Icônes générées dans', out);
