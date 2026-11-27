// Minimal protobuf wire encoder (ported from openhongguo internal/protocol/sign/proto.go & playback.go).
import { concatBytes, fromNumber64, utf8Bytes } from "../crypto/bytes.js";
import { zigzag64 } from "./prim.js";

export function varint64(hi, lo) {
  let h = hi >>> 0;
  let l = lo >>> 0;
  const out = [];
  while (h !== 0 || l > 127) {
    out.push((l & 0x7f) | 0x80);
    l = ((l >>> 7) | (h << 25)) >>> 0;
    h = h >>> 7;
  }
  out.push(l & 0x7f);
  return new Uint8Array(out);
}

export function varint(value) {
  const [hi, lo] = fromNumber64(value);
  return varint64(hi, lo);
}

export function protoKey(tag, wire) {
  return varint(((tag >>> 0) * 8) + (wire & 7));
}

export function protoBytes(tag, body) {
  if (!body || body.length === 0) return new Uint8Array(0);
  return concatBytes(protoKey(tag, 2), varint(body.length), body);
}

export function protoString(tag, s) {
  if (!s) return new Uint8Array(0);
  return protoBytes(tag, utf8Bytes(s));
}

export function protoSInt(tag, value) {
  const [hi, lo] = zigzag64(value);
  return concatBytes(protoKey(tag, 0), varint64(hi, lo));
}

export function protoFloat(tag, value) {
  const b = new Uint8Array(4);
  const dv = new DataView(b.buffer);
  dv.setFloat32(0, value, true);
  return concatBytes(protoKey(tag, 5), b);
}

export function protoEmpty(tag) {
  return concatBytes(protoKey(tag, 2), new Uint8Array([0]));
}

// Argus 551 uses unsigned varints and always emits length-delimited fields even if empty.
export function pbVarint(tag, value) {
  return concatBytes(protoKey(tag, 0), varint(value));
}

export function pbBytes(tag, body) {
  const b = body || new Uint8Array(0);
  return concatBytes(protoKey(tag, 2), varint(b.length), b);
}

export function pbString(tag, s) {
  return pbBytes(tag, utf8Bytes(s || ""));
}
