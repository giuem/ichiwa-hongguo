// Medusa field 13 v5 digest computation (ported from openhongguo internal/protocol/sign/f13.go & f13_v5.go).
import { concatBytes, le32, readU32BE, readU32LE, writeU32BE, writeU32LE } from "../crypto/bytes.js";
import { getIV, rol32, ror32, ror8 } from "./prim.js";

const BRANCH0_TT = new Uint32Array([
  0xebb64faf, 0x07aadcc2, 0xcf3187bf, 0xe01138ff, 0x6d0bfcff, 0x5a30a3be, 0xb41ad638, 0x34180eb8,
  0xf233eb6f, 0xb1a584cc, 0xccc30dc7, 0x47d1db51, 0xd55653de, 0x70a84fa1, 0x57473c12, 0xf76f0288,
  0x2c077f0a, 0xda0dcad0, 0xfbb86f6c, 0xfdc4cf00, 0x688a020d, 0xe676c6a6, 0x8cd6338b, 0x1a3c8d0e,
  0xcce8b06b, 0x6ad0ed0b, 0xa0522717, 0xdc71ac83, 0x2285db71, 0xd5b4dda6, 0x736f8650, 0x6560306c,
  0x617ce2a6, 0xe423417e, 0x0a40e143, 0x544e4032, 0x88dffb2a, 0x716c1ae0, 0x4c467a88, 0x05b23bb3,
  0xe1d0b866, 0xbaa3dcb8, 0xae3374d3, 0xc3381a50, 0x1702f75b, 0xfe6da368, 0xf0b4cf48, 0x4e0ffbb8,
  0x72aad10d, 0x26c53a3d, 0xf2bce0f6, 0xb4557581, 0x4a257fdd, 0x8c3182a2, 0xab0b3b86, 0x3d5dfb14,
  0x4f103634, 0xd37b52d7, 0x444eff16, 0xeb0a33d1, 0x6ca86f6e, 0x00284ba7, 0x08387cfa, 0x5fb37586,
]);

const BRANCH0_INIT = new Uint32Array([
  0x7aba4fc8, 0x67166507, 0x6403fa00, 0x340f512f,
  984304912, 3005047866, 2874125293, 2152413264,
]);

const F13_V5_IV = new Uint32Array([0x79e0f2fb, 0xc8b52570, 0xebc2f8cd, 0x7c104d93]);
const F13_V5_FINAL = new Uint32Array([0x19be4866, 0xe85986b4, 0xe19b326e, 0x71d1d7d4]);
const F13_V5_PAD = new Uint8Array([0x84, 0x96, 0x77, 0x9d, 0xd4, 0x15, 0x0b, 0xf8]);

const F13_V5_K = new Uint32Array([
  0xa7aefe20, 0x7149f1d6, 0x47e4ca07, 0xe9b58f67, 0x93b924de, 0xc614d0f5, 0x38afe0ef, 0xb2bbad73,
  0xe24444c3, 0x9d3aec9b, 0xdf7b37e4, 0xd8b16d40, 0xf8ac31b8, 0x76b9a90b, 0x31d833ee, 0x953fce64,
  0x6a6b2b48, 0x8c138276, 0x6d24a010, 0x18da124b, 0xbbeb82ee, 0x39f7ea56, 0x149f4fe1, 0x229946bc,
  0x0327f309, 0xf4f50e66, 0x62d569aa, 0x78419f92, 0x4db088a7, 0x7430a018, 0xf31d88f4, 0x2f4ed651,
  0x9b13fe59, 0x45c5910d, 0x374bf0ec, 0xd5a5b69e, 0xefaceb16, 0x714f4811, 0x4c98233b, 0xc9e6e7b1,
  0xd0623b3f, 0xdf5e4f6f, 0xccb31244, 0xaddab856, 0x6faf9c9e, 0x62804e10, 0x6fa7e29d, 0x7e429d51,
  0xcdb31e01, 0xb339e419, 0xe497a8a3, 0xebeca6bc, 0x1746cd57, 0xfbf4f54a, 0xd5ea2a8b, 0xb4f02ed2,
  0x0512b192, 0xefad4d29, 0xd59bec05, 0x2a1436e2, 0xfaea73c1, 0x1ebdbae8, 0x8ff257bd, 0x2d59351d,
]);

