// Progressive MP4 CENC (AES-128-CTR) in-place decryptor for verifying playback keys in tests
// (ported from ichiwa internal/cenc/cenc.go).
import crypto from "node:crypto";

function u16(buf, off) {
  return (buf[off] << 8) | buf[off + 1];
}

function u32(buf, off) {
  return (
    ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
  );
}

function u64(buf, off) {
  return u32(buf, off) * 0x100000000 + u32(buf, off + 4);
}

function boxType(buf, off) {
  return String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
}

function renameBox(buf, box, typ) {
  for (let i = 0; i < 4; i++) {
    buf[box.start + 4 + i] = typ.charCodeAt(i);
  }
}

export function readBoxes(buf, start = 0, end = buf.length) {
  const out = [];
  for (let o = start; o + 8 <= end; ) {
    let size = u32(buf, o);
    const typ = boxType(buf, o + 4);
    let hdr = 8;
    if (size === 1) {
      if (o + 16 > end) throw new Error("cenc: truncated box");
      size = u64(buf, o + 8);
      hdr = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < hdr || o + size > end) {
      throw new Error(`cenc: bad ${typ} box size`);
    }
    out.push({ typ, start: o, body: o + hdr, end: o + size });
    o += size;
  }
  return out;
}

function child(buf, box, typ) {
  try {
    const kids = readBoxes(buf, box.body, box.end);
    return kids.find((k) => k.typ === typ) || null;
  } catch {
    return null;
  }
}

function boxPath(buf, box, ...types) {
  let cur = box;
  for (const t of types) {
    cur = child(buf, cur, t);
    if (!cur) return null;
  }
  return cur;
}

export function isEncryptedMP4(buf) {
  let top;
  try {
    top = readBoxes(buf, 0, buf.length);
  } catch {
    return false;
  }
  for (const b of top) {
    if (b.typ !== "moov") continue;
    const traks = readBoxes(buf, b.body, b.end);
    for (const t of traks) {
      if (t.typ !== "trak") continue;
      const stsd = boxPath(buf, t, "mdia", "minf", "stbl", "stsd");
      if (stsd && stsd.body + 16 <= stsd.end) {
        const typ = boxType(buf, stsd.body + 12);
        if (typ === "encv" || typ === "enca") return true;
      }
    }
  }
  return false;
}

function sampleTable(buf, stbl) {
  const stsz = child(buf, stbl, "stsz");
  if (!stsz) throw new Error("cenc: missing stsz");
  const uniform = u32(buf, stsz.body + 4);
  const n = u32(buf, stsz.body + 8);
  const sizes = new Array(n);
  for (let i = 0; i < n; i++) {
    sizes[i] = uniform !== 0 ? uniform : u32(buf, stsz.body + 12 + 4 * i);
  }

  const chunks = [];
  const stco = child(buf, stbl, "stco");
  const co64 = child(buf, stbl, "co64");
  if (stco) {
    const c = u32(buf, stco.body + 4);
    for (let i = 0; i < c; i++) chunks.push(u32(buf, stco.body + 8 + 4 * i));
  } else if (co64) {
    const c = u32(buf, co64.body + 4);
    for (let i = 0; i < c; i++) chunks.push(u64(buf, co64.body + 8 + 8 * i));
  } else {
    throw new Error("cenc: missing stco");
  }

  const stsc = child(buf, stbl, "stsc");
  if (!stsc) throw new Error("cenc: missing stsc");
  const ec = u32(buf, stsc.body + 4);
  const runs = [];
  for (let i = 0; i < ec; i++) {
    const b = stsc.body + 8 + 12 * i;
    runs.push({ first: u32(buf, b), per: u32(buf, b + 4) });
  }

  const offsets = [];
  let r = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    while (r + 1 < runs.length && runs[r + 1].first <= ci + 1) r++;
    if (runs.length === 0) break;
    let o = chunks[ci];
    for (let k = 0; k < runs[r].per && offsets.length < n; k++) {
      offsets.push(o);
      o += sizes[offsets.length - 1];
    }
  }
  if (offsets.length !== n) {
    throw new Error(`cenc: sample table maps ${offsets.length} of ${n} samples`);
  }
  return { offsets, sizes };
}

