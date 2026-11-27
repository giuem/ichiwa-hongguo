// Bitwise and hashing primitives for request signing (ported from openhongguo internal/protocol/sign/prim.go).
import { fromNumber64 } from "../crypto/bytes.js";

export function rol32(v, count) {
  const n = count & 31;
  if (n === 0) return v >>> 0;
  return ((v << n) | (v >>> (32 - n))) >>> 0;
}

export function ror32(v, count) {
  const n = count & 31;
  if (n === 0) return v >>> 0;
  return ((v >>> n) | (v << (32 - n))) >>> 0;
}

export function ror8(v, count) {
  const n = count & 7;
  const b = v & 0xff;
  return ((b >>> n) | (b << (8 - n))) & 0xff;
}

export function reverseBits(value) {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    result = ((result << 1) | ((value >>> i) & 1)) & 0xff;
  }
  return result;
}

export function zigzag64(value) {
  const [hi, lo] = fromNumber64(value);
  const sLo = (lo << 1) >>> 0;
  const sHi = ((hi << 1) | (lo >>> 31)) >>> 0;
  const sign = (hi & 0x80000000) !== 0 ? 0xffffffff : 0;
  return [(sHi ^ sign) >>> 0, (sLo ^ sign) >>> 0];
}

export function getIV(iv, data) {
  let value = iv >>> 0;
  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if ((i & 1) === 0) {
      value = ((value >>> 4) ^ value ^ ((value << 6) >>> 0) ^ b) >>> 0;
    } else {
      const inner = ((value >>> 7) ^ value ^ (b | ((value << 12) >>> 0))) >>> 0;
      value = (~inner) >>> 0;
    }
  }
  return value;
}

export function sumMD5(data) {
  let check = 0x20220420;
  for (let i = 0; i < 12; i++) {
    let temp;
    if ((i & 1) === 0) {
      temp = ((check >>> 3) ^ check) >>> 0;
      check = (data[i] ^ ((check << 7) >>> 0)) >>> 0;
    } else {
      temp = ((check >>> 5) ^ check) >>> 0;
      check = (data[i] | ((check << 11) >>> 0)) >>> 0;
      check = (~check) >>> 0;
    }
    check = (check ^ temp) >>> 0;
  }
  return ((check | 4) ^ 0x01000000) >>> 0;
}

export function pkcs7Pad16(data) {
  const pad = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + pad);
  out.set(data, 0);
  out.fill(pad, data.length);
  return out;
}