const F13_V5_ORDER = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  0, 10, 5, 14, 3, 4, 15, 13, 6, 1, 12, 8, 9, 7, 11, 2,
  8, 10, 3, 1, 14, 3, 7, 2, 5, 0, 13, 9, 11, 4, 15, 12,
  8, 9, 15, 10, 2, 6, 5, 13, 13, 1, 7, 3, 11, 14, 4, 12,
];

const F13_V5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

function expandWords(data) {
  const count = (data.length / 4) | 0;
  const di = new Uint32Array(count + 112);
  for (let i = 0; i < count; i++) {
    di[i] = readU32BE(data, i * 4);
  }
  let di0 = di[0];
  for (let i = 0; i < 112; i++) {
    const di1 = di[i + 1];
    const di14 = di[i + 14];
    const r1 = (rol32(di1, 14) ^ rol32(di1, 25) ^ (di1 >>> 3)) >>> 0;
    const r2 = (rol32(di14, 13) ^ rol32(di14, 15) ^ (di14 >>> 10)) >>> 0;
    di[count + i] = (di0 + di[i + 9] + r1 + r2) >>> 0;
    di0 = di1;
  }
  return di;
}

function mixRounds(initialState, rounds, di, tt, ivV1) {
  const state = new Uint32Array(initialState);
  const n = state.length;
  for (let i = 0; i < rounds[0]; i++) {
    const base = (ivV1 + i) >>> 0;
    const w = di[base & 127];
    const s1 = state[rounds[1]];
    const s2 = state[rounds[2]];
    const s3 = state[rounds[3]];
    const s4 = state[rounds[4]];
    const s5 = state[rounds[5]];
    const s6 = state[rounds[6]];
    const s7 = state[rounds[7]];
    const n1 = (((s3 ^ s4) & s1) ^ s3) >>> 0;
    const n2 = (rol32(s1, 26) ^ rol32(s1, 21) ^ rol32(s1, 7)) >>> 0;
    const n4 = (w + n1 + n2 + tt[base & 63] + s5) >>> 0;
    const n5 = (rol32(s2, 30) ^ rol32(s2, 19) ^ rol32(s2, 10)) >>> 0;
    const n6 = ((s2 & s6) | ((s2 | s6) & s7)) >>> 0;
    const n7 = (n5 + n6) >>> 0;
    const old = state[rounds[9]];
    const last = state[n - 1];
    for (let k = n - 1; k > 0; k--) {
      state[k] = state[k - 1];
    }
    state[0] = last;
    state[rounds[10]] = (n7 + n4) >>> 0;
    state[rounds[8]] = (old + n4) >>> 0;
  }
  return state;
}

export function f13V5Variant(querySM3, bodyMD5, ts) {
  return getIV(getIV(getIV(0x20230928, querySM3), bodyMD5), le32(ts)) & 15;
}

export function f13V5Supported(variant) {
  return variant === 5 || variant === 12;
}

export function f13V5Tail(head) {
  let h = 0x20220420;
  for (let i = 0; i < 8; i++) {
    const cb = head[i];
    if ((i & 1) === 0) {
      h = (((h << 7) >>> 0) ^ cb ^ (h >>> 3) ^ h) >>> 0;
    } else {
      h = (~((((h << 11) >>> 0) | cb) ^ (h >>> 5) ^ h)) >>> 0;
    }
  }
  const out = le32(h);
  out[0] &= 0xdb;
  out[3] ^= 1;
  return out;
}

