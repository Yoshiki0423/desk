/* ホーム画面用のアイコン（PNG）を作る。外部の道具は使わない（node の zlib だけ）。
 * 使い方：node tools/make-icons.js  → icons/icon-180.png・icon-192.png・icon-512.png
 * 絵：青い地に、白い机（天板と脚）と、机に載った紙1枚。 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const BG = [0x1b, 0x5e, 0x9b], FG = [0xff, 0xff, 0xff], PAPER = [0xe1, 0xed, 0xf7];

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
function png(size) {
  const s = size / 100; // 100 × 100 の座標で描いて拡大する
  const inRect = (x, y, x0, y0, x1, y1) => x >= x0 * s && x < x1 * s && y >= y0 * s && y < y1 * s;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let c = BG;
      if (inRect(x, y, 34, 30, 60, 50)) c = PAPER;            // 紙
      if (inRect(x, y, 18, 50, 82, 58)) c = FG;               // 天板
      if (inRect(x, y, 24, 58, 31, 76) || inRect(x, y, 69, 58, 76, 76)) c = FG; // 脚
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
for (const n of [180, 192, 512]) fs.writeFileSync(path.join(__dirname, "..", "icons", `icon-${n}.png`), png(n));
console.log("icons を作りました");
