// Legacy playback Argus 551 (Simon 64/128 + AES-128-CBC) and Ladon headers
// (ported from openhongguo internal/protocol/sign/playback.go).
import {
  add64,
  and64,
  base64Encode,
  concatBytes,
  le32,
  not64,
  readU64LE,
  rol64,
  ror64,
  utf8Bytes,
  writeU64LE,
  xor64,
} from "../crypto/bytes.js";
import { sm3Sum } from "../crypto/sm3.js";
import {
  ARGUS_MASK,
  ARGUS_TAIL,
  PLAYBACK_LICENSE_ID,
  getArgusAESIV,
  getArgusAESKey,
  getArgusSignKey,
} from "./const.js";
import { queryValue } from "./medusa.js";
import { pkcs7Pad16 } from "./prim.js";
import { pbBytes, pbString, pbVarint } from "./proto.js";

function simonKeySchedule() {
  const signKey = getArgusSignKey();
  const k = new Array(72);
  for (let i = 0; i < 4; i++) {
    k[i] = readU64LE(signKey, i * 8);
  }
  // z = 0x3dc94c3a046d678b
  const zHi = 0x3dc94c3a;
  const zLo = 0x046d678b;
  for (let i = 4; i < 72; i++) {
    let x = xor64(ror64(k[i - 1], 3), k[i - 3]);
    x = xor64(x, ror64(x, 1));
    const shift = (i - 4) % 62;
    const zBit = shift < 32 ? (zLo >>> shift) & 1 : (zHi >>> (shift - 32)) & 1;
    k[i] = xor64(xor64(not64(k[i - 4]), x), [0, (zBit ^ 3) >>> 0]);
  }
  return k;
}

function simonEncryptInPlace(plain) {
  const keys = simonKeySchedule();
  for (let at = 0; at < plain.length; at += 16) {
    let a = readU64LE(plain, at);
    let b = readU64LE(plain, at + 8);
    for (let r = 0; r < keys.length; r++) {
      const f = xor64(and64(rol64(b, 1), rol64(b, 8)), rol64(b, 2));
      const nextB = xor64(xor64(a, f), keys[r]);
      a = b;
      b = nextB;
    }
    writeU64LE(plain, at, a);
    writeU64LE(plain, at + 8, b);
  }
}

export function playbackAID(query) {
  return queryValue(query, "aid") || "1967";
}

export function argusHeader(query, bodyMD5, ts, nonce, aid, deviceID, installID) {
  const bodyHash = sm3Sum(bodyMD5);
  const queryBytes = query === "" ? new Uint8Array(16) : utf8Bytes(query);
  const queryHash = sm3Sum(queryBytes);

  const counters = concatBytes(
    pbVarint(1, 1),
    pbVarint(2, 1),
    pbVarint(3, 1),
    pbVarint(7, 0xc792eccc)
  );
  const device = concatBytes(pbString(1, "NX551J"), pbVarint(2, 8196), pbVarint(4, 0x80e0d800));
  const bean = concatBytes(
    pbVarint(1, 1077940818),
    pbVarint(2, 2),
    pbVarint(3, nonce >>> 0),
    pbString(4, aid),
    pbString(5, deviceID),
    pbString(6, PLAYBACK_LICENSE_ID),
    pbString(7, queryValue(query, "version_name")),
    pbString(8, "v04.04.05-ov-android"),
    pbVarint(9, 134744640),
    pbBytes(10, new Uint8Array(8)),
    pbVarint(11, 0),
    pbVarint(12, ((ts >>> 0) << 1) >>> 0),
    pbBytes(13, bodyHash.subarray(0, 6)),
    pbBytes(14, queryHash.subarray(0, 6)),
    pbBytes(15, counters),
    pbString(16, installID),
    pbString(20, "none"),
    pbVarint(21, 738),
    pbBytes(23, device),
    pbVarint(25, 2)
  );

  const plain = pkcs7Pad16(bean);
  simonEncryptInPlace(plain);

  const frame = concatBytes(ARGUS_MASK, plain, ARGUS_TAIL);
  for (let i = ARGUS_MASK.length; i < frame.length; i++) {
    frame[i] ^= ARGUS_MASK[i % ARGUS_MASK.length];
  }
  frame.reverse();
  const padded = pkcs7Pad16(concatBytes(frame, new Uint8Array([0x61, 0x6f])));
  const encrypted = host.crypto.aes({
    mode: "cbc",
    key: getArgusAESKey(),
    iv: getArgusAESIV(),
    data: padded,
    decrypt: false,
    padding: "none",
  });
  return base64Encode(concatBytes(new Uint8Array([0xf2, 0x81]), encrypted));
}

export function ladonHeader(ts, nonce, aid) {
  const seed = le32(nonce >>> 0);
  const hexKey = utf8Bytes(host.crypto.md5(concatBytes(seed, utf8Bytes(aid))));

  const keys = new Array(34);
  let k = readU64LE(hexKey, 0);
  let p0 = readU64LE(hexKey, 8);
  let p1 = readU64LE(hexKey, 16);
  let p2 = readU64LE(hexKey, 24);
  for (let i = 0; i < 34; i++) {
    keys[i] = k;
    const x = xor64(add64(ror64(p0, 8), k), [0, i]);
    p0 = p1;
    p1 = p2;
    p2 = x;
    k = xor64(x, rol64(k, 3));
  }

  const plain = pkcs7Pad16(utf8Bytes(`${ts >>> 0}-${PLAYBACK_LICENSE_ID}-${aid}`));
  for (let at = 0; at < plain.length; at += 16) {
    let a = readU64LE(plain, at);
    let b = readU64LE(plain, at + 8);
    for (let r = 0; r < 34; r++) {
      b = xor64(keys[r], add64(a, ror64(b, 8)));
      a = xor64(b, rol64(a, 3));
    }
    writeU64LE(plain, at, a);
    writeU64LE(plain, at + 8, b);
  }
  return base64Encode(concatBytes(seed, plain));
}
