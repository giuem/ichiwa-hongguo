// Pure JS byte, 32-bit/64-bit integer, and gzip helpers (no BigInt or Node APIs).

export function concatBytes(...parts) {
  let total = 0;
  for (const p of parts) {
    if (p) total += p.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    if (!p || p.length === 0) continue;
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function utf8Bytes(str) {
  return host.encoding.utf8(str);
}

export function fromUtf8(bytes) {
  return host.encoding.fromUtf8(bytes);
}

export function hexEncode(bytes) {
  return host.encoding.hex(bytes);
}

export function hexDecode(str) {
  return host.encoding.fromHex(str);
}

export function base64Encode(bytes) {
  return host.encoding.base64(bytes);
}

export function base64Decode(str) {
  return host.encoding.fromBase64(str);
}

export function base64UrlEncode(bytes) {
  return base64Encode(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(str) {
  return host.encoding.fromBase64(str);
}

export function md5Bytes(data) {
  return hexDecode(host.crypto.md5(data));
}

export function sha256Bytes(data) {
  return hexDecode(host.crypto.sha256(data));
}

export function readU32BE(buf, off = 0) {
  return (
    ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
  );
}

export function readU32LE(buf, off = 0) {
  return (
    (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0
  );
}

export function writeU32BE(buf, off, v) {
  buf[off] = (v >>> 24) & 0xff;
  buf[off + 1] = (v >>> 16) & 0xff;
  buf[off + 2] = (v >>> 8) & 0xff;
  buf[off + 3] = v & 0xff;
}

export function writeU32LE(buf, off, v) {
  buf[off] = v & 0xff;
  buf[off + 1] = (v >>> 8) & 0xff;
  buf[off + 2] = (v >>> 16) & 0xff;
  buf[off + 3] = (v >>> 24) & 0xff;
}

export function le32(v) {
  const b = new Uint8Array(4);
  writeU32LE(b, 0, v >>> 0);
  return b;
}

export function be32(v) {
  const b = new Uint8Array(4);
  writeU32BE(b, 0, v >>> 0);
  return b;
}

// 64-bit unsigned integer represented as [hi, lo] (two uint32 values).
export function u64(hi, lo) {
  return [hi >>> 0, lo >>> 0];
}

export function readU64LE(buf, off = 0) {
  return [readU32LE(buf, off + 4), readU32LE(buf, off)];
}

export function writeU64LE(buf, off, v) {
  writeU32LE(buf, off, v[1]);
  writeU32LE(buf, off + 4, v[0]);
}

export function readU64BE(buf, off = 0) {
  return [readU32BE(buf, off), readU32BE(buf, off + 4)];
}

export function writeU64BE(buf, off, v) {
  writeU32BE(buf, off, v[0]);
  writeU32BE(buf, off + 4, v[1]);
}

export function add64(a, b) {
  const lo = (a[1] + b[1]) >>> 0;
  const carry = lo < a[1] ? 1 : 0;
  const hi = (a[0] + b[0] + carry) >>> 0;
  return [hi, lo];
}

export function xor64(a, b) {
  return [(a[0] ^ b[0]) >>> 0, (a[1] ^ b[1]) >>> 0];
}

export function and64(a, b) {
  return [(a[0] & b[0]) >>> 0, (a[1] & b[1]) >>> 0];
}

export function not64(a) {
  return [(~a[0]) >>> 0, (~a[1]) >>> 0];
}

export function ror64(v, n) {
  const k = n & 63;
  if (k === 0) return [v[0], v[1]];
  if (k < 32) {
    return [
      ((v[0] >>> k) | (v[1] << (32 - k))) >>> 0,
      ((v[1] >>> k) | (v[0] << (32 - k))) >>> 0,
    ];
  }
  if (k === 32) return [v[1], v[0]];
  const s = k - 32;
  return [
    ((v[1] >>> s) | (v[0] << (32 - s))) >>> 0,
    ((v[0] >>> s) | (v[1] << (32 - s))) >>> 0,
  ];
}

export function rol64(v, n) {
  const k = ((n % 64) + 64) % 64;
  return k === 0 ? [v[0], v[1]] : ror64(v, 64 - k);
}

export function shr64(v, n) {
  if (n === 0) return [v[0], v[1]];
  if (n < 32) {
    return [v[0] >>> n, ((v[1] >>> n) | (v[0] << (32 - n))) >>> 0];
  }
  if (n < 64) {
    return [0, v[0] >>> (n - 32)];
  }
  return [0, 0];
}

export function fromNumber64(n) {
  const lo = n >>> 0;
  const hi = Math.floor(n / 0x100000000) >>> 0;
  return [hi, lo];
}

// Standard IEEE 802.3 CRC-32 table.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = (CRC32_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Encode raw bytes as a valid RFC 1952 gzip stream using RFC 1951 DEFLATE stored blocks.
 * Works in any JS runtime without CompressionStream or zlib.
 */
export function gzipEncode(input, mtimeSeconds = 0) {
  const data = input instanceof Uint8Array ? input : utf8Bytes(String(input));
  const maxBlock = 0xffff;
  const numBlocks = Math.max(1, Math.ceil(data.length / maxBlock));
  const out = new Uint8Array(10 + data.length + numBlocks * 5 + 8);

  // Gzip header: ID1, ID2, CM=8(deflate), FLG=0, MTIME(4), XFL=0, OS=255
  out[0] = 0x1f;
  out[1] = 0x8b;
  out[2] = 0x08;
  out[3] = 0x00;
  writeU32LE(out, 4, mtimeSeconds >>> 0);
  out[8] = 0x00;
  out[9] = 0xff;

  let pos = 10;
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const isFinal = b === numBlocks - 1 ? 1 : 0;
    const len = Math.min(maxBlock, data.length - offset);
    const nlen = (~len) & 0xffff;
    out[pos++] = isFinal; // BFINAL | BTYPE=00 (stored)
    out[pos++] = len & 0xff;
    out[pos++] = (len >>> 8) & 0xff;
    out[pos++] = nlen & 0xff;
    out[pos++] = (nlen >>> 8) & 0xff;
    if (len > 0) {
      out.set(data.subarray(offset, offset + len), pos);
      pos += len;
      offset += len;
    }
  }

  writeU32LE(out, pos, crc32(data));
  writeU32LE(out, pos + 4, data.length >>> 0);
  return out;
}
