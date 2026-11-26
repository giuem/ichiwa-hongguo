// Pure JS GM/T 0004-2012 SM3 hash.
import { readU32BE, writeU32BE } from "./bytes.js";

function rol32(v, n) {
  const k = n & 31;
  return k === 0 ? v >>> 0 : ((v << k) | (v >>> (32 - k))) >>> 0;
}

function sm3FF(j, x, y, z) {
  if (j < 16) return (x ^ y ^ z) >>> 0;
  return ((x & y) | (x & z) | (y & z)) >>> 0;
}

function sm3GG(j, x, y, z) {
  if (j < 16) return (x ^ y ^ z) >>> 0;
  return ((x & y) | (~x & z)) >>> 0;
}

function sm3P0(x) {
  return (x ^ rol32(x, 9) ^ rol32(x, 17)) >>> 0;
}

function sm3P1(x) {
  return (x ^ rol32(x, 15) ^ rol32(x, 23)) >>> 0;
}

export function sm3Sum(msg) {
  const data = msg instanceof Uint8Array ? msg : host.encoding.utf8(String(msg));
  const len = data.length;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(data, 0);
  padded[len] = 0x80;
  const bitLen = len * 8;
  writeU32BE(padded, paddedLen - 8, Math.floor(bitLen / 0x100000000) >>> 0);
  writeU32BE(padded, paddedLen - 4, bitLen >>> 0);

  const h = new Uint32Array([
    0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
    0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
  ]);
  const w = new Uint32Array(68);
  const wp = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = readU32BE(padded, off + i * 4);
    }
    for (let j = 16; j < 68; j++) {
      const x = (w[j - 16] ^ w[j - 9] ^ rol32(w[j - 3], 15)) >>> 0;
      w[j] = (sm3P1(x) ^ rol32(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }
    for (let j = 0; j < 64; j++) {
      wp[j] = (w[j] ^ w[j + 4]) >>> 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let j = 0; j < 64; j++) {
      const tj = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rol32((rol32(a, 12) + e + rol32(tj, j)) >>> 0, 7);
      const ss2 = (ss1 ^ rol32(a, 12)) >>> 0;
      const tt1 = (sm3FF(j, a, b, c) + d + ss2 + wp[j]) >>> 0;
      const tt2 = (sm3GG(j, e, f, g) + hh + ss1 + w[j]) >>> 0;
      d = c;
      c = rol32(b, 9);
      b = a;
      a = tt1;
      hh = g;
      g = rol32(f, 19);
      f = e;
      e = sm3P0(tt2);
    }

    h[0] = (h[0] ^ a) >>> 0;
    h[1] = (h[1] ^ b) >>> 0;
    h[2] = (h[2] ^ c) >>> 0;
    h[3] = (h[3] ^ d) >>> 0;
    h[4] = (h[4] ^ e) >>> 0;
    h[5] = (h[5] ^ f) >>> 0;
    h[6] = (h[6] ^ g) >>> 0;
    h[7] = (h[7] ^ hh) >>> 0;
  }

  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    writeU32BE(out, i * 4, h[i]);
  }
  return out;
}
