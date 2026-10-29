import { deflateSync, inflateSync } from "node:zlib";

/** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
export interface Raster { width: number; height: number; data: Uint8Array }

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) for (let i = 0; i < part.length; i++) c = CRC_TABLE[(c ^ part[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(head.subarray(4), body), 0);
  return Buffer.concat([head, body, tail]);
}

/** Encode 8-bit RGBA. Level 1 deflate: scenes are mostly transparent, so it is both fast and small. */
export function encodePng({ width, height, data }: Raster): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Decode the PNGs this project ships: 8-bit, non-interlaced, palette (with optional tRNS) or RGB/RGBA. */
export function decodePng(file: Uint8Array): Raster {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array = new Uint8Array(0), trns: Uint8Array = new Uint8Array(0);
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at), type = buf.toString("ascii", at + 4, at + 8), body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]!; colorType = body[9]!; interlace = body[12]!; }
    else if (type === "PLTE") palette = body;
    else if (type === "tRNS") trns = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (interlace !== 0 || ![1, 2, 4, 8].includes(depth) || (depth !== 8 && colorType !== 3)) throw new Error("unsupported PNG");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error("unsupported PNG color type");
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const raw = inflateSync(Buffer.concat(idat));
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? rows[y * stride + x - bpp]! : 0;
      const up = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? rows[(y - 1) * stride + x - bpp]! : 0;
      let value = src[x]!;
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      rows[y * stride + x] = value & 0xff;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const out = (y * width + x) * 4;
      if (colorType === 3) {
        let index: number;
        if (depth === 8) index = rows[y * stride + x]!;
        else { const bit = x * depth; index = (rows[y * stride + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1); }
        data[out] = palette[index * 3]!; data[out + 1] = palette[index * 3 + 1]!; data[out + 2] = palette[index * 3 + 2]!;
        data[out + 3] = index < trns.length ? trns[index]! : 255;
      } else {
        const at = y * stride + x * channels;
        if (colorType === 6) data.set(rows.subarray(at, at + 4), out);
        else if (colorType === 2) { data[out] = rows[at]!; data[out + 1] = rows[at + 1]!; data[out + 2] = rows[at + 2]!; data[out + 3] = 255; }
        else { data[out] = data[out + 1] = data[out + 2] = rows[at]!; data[out + 3] = colorType === 4 ? rows[at + 1]! : 255; }
      }
    }
  }
  return { width, height, data };
}
