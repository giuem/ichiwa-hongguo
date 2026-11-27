// x-medusa v5 message assembly and sealing (ported from openhongguo internal/protocol/sign/medusa*.go).
import {
  base64Encode,
  concatBytes,
  le32,
  md5Bytes,
  readU32LE,
  sha256Bytes,
  utf8Bytes,
} from "../crypto/bytes.js";
import { sm3Sum } from "../crypto/sm3.js";
import { encryptPlaybackV5 } from "./aes.js";
import {
  APP_ID,
  MEDUSA_DEVICE_FLAGS,
  MEDUSA_DEVICE_STATUS,
  MEDUSA_EMULATOR_FLAGS,
  MEDUSA_V5_ENV_VERSION,
  MEDUSA_V5_PACKED_HEAD,
  MEDUSA_V5_SDK_CODE,
  MEDUSA_V5_SDK_VERSION,
  MEDUSA_V5_VERSION,
  PLAYBACK_V5_LICENSE,
  getPlaybackV5Magic,
  getPlaybackV5SignKey,
} from "./const.js";
import { f13V5 } from "./f13.js";
import { protoBytes, protoEmpty, protoFloat, protoSInt, protoString } from "./proto.js";

const NOT_SET = "!notset!";
const UNSET_INT = -999999;
const NO_PERM = "!noperm!";
const NO_PERM_INT = -888888;
const MEDUSA_INSTALL_ANCHOR = 1795440816000;

export function defaultMedusaEnv(launchMillis) {
  return {
    pid: 4321,
    ppid: 1234,
    launchMillis,
    clock18: 766353820,
    clock19: 16,
    clock20: -1072050540,
    channel: "xiaomi_8662_64",
    unH: 2398682137,
    sts: 27,
    fkd: 1963693275,
    pd: 1442983616,
    lp: "2|520830913092|521433182354|2078052786776|1081701896",
    fl: "0|0|2523408538|2586339478|997724116|0|0|0|0|606600138",
    status: MEDUSA_DEVICE_STATUS,
    device: null,
    counter: null,
  };
}

export function envFlags(env) {
  return env.device ? MEDUSA_DEVICE_FLAGS : MEDUSA_EMULATOR_FLAGS;
}

export function queryValue(query, name) {
  if (!query) return "";
  const params = new URLSearchParams(query);
  return params.get(name) || "";
}

export function medusaDeviceOf(query, deviceID) {
  const model = queryValue(query, "device_type");
  if (!model) return null;
  const h = sha256Bytes(utf8Bytes("medusa-device\x00" + deviceID));
  const pick = (i, n) => (readU32LE(h, i * 4) % n) >>> 0;
  const storageBases = [106.83, 108.57, 229.36, 233.91, 487.62];
  const memoryBases = [5.37, 7.42, 11.18, 15.07];
  const storage = Math.fround(
    Math.fround(storageBases[pick(0, 5)]) + Math.fround(Math.fround(pick(1, 400)) / 1000)
  );
  const memory = Math.fround(
    Math.fround(memoryBases[pick(2, 4)]) + Math.fround(Math.fround(pick(3, 90)) / 1000)
  );
  const day = 24 * 60 * 60 * 1000;
  const storageFree = Math.fround(
    storage * Math.fround(Math.fround(0.25) + Math.fround(Math.fround(pick(5, 500)) / 1000))
  );
  const memoryFree = Math.fround(
    Math.fround(0.35) + Math.fround(Math.fround(pick(6, 900)) / 1000)
  );
  return {
    appVersion: queryValue(query, "version_name"),
    model,
    brand: queryValue(query, "device_brand"),
    osVersion: queryValue(query, "os_version"),
    installMillis: MEDUSA_INSTALL_ANCHOR - day - pick(4, 20 * day),
    storageGB: storage,
    storageFreeGB: storageFree,
    memoryGB: memory,
    memoryFreeGB: memoryFree,
  };
}

export function xmxor(data, key) {
  const n = data.length;
  const encoded = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const at = (i * 4) & 28;
    const d0 = key[at];
    const d1 = key[at + 1];
    const rot4 = ((data[i] << 4) | (data[i] >>> 4)) & 0xff;
    let d2 = (rot4 + d0) & 0xff;
    d2 = (~d2 ^ d1) & 0xff;
    d2 = ((d2 << 3) | (d2 >>> 5)) & 0xff;
    d2 = (d2 + d1) & 0xff;
    d2 = (d2 ^ d0) & 0xff;
    encoded[n - i - 1] = (~d2) & 0xff;
  }
  const last = encoded[n - 1] ^ encoded[n - 2];
  const first = encoded[0];
  encoded[0] = ((~last & 0xff) + first) & 0xff;
  encoded[1] = ((encoded[0] ^ encoded[n - 1] ^ 254) + encoded[1]) & 0xff;
  const shifted = ((encoded[1] << 3) | (encoded[1] >>> 5)) & 0xff;
  const fix2 = (((last - first) & 0xff) ^ (shifted ^ 2)) & 0xff;
  encoded[2] = (encoded[2] + fix2) & 0xff;
  for (let i = 0; i < n - 4; i++) {
    const sh = ((encoded[i + 2] << 3) | (encoded[i + 2] >>> 5)) & 0xff;
    const temp = (sh ^ encoded[i + 1] ^ ((i + 3) & 0xff)) & 0xff;
    encoded[i + 3] = ((~temp & 0xff) + encoded[i + 3]) & 0xff;
  }
  encoded[n - 1] ^= encoded[n - 2];
  let sum = 0;
  for (let i = 1; i < n; i++) {
    sum = (sum + encoded[i]) >>> 0;
  }
  encoded[0] = ((encoded[0] ^ encoded[1]) + (sum & 0xff)) & 0xff;
  return encoded;
}