export function f13V5HeadMD5(querySM3, bodyMD5, ts) {
  const t = ts >>> 0;
  const input = new Uint8Array(52);
  input.set(querySM3, 0);
  input.set(bodyMD5, 32);
  writeU32LE(input, 48, t);
  const w = (at) => readU32LE(input, at);

  const pad = new Uint8Array(8);
  const padRot = ((t - 1) >>> 0) & 7;
  for (let i = 0; i < 8; i++) {
    pad[i] = ror8(F13_V5_PAD[i], padRot);
  }
  const m = new Uint32Array([
    w(36), w(32), readU32LE(pad, 0), w(24),
    w(40), w(28), readU32LE(pad, 4), w(44),
    w(0), w(4), w(8), 0x1a0,
    w(48), w(16), w(20), w(12),
  ]);

  const iv = new Uint32Array(4);
  const ivRot = ((t + 2) >>> 0) & 31;
  for (let i = 0; i < 4; i++) {
    iv[i] = ror32(F13_V5_IV[i], ivRot);
  }
  let a = iv[0];
  let b = iv[1];
  let c = iv[2];
  let d = iv[3];

  for (let i = 0; i < 64; i++) {
    let f;
    const round = (i / 16) | 0;
    if (round === 0) {
      f = (d ^ (b & (c ^ d))) >>> 0;
    } else if (round === 1) {
      f = (c ^ (d & (b ^ c))) >>> 0;
    } else if (round === 2) {
      f = (b ^ c ^ d) >>> 0;
    } else {
      f = (c ^ (b | ~d)) >>> 0;
    }
    const k = ror32(F13_V5_K[i], ((t + 3 + round) >>> 0) & 31);
    const x = (a + f + m[F13_V5_ORDER[i]] + k) >>> 0;
    const nextB = (b + rol32(x, F13_V5_SHIFT[i])) >>> 0;
    a = d;
    d = c;
    c = b;
    b = nextB;
  }

  const state = [a, b, c, d];
  const finalRot = ((t + 8) >>> 0) & 31;
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    const val = (((iv[i] + state[i]) >>> 0) ^ ror32(F13_V5_FINAL[i], finalRot)) >>> 0;
    writeU32LE(out, i * 4, val);
  }
  return out;
}

export function f13V5HeadSHA(querySM3, bodyMD5, ts) {
  const seed = 0x9d4a97c2;
  const count = (seed + (ts >>> 0)) >>> 0;
  const table = new Uint32Array(BRANCH0_TT.length);
  const tableRot = (count + 1) >>> 0;
  for (let i = 0; i < BRANCH0_TT.length; i++) {
    table[i] = ror32(BRANCH0_TT[i], tableRot);
  }
  const pad = new Uint8Array([0xfa, 0x45, 0x61, 0xd7]);
  const padShift = ((count + 2) >>> 0) & 7;
  for (let i = 0; i < 4; i++) {
    const v = pad[i];
    pad[i] = ((v | (v << 8)) >>> padShift) & 0xff;
  }
  const block = concatBytes(
    querySM3,
    bodyMD5,
    le32(ts),
    pad,
    new Uint8Array([0, 0, 0, 0, 0, 0, 1, 0xa0])
  );
  const words = expandWords(block);
  const initial = new Uint32Array(BRANCH0_INIT.length);
  for (let i = 0; i < BRANCH0_INIT.length; i++) {
    initial[i] = ror32(BRANCH0_INIT[i], count);
  }
  const state = mixRounds(initial, [96, 1, 3, 4, 0, 6, 5, 2, 0, 7, 7], words, table, seed);
  const result = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    writeU32BE(result, i * 4, (state[i] + initial[i]) >>> 0);
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = result[i] ^ result[i + 16];
  }
  return out;
}

export function f13V5(querySM3, bodyMD5, ts) {
  const variant = f13V5Variant(querySM3, bodyMD5, ts);
  let head;
  if (variant === 5) {
    head = f13V5HeadMD5(querySM3, bodyMD5, ts);
  } else if (variant === 12) {
    head = f13V5HeadSHA(querySM3, bodyMD5, ts);
  } else {
    return null;
  }
  return concatBytes(head, f13V5Tail(head));
}
