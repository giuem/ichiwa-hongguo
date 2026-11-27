// Modified AES-V3 and Playback V5 AES (ported from openhongguo internal/protocol/sign/aes.go & playback_v5_aes.go).
import { concatBytes, le32 } from "../crypto/bytes.js";
import { getPlaybackV5Sbox } from "./const.js";

const V5_INITIAL_WORDS = [0xbbb5de72, 0xd4638d5b, 0x92a5f73b, 0x89f8a1c9];
const V5_CON2 = [
  [2, 0, 3, 1],
  [1, 3, 2, 0],
  [3, 2, 1, 0],
  [2, 3, 1, 0],
];
const V5_ORDER = [
  [0, 9, 14, 15, 4, 13, 2, 7, 8, 1, 6, 3, 12, 5, 10, 11],
  [0, 9, 14, 11, 4, 13, 2, 3, 8, 1, 6, 15, 12, 5, 10, 7],
  [0, 9, 14, 3, 4, 13, 2, 15, 8, 1, 6, 11, 12, 5, 10, 7],
  [0, 9, 14, 15, 4, 13, 2, 3, 8, 1, 6, 11, 12, 5, 10, 7],
];
const WIRE_BITS = [6, 5, 3, 4, 2, 7, 1, 0];
const COMPACT_BITS = [1, 7, 3, 6, 2, 0, 4, 5];

function xorBytes(a, b) {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = a[i] ^ b[i % b.length];
  }
  return out;
}

export function expandAESWith(key, init, box) {
  const le = le32(init);
  const initial = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    initial.set(le, i * 4);
  }
  const expanded = new Uint8Array(48);
  expanded.set(xorBytes(initial, key), 0);
  let rounds = 8;
  for (let i = 4; i < 12; i++) {
    const at = 4 * (i - 1);
    let a = expanded[at];
    let b = expanded[at + 1];
    let c = expanded[at + 2];
    let d = expanded[at + 3];
    if ((i & 3) === 0) {
      const t = (((init >>> (rounds & 24)) ^ box[b]) & 0xff) >>> 0;
      b = box[c];
      c = box[d];
      d = box[a];
      a = t;
    }
    rounds = (rounds + 2) >>> 0;
    expanded[at + 4] = a ^ expanded[at - 12];
    expanded[at + 5] = b ^ expanded[at - 11];
    expanded[at + 6] = c ^ expanded[at - 10];
    expanded[at + 7] = d ^ expanded[at - 9];
  }
  const keys = [];
  for (let i = 0; i < 12; i++) {
    keys.push(expanded.subarray(i * 4, i * 4 + 4));
  }
  return keys;
}

function addCon(state, keys, keyOffset, con2) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      state[i][j] ^= keys[keyOffset + i][con2[j]];
    }
  }
}

function subState(state, box, con2) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      state[i][j] = box[state[i][j]];
    }
  }
  const old = state.map((row) => new Uint8Array(row));
  for (let i = 0; i < 4; i++) {
    state[i].set(old[con2[i]]);
  }
}

function shiftState(state, order) {
  const flat = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      flat[i * 4 + j] = state[i][j];
    }
  }
  for (let i = 0; i < 16; i++) {
    state[(i / 4) | 0][i % 4] = flat[order[i]];
  }
}

function shiftCon(state, con2) {
  const old = state.map((row) => new Uint8Array(row));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      state[i][j] = old[i][con2[j]];
    }
  }
}

function xt(x) {
  let v = (x << 1) & 0xff;
  if ((x & 0x80) !== 0) {
    v ^= 0x1b;
  }
  return v;
}

function mixColumns(state) {
  for (let i = 0; i < 4; i++) {
    const t = state[0][i] ^ state[1][i] ^ state[2][i] ^ state[3][i];
    const u = state[0][i];
    state[0][i] ^= t ^ xt(state[0][i] ^ state[1][i]);
    state[1][i] ^= t ^ xt(state[1][i] ^ state[2][i]);
    state[2][i] ^= t ^ xt(state[2][i] ^ state[3][i]);
    state[3][i] ^= t ^ xt(state[3][i] ^ u);
  }
}

function aesV3Block(cipher, value) {
  const state = [
    new Uint8Array(value.subarray(0, 4)),
    new Uint8Array(value.subarray(4, 8)),
    new Uint8Array(value.subarray(8, 12)),
    new Uint8Array(value.subarray(12, 16)),
  ];
  addCon(state, cipher.keys, 0, cipher.con2);
  for (let i = 1; i < 3; i++) {
    subState(state, cipher.box, cipher.con2);
    shiftState(state, cipher.order);
    if (i === 1) {
      shiftCon(state, cipher.con2);
      mixColumns(state);
    }
    addCon(state, cipher.keys, i * 4, cipher.con2);
  }
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      state[i][j] ^= cipher.keys[4 + i][j];
    }
  }
  const out = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    out.set(state[i], i * 4);
  }
  return out;
}

export function encryptPlaybackV5(data, key, iv, timestamp) {
  const word = (timestamp >>> 0) & 3;
  const sboxAll = getPlaybackV5Sbox();
  const box = sboxAll.subarray(word * 256, (word + 1) * 256);
  const cipher = {
    box,
    con2: V5_CON2[word],
    order: V5_ORDER[word],
    keys: expandAESWith(key, V5_INITIAL_WORDS[word], box),
  };

  const plain = new Uint8Array(32);
  for (let i = 0; i < 31; i++) {
    for (let j = 0; j < 8; j++) {
      const at = i * 8 + j;
      if (at < data.length) {
        plain[i] |= ((data[at] >>> WIRE_BITS[j]) & 1) << COMPACT_BITS[j];
      }
    }
  }
  plain[31] = 1;

  const first = aesV3Block(cipher, xorBytes(plain.subarray(0, 16), iv));
  const second = aesV3Block(cipher, xorBytes(plain.subarray(16, 32), first));
  const bits = concatBytes(first, second);

  const out = new Uint8Array(data);
  for (let i = 0; i < 31; i++) {
    for (let j = 0; j < 8; j++) {
      const at = i * 8 + j;
      if (at < out.length) {
        out[at] =
          (out[at] & ~(1 << WIRE_BITS[j])) |
          (((bits[i] >>> COMPACT_BITS[j]) & 1) << WIRE_BITS[j]);
      }
    }
  }
  const result = new Uint8Array(1 + out.length);
  result[0] = bits[31];
  result.set(out, 1);
  return result;
}
