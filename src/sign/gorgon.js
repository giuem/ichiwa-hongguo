// x-gorgon header builder (ported from openhongguo internal/protocol/sign/gorgon.go).
import { be32, concatBytes, hexEncode, le32, md5Bytes, utf8Bytes } from "../crypto/bytes.js";
import { MEDUSA_EMULATOR_FLAGS, MEDUSA_V5_SDK_CODE } from "./const.js";
import { reverseBits } from "./prim.js";

function rc4Gorgon(data, key) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    s[i] = s[j];
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let idx = 0; idx < data.length; idx++) {
    i = (i + 1) & 0xff;
    const x = s[i];
    j = (j + x) & 0xff;
    const y = s[j];
    s[i] = y;
    out[idx] = data[idx] ^ s[(y + y) & 0xff];
  }
  return out;
}

export function xGorgonFlags(query, body, hasBody, khronos, random, flags) {
  const queryMD5 = md5Bytes(utf8Bytes(query));
  const bodyMD5 = hasBody ? md5Bytes(body) : new Uint8Array(16);
  const input = concatBytes(
    queryMD5.subarray(0, 4),
    bodyMD5.subarray(0, 4),
    new Uint8Array(4),
    le32(MEDUSA_V5_SDK_CODE),
    be32(khronos)
  );
  const key = new Uint8Array([
    0x4a,
    flags[0],
    0x16,
    (random >>> 8) & 0xff,
    0x47,
    0x6c,
    flags[1],
    random & 0xff,
  ]);
  const out = rc4Gorgon(input, key);
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const value = out[i];
    const swapped = ((value >>> 4) | (value << 4)) & 0xff;
    const next = i + 1 < n ? out[i + 1] : out[0];
    out[i] = (~(reverseBits(next ^ swapped) ^ 20)) & 0xff;
  }
  const prefix = new Uint8Array([
    0x84,
    0x04,
    random & 0xff,
    (random >>> 8) & 0xff,
    flags[0],
    flags[1],
  ]);
  return hexEncode(concatBytes(prefix, out));
}

export function xGorgon(query, body, hasBody, khronos, random) {
  return xGorgonFlags(query, body, hasBody, khronos, random, MEDUSA_EMULATOR_FLAGS);
}