export function keyHash(signKey, random) {
  const r = random >>> 0;
  const hash = sm3Sum(concatBytes(signKey, le32(r), signKey));
  const d1 = (r >>> 16) & 0xff;
  let d2 = (((d1 << 11) >>> 0) | (r >>> 24)) >>> 0;
  d2 = (d2 ^ (d1 >>> 5)) >>> 0;
  d2 = (d2 ^ d1) >>> 0;
  d2 = (~d2) >>> 0;
  return { hash, seed: le32(d2) };
}

export function newMedusaV5Input(query, body, ts) {
  const querySM3 = sm3Sum(utf8Bytes(query));
  const bodyMD5 = body ? md5Bytes(body) : new Uint8Array(16);
  const digest = f13V5(querySM3, bodyMD5, ts >>> 0);
  if (!digest) return null;
  return { querySM3, bodyMD5, digest, ts: ts >>> 0 };
}

function medusaV5JSON(env) {
  return (
    `{"cmr":16777216,"cmr2":16777216,"un_h":${env.unH},"vpn":0,"sts":${env.sts},` +
    `"kd":0,"fkd":${env.fkd},"pd":${env.pd},"lp":${JSON.stringify(env.lp)},` +
    `"fl":${JSON.stringify(env.fl)},"dyn":"","do":0,"tk":true}`
  );
}

function medusaV5Device(deviceID, env) {
  const parts = [protoSInt(1, 1), protoString(3, APP_ID), protoString(4, deviceID)];
  for (let tag = 5; tag <= 40; tag++) {
    if (
      tag === 5 ||
      tag === 6 ||
      (tag >= 11 && tag <= 13) ||
      tag === 15 ||
      tag === 22 ||
      (tag >= 30 && tag <= 37)
    ) {
      parts.push(protoString(tag, NOT_SET));
    } else if (
      (tag >= 7 && tag <= 10) ||
      tag === 14 ||
      (tag >= 23 && tag <= 25) ||
      tag === 27 ||
      tag === 29 ||
      tag === 38
    ) {
      parts.push(protoSInt(tag, UNSET_INT));
    } else if (tag >= 16 && tag <= 21) {
      parts.push(protoFloat(tag, UNSET_INT));
    } else if (tag === 26 || tag === 28 || tag === 40) {
      parts.push(protoSInt(tag, env.launchMillis));
    }
  }
  return concatBytes(...parts);
}

export function medusaV5DeviceBlock(deviceID, env, nowMillis) {
  const d = env.device;
  const str = (tag, s) => protoString(tag, s || NOT_SET);
  return concatBytes(
    protoSInt(1, 1),
    protoString(3, APP_ID),
    protoString(4, deviceID),
    protoString(5, NOT_SET),
    protoString(6, NO_PERM),
    protoSInt(7, NO_PERM_INT),
    protoSInt(8, NO_PERM_INT),
    protoSInt(9, 2),
    protoSInt(10, NO_PERM_INT),
    protoString(11, NOT_SET),
    protoString(12, "Asia/Shanghai,8"),
    protoString(13, "zh_CN"),
    protoSInt(14, 8),
    protoFloat(16, d.storageGB),
    protoFloat(17, d.storageFreeGB),
    protoFloat(18, d.memoryGB),
    protoFloat(19, d.memoryFreeGB),
    protoFloat(20, Math.fround(d.storageGB * 2)),
    protoFloat(21, Math.fround(d.storageFreeGB * 2)),
    str(22, d.osVersion),
    protoSInt(23, 60),
    protoSInt(24, 10),
    protoSInt(25, d.installMillis),
    protoSInt(26, env.launchMillis + 540),
    protoSInt(27, d.installMillis),
    protoSInt(28, nowMillis),
    protoSInt(29, 1),
    str(30, d.model),
    str(31, d.brand),
    protoString(32, NOT_SET),
    protoString(33, NOT_SET),
    protoString(34, NOT_SET),
    str(35, d.brand),
    protoString(36, NOT_SET),
    protoSInt(38, 3),
    protoSInt(40, env.launchMillis)
  );
}

