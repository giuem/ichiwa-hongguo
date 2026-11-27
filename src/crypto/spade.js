// CENC content key derivation from spade_a (ported from openhongguo internal/drm/spade.go).

function bits8(v) {
  let x = v & 0xff;
  let n = 0;
  while (x !== 0) {
    x &= x - 1;
    n++;
  }
  return n;
}

function popcount(v) {
  return (
    bits8(v & 0xff) +
    bits8((v >>> 8) & 0xff) +
    bits8((v >>> 16) & 0xff) +
    bits8((v >>> 24) & 0xff)
  );
}

function hexDigit(c) {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

function scramble(buf, v2) {
  if (v2) {
    const last = buf.length - 1;
    for (let i = 0; i + 1 < buf.length; i += 2) {
      const tmp = buf[i];
      buf[i] = buf[i + 1];
      buf[i + 1] = tmp;
      if (i === last - 2) {
        break;
      }
    }
  }
  let prev = 0x55;
  let cur = 0xfa;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const term = (-(0x15 + popcount(i >>> 0))) & 0xff;
    if ((i & 1) === 0) {
      if (v2) {
        buf[i] = ((cur ^ b) - prev + term) & 0xff;
      } else {
        buf[i] = (term + (cur ^ b)) & 0xff;
      }
      cur = b;
    } else {
      if (v2) {
        buf[i] = ((prev ^ b) - prev + term) & 0xff;
      } else {
        buf[i] = (term + (prev ^ b)) & 0xff;
      }
      prev = b;
    }
  }
}

export function deriveContentKey(spadeA) {
  const trimmed = String(spadeA || "").trim();
  if (!trimmed || !/^[A-Za-z0-9+/=]+$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error("drm: unrecognized key material");
  }
  let raw;
  try {
    raw = host.encoding.fromBase64(trimmed);
  } catch {
    throw new Error("drm: unrecognized key material");
  }
  if (raw.length < 4) {
    throw new Error("drm: unrecognized key material");
  }
  const marker = raw[0] ^ raw[1] ^ raw[2];
  const prefixLen = marker - 0x30;
  if (prefixLen < 1 || prefixLen > raw.length) {
    throw new Error("drm: unrecognized key material");
  }
  const outLen = raw.length - marker + 0x2f;
  if (outLen < 2 || 1 + outLen > raw.length) {
    throw new Error("drm: unrecognized key material");
  }
  const buf = new Uint8Array(raw.subarray(1, 1 + outLen));

  const tail = raw.length - prefixLen;
  if (tail - 2 < 0 || tail > raw.length) {
    throw new Error("drm: unrecognized key material");
  }
  const b16 = raw[tail - 2];
  const b14 = raw[tail - 1];
  const tag = new Uint8Array(prefixLen);
  for (let i = 0; i < prefixLen; i++) {
    if (i + tail >= raw.length) {
      throw new Error("drm: unrecognized key material");
    }
    tag[i] = b14 ^ b16 ^ raw[i + tail];
  }
  let tagText = "";
  for (let i = 0; i < tag.length; i++) {
    tagText += String.fromCharCode(tag[i]);
  }
  scramble(buf, tagText.startsWith("app_v2") || tagText.startsWith("web_v2"));

  const versionLen = hexDigit(buf[0]);
  if (versionLen < 1 || versionLen >= outLen) {
    throw new Error("drm: unrecognized key material");
  }
  const keyLen = outLen - versionLen;
  let hexKey = "";
  for (let i = 1; i < keyLen; i++) {
    if (hexDigit(buf[i]) < 0) {
      throw new Error("drm: unrecognized key material");
    }
    hexKey += String.fromCharCode(buf[i]);
  }
  if (hexKey === "" || hexKey.length % 2 !== 0) {
    throw new Error("drm: unrecognized key material");
  }
  let version = "";
  for (let i = keyLen; i < outLen; i++) {
    version += String.fromCharCode(buf[i]);
  }
  return { hex: hexKey.toLowerCase(), version };
}
