// Deterministic fixture-image generator: pure Node (zlib), no binaries.
// PNG encoder (signature / IHDR / IDAT / IEND) with solid or gradient RGB.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([td, data])));
  return Buffer.concat([len, td, data, crc]);
}

/** RGB hearty gradient/solid PNG. variant: "solid" | "gradient". */
export function pngBuffer(w, h, variant = "gradient") {
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const o = y * (1 + w * 3) + 1 + x * 3;
      if (variant === "solid") {
        raw[o] = 10;
        raw[o + 1] = 122;
        raw[o + 2] = 107; // ImagineGenie teal
      } else {
        raw[o] = Math.round((x / Math.max(1, w - 1)) * 255);
        raw[o + 1] = Math.round((y / Math.max(1, h - 1)) * 200) + 20;
        raw[o + 2] = 140;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function pngDataUrl(w, h, variant) {
  return `data:image/png;base64,${pngBuffer(w, h, variant).toString("base64")}`;
}
