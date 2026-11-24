import { deflateSync } from "node:zlib";

// 5x7 bitmap digits. The lab image is drawn from this, so no image library is needed.
const GLYPHS = {
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// Black digits on a white background, as an 8-bit grayscale PNG.
export function renderDigitsPng(digits, { scale = 14, margin = 3 } = {}) {
  if (!/^\d+$/.test(digits)) throw new Error("renderDigitsPng draws digits only.");
  const cell = 6;
  const width = (digits.length * cell - 1 + margin * 2) * scale;
  const height = (7 + margin * 2) * scale;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(width + 1, 255);
    row[0] = 0;
    const glyphRow = Math.floor(y / scale) - margin;
    if (glyphRow >= 0 && glyphRow < 7) {
      for (let x = 0; x < width; x += 1) {
        const column = Math.floor(x / scale) - margin;
        if (column < 0) continue;
        const index = Math.floor(column / cell);
        const within = column % cell;
        if (index < digits.length && within < 5 && GLYPHS[digits[index]][glyphRow][within] === "1") row[x + 1] = 0;
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