function medusaV5Env(ts, deviceID, env, rnd) {
  const d = env.device;
  if (d) {
    let uptime = ts - Math.trunc(env.launchMillis / 1000);
    if (uptime < 1) uptime = 1;
    const version = d.appVersion || NOT_SET;
    const nowMillis = ts * 1000 + ((rnd.message >>> 0) % 1000);
    return concatBytes(
      protoSInt(1, uptime),
      protoString(6, MEDUSA_V5_ENV_VERSION),
      protoSInt(7, env.pid),
      protoString(8, env.channel),
      protoBytes(12, medusaV5DeviceBlock(deviceID, env, nowMillis)),
      protoEmpty(13),
      protoString(14, version),
      protoSInt(15, env.ppid),
      protoSInt(18, ts + env.clock18),
      protoSInt(19, ts + env.clock19),
      protoSInt(20, ts + env.clock20)
    );
  }
  return concatBytes(
    protoString(6, MEDUSA_V5_ENV_VERSION),
    protoSInt(7, env.pid),
    protoString(8, env.channel),
    protoBytes(12, medusaV5Device(deviceID, env)),
    protoEmpty(13),
    protoString(14, NOT_SET),
    protoSInt(15, env.ppid),
    protoSInt(18, ts + env.clock18),
    protoSInt(19, ts + env.clock19),
    protoSInt(20, ts + env.clock20)
  );
}

export function medusaV5Message(input, deviceID, env, rnd) {
  const ts = input.ts >>> 0;
  const unset = 694367;
  let counters = concatBytes(
    protoSInt(1, unset),
    protoSInt(2, unset),
    protoSInt(3, unset),
    protoSInt(5, unset)
  );
  let appVersion = new Uint8Array(0);
  if (env.device) {
    const countVal = typeof env.counter === "number" ? env.counter : 21;
    counters = concatBytes(
      protoSInt(1, countVal),
      protoSInt(2, 5),
      protoSInt(3, unset),
      protoSInt(5, unset)
    );
    appVersion = protoString(7, env.device.appVersion);
  }
  return concatBytes(
    protoBytes(1, getPlaybackV5Magic()),
    protoSInt(2, MEDUSA_V5_VERSION),
    protoSInt(3, rnd.message >>> 0),
    protoString(4, APP_ID),
    protoString(5, deviceID),
    protoString(6, PLAYBACK_V5_LICENSE),
    appVersion,
    protoString(8, MEDUSA_V5_SDK_VERSION),
    protoSInt(9, MEDUSA_V5_SDK_CODE),
    protoBytes(10, envFlags(env)),
    protoSInt(12, ts),
    protoBytes(13, input.digest),
    protoBytes(14, input.querySM3.subarray(0, 6)),
    protoBytes(15, counters),
    protoSInt(17, ts),
    protoString(20, "none"),
    protoSInt(21, env.status),
    protoBytes(23, medusaV5Env(ts, deviceID, env, rnd)),
    protoString(24, medusaV5JSON(env))
  );
}

export function sealMedusaV5(message, input, rnd, flags) {
  const ts = input.ts >>> 0;
  const signKey = getPlaybackV5SignKey();
  const { hash, seed } = keyHash(signKey, rnd.key >>> 0);
  const transformed = concatBytes(flags, xmxor(message, hash));
  transformed.reverse();
  for (let i = 0; i < transformed.length; i++) {
    transformed[i] ^= seed[(~i) & 3];
  }
  const check =
    (0x18000001 | ((input.querySM3[0] & 63) << 14) | ((input.digest[0] & 63) << 8)) >>> 0;
  const packed = concatBytes(
    new Uint8Array([MEDUSA_V5_PACKED_HEAD]),
    le32(rnd.packed >>> 0),
    le32(check),
    transformed,
    new Uint8Array([(rnd.key >>> 16) & 0xff, (rnd.key >>> 24) & 0xff])
  );
  const key = md5Bytes(signKey.subarray(0, 16));
  const iv = md5Bytes(signKey.subarray(16));
  const encrypted = encryptPlaybackV5(packed, key, iv, ts);
  const prefix = concatBytes(le32(MEDUSA_V5_VERSION), getPlaybackV5Magic());
  for (let i = 0; i < prefix.length; i++) {
    prefix[i] ^= (ts >>> ((i & 3) * 8)) & 0xff;
  }
  return base64Encode(
    concatBytes(
      prefix,
      new Uint8Array([rnd.key & 0xff, (rnd.key >>> 8) & 0xff, 0, 1]),
      encrypted
    )
  );
}

export function assembleMedusaV5(input, deviceID, env, rnd) {
  const msg = medusaV5Message(input, deviceID, env, rnd);
  return sealMedusaV5(msg, input, rnd, envFlags(env));
}