function decryptTrack(buf, trak, keyBuf) {
  const stbl = boxPath(buf, trak, "mdia", "minf", "stbl");
  if (!stbl) return;
  const stsd = child(buf, stbl, "stsd");
  if (!stsd || stsd.body + 8 > stsd.end) return;
  const entries = readBoxes(buf, stsd.body + 8, stsd.end);
  if (entries.length === 0) return;
  const entry = entries[0];
  let childStart;
  if (entry.typ === "encv") {
    childStart = entry.body + 78;
  } else if (entry.typ === "enca") {
    childStart = entry.body + 28;
    const ver = u16(buf, entry.body + 8);
    if (ver === 1) childStart += 16;
    else if (ver === 2) childStart += 36;
  } else {
    return;
  }
  const kids = readBoxes(buf, childStart, entry.end);
  const sinf = kids.find((k) => k.typ === "sinf");
  if (!sinf) throw new Error("cenc: protected entry without sinf");
  const frma = child(buf, sinf, "frma");
  if (!frma || frma.body + 4 > frma.end) throw new Error("cenc: missing frma");
  const schm = child(buf, sinf, "schm");
  if (schm && schm.body + 8 <= schm.end) {
    const scheme = boxType(buf, schm.body + 4);
    if (scheme !== "cenc") throw new Error(`cenc: unsupported scheme ${scheme}`);
  }
  const tenc = boxPath(buf, sinf, "schi", "tenc");
  if (!tenc || tenc.body + 24 > tenc.end) throw new Error("cenc: missing tenc");

  const defaultIVSize = buf[tenc.body + 7];
  let constIV = new Uint8Array(0);
  if (defaultIVSize === 0 && tenc.body + 25 <= tenc.end) {
    const n = buf[tenc.body + 24];
    if (tenc.body + 25 + n <= tenc.end) {
      constIV = buf.subarray(tenc.body + 25, tenc.body + 25 + n);
    }
  }

  const { offsets, sizes } = sampleTable(buf, stbl);
  const senc = child(buf, stbl, "senc");
  if (!senc) throw new Error("cenc: missing senc");

  let p = senc.body;
  const flags = u32(buf, p) & 0xffffff;
  const count = u32(buf, p + 4);
  p += 8;
  if (count > sizes.length) {
    throw new Error(`cenc: senc has ${count} samples, track has ${sizes.length}`);
  }

  const iv = Buffer.alloc(16);
  for (let i = 0; i < count; i++) {
    iv.fill(0);
    if (defaultIVSize > 0) {
      if (p + defaultIVSize > senc.end) throw new Error("cenc: truncated senc");
      iv.set(buf.subarray(p, p + defaultIVSize), 0);
      p += defaultIVSize;
    } else {
      iv.set(constIV, 0);
    }
    const off = offsets[i];
    const size = sizes[i];
    if (off + size > buf.length) throw new Error("cenc: sample outside file");

    const decipher = crypto.createDecipheriv("aes-128-ctr", keyBuf, iv);
    const sample = buf.subarray(off, off + size);
    if ((flags & 0x2) !== 0) {
      if (p + 2 > senc.end) throw new Error("cenc: truncated senc");
      const subCount = u16(buf, p);
      p += 2;
      let pos = 0;
      for (let j = 0; j < subCount; j++) {
        if (p + 6 > senc.end) throw new Error("cenc: truncated senc");
        const clearBytes = u16(buf, p);
        const protBytes = u32(buf, p + 2);
        p += 6;
        pos += clearBytes;
        if (pos + protBytes > sample.length) throw new Error("cenc: subsample outside sample");
        if (protBytes > 0) {
          const dec = decipher.update(sample.subarray(pos, pos + protBytes));
          sample.set(dec, pos);
          pos += protBytes;
        }
      }
    } else {
      const dec = decipher.update(sample);
      sample.set(dec, 0);
    }
  }

  // Restore original format and rename protection boxes to "free".
  buf.set(buf.subarray(frma.body, frma.body + 4), entry.start + 4);
  renameBox(buf, sinf, "free");
  for (const k of readBoxes(buf, stbl.body, stbl.end)) {
    if (k.typ === "senc" || k.typ === "saio" || k.typ === "saiz") {
      renameBox(buf, k, "free");
    } else if (
      (k.typ === "sgpd" || k.typ === "sbgp") &&
      k.body + 8 <= k.end &&
      boxType(buf, k.body + 4) === "seig"
    ) {
      renameBox(buf, k, "free");
    }
  }
}

export function decryptMP4InPlace(buf, keyHex) {
  if (typeof keyHex !== "string" || !/^[0-9a-fA-F]{32}$/.test(keyHex)) {
    throw new Error("cenc: key must be 32 hex characters");
  }
  const keyBuf = Buffer.from(keyHex, "hex");
  const top = readBoxes(buf, 0, buf.length);
  let moov = null;
  for (const b of top) {
    if (b.typ === "moov") moov = b;
    if (b.typ === "moof") throw new Error("cenc: fragmented MP4 is not supported");
  }
  if (!moov) throw new Error("cenc: no moov box");
  for (const t of readBoxes(buf, moov.body, moov.end)) {
    if (t.typ === "trak") decryptTrack(buf, t, keyBuf);
  }
}
