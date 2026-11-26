// x-helios v5 header builder (ported from openhongguo internal/protocol/sign/helios.go).
import {
  add64,
  base64Encode,
  concatBytes,
  le32,
  readU64LE,
  ror64,
  utf8Bytes,
  writeU64LE,
  xor64,
} from "../crypto/bytes.js";
import { APP_ID, PLAYBACK_V5_LICENSE } from "./const.js";
import { pkcs7Pad16 } from "./prim.js";

function diffuse(words) {
  const table = [words[0]];
  let b0 = words[0];
  let b8 = words[1];
  const queue = words.slice(2);
  for (let i = 0; i < 34; i++) {
    let x8 = add64(ror64(b8, 8), b0);
    x8 = xor64(x8, [0, i]);
    queue.push(x8);
    x8 = xor64(x8, ror64(b0, 61));
    table.push(x8);
    b0 = x8;
    b8 = queue.shift();
  }
  return table;
}

export function heliosV5(ts, random) {
  const seedHex = host.crypto.md5(concatBytes(le32(random >>> 0), utf8Bytes(APP_ID)));
  const ascii = utf8Bytes(seedHex);
  const words = [];
  for (let i = 0; i < 4; i++) {
    words.push(readU64LE(ascii, i * 8));
  }
  const table = diffuse(words);
  const text = pkcs7Pad16(utf8Bytes(`${ts >>> 0}-${PLAYBACK_V5_LICENSE}-${APP_ID}`));
  const parts = [le32(random >>> 0)];
  for (let at = 0; at < text.length; at += 16) {
    let a = readU64LE(text, at);
    let b = readU64LE(text, at + 8);
    for (let r = 0; r < 34; r++) {
      b = xor64(table[r], add64(a, ror64(b, 8)));
      a = xor64(b, ror64(a, 61));
    }
    const block = new Uint8Array(16);
    writeU64LE(block, 0, a);
    writeU64LE(block, 8, b);
    parts.push(block);
  }
  return base64Encode(concatBytes(...parts));
}
