// Request signing entry points (ported from openhongguo internal/protocol/sign/request.go & playback_v5.go).
import {
  base64Encode,
  be32,
  le32,
  md5Bytes,
  readU32LE,
  utf8Bytes,
} from "../crypto/bytes.js";
import { xGorgonFlags } from "./gorgon.js";
import { heliosV5 } from "./helios.js";
import {
  assembleMedusaV5,
  defaultMedusaEnv,
  envFlags,
  medusaDeviceOf,
  newMedusaV5Input,
  queryValue,
} from "./medusa.js";
import { argusHeader, ladonHeader, playbackAID } from "./playback.js";

const MEDUSA_PROCESS_CACHE_KEY = "medusa_process_env";

const UNRESERVED = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()".split("")
);

export function encodeComponent(s) {
  const bytes = utf8Bytes(String(s));
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    const ch = String.fromCharCode(c);
    if (c < 128 && UNRESERVED.has(ch)) {
      out += ch;
    } else {
      out += "%" + c.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

export function encodeQuery(pairs) {
  return pairs.map(([k, v]) => `${encodeComponent(k)}=${encodeComponent(v)}`).join("&");
}

function randUint32() {
  return readU32LE(host.crypto.randomBytes(4), 0);
}

function drawEntropy(nowMillis) {
  const buf = host.crypto.randomBytes(16);
  const low32 = readU32LE(buf, 0);
  const u16 = buf[8] | (buf[9] << 8);
  const gorgonRnd = buf[12] | (buf[13] << 8);
  return {
    envLaunch: 100 + (low32 % 21),
    envPID: 10001 + (u16 % 2000),
    nowSecs: Math.trunc(nowMillis / 1000),
    messageRandom: readU32LE(buf, 0),
    random: readU32LE(buf, 4),
    packedRandom: readU32LE(buf, 8),
    gorgonRandom: gorgonRnd,
    heliosRandom: readU32LE(buf, 12),
  };
}

function medusaRandomOf(ent) {
  return {
    message: (ent.messageRandom >>> 0) & 0x7fffffff,
    key: (ent.random >>> 0) & 0x7fffffff,
    packed: (ent.packedRandom >>> 0) & 0x7fffffff,
  };
}

function loadProcessMedusaEnv(nowMillis) {
  let state = null;
  try {
    const raw = host.cache.get(MEDUSA_PROCESS_CACHE_KEY);
    if (raw) state = JSON.parse(raw);
  } catch {
    state = null;
  }
  if (!state) {
    const rnd = host.crypto.randomBytes(8);
    const r0 = readU32LE(rnd, 0);
    const r1 = readU32LE(rnd, 4);
    state = {
      launchMillis: nowMillis,
      pid: 3000 + (r0 % 25000),
      ppid: 500 + (r1 % 700),
      counter: 20 + (r0 % 100),
    };
  }
  state.counter += 1;
  try {
    host.cache.set(MEDUSA_PROCESS_CACHE_KEY, JSON.stringify(state));
  } catch {
    // Non-fatal if cache is unavailable.
  }
  const env = defaultMedusaEnv(state.launchMillis);
  env.pid = state.pid;
  env.ppid = state.ppid;
  env.counter = state.counter;
  return env;
}

function requestMedusaEnv(query, deviceID, nowMillis, customEnv) {
  const env = customEnv ? { ...customEnv } : loadProcessMedusaEnv(nowMillis);
  if (!customEnv || customEnv.device === undefined) {
    env.device = medusaDeviceOf(query, deviceID);
  }
  return env;
}

export function signRequest(
  path,
  pairs,
  nowMillis,
  deviceID,
  versionName,
  body = null,
  entropy = null,
  customEnv = null
) {
  const ent = entropy ? { ...entropy } : drawEntropy(nowMillis);
  const hasBody = body !== null && body !== undefined;
  let query = "";
  let ticket = nowMillis;
  let khronos = Math.trunc(nowMillis / 1000) >>> 0;
  let medusaIn = null;

  for (let offset = 0; offset < 256; offset++) {
    ticket = nowMillis + offset;
    khronos = Math.trunc(ticket / 1000) >>> 0;
    const withTicket = [
      ...pairs,
      ["ts", String(khronos)],
      ["_rticket", String(ticket)],
    ];
    query = encodeQuery(withTicket);
    medusaIn = newMedusaV5Input(query, hasBody ? body : null, khronos);
    if (medusaIn) break;
  }
  if (!medusaIn) {
    throw new Error("medusa v5 signing branch unavailable");
  }
  if (!ent.nowSecs) {
    ent.nowSecs = khronos;
  }
  const env = requestMedusaEnv(query, deviceID, nowMillis, customEnv);
  const headers = {
    Accept: "application/json; charset=utf-8,application/x-protobuf",
    "x-xs-from-web": "0",
    "x-ss-req-ticket": String(ticket),
    "x-tt-request-tag": "t=0;n=0",
    "sdk-version": "2",
    "passport-sdk-version": "50561",
    "x-vc-bdturing-sdk-version": "3.7.2.cn",
    "x-khronos": String(khronos),
    "x-ladon": base64Encode(be32(khronos)),
    "x-argus": base64Encode(le32(khronos)),
    "x-gorgon": xGorgonFlags(query, body, hasBody, khronos, ent.gorgonRandom, envFlags(env)),
    "x-helios": heliosV5(khronos, ent.heliosRandom),
    "x-medusa": assembleMedusaV5(medusaIn, deviceID, env, medusaRandomOf(ent)),
    "x-tt-dt": "",
  };
  if (hasBody) {
    headers["Content-Type"] = "application/json; charset=UTF-8";
    headers["x-ss-stub"] = host.crypto.md5(body).toUpperCase();
  }
  return { query, headers };
}

export function signGET(pairs, nowMillis, deviceID, versionName, entropy = null, customEnv = null) {
  return signRequest(
    "/reading/bookapi/search/tab/v",
    pairs,
    nowMillis,
    deviceID,
    versionName,
    null,
    entropy,
    customEnv
  );
}

export function signPOST(
  path,
  pairs,
  nowMillis,
  deviceID,
  versionName,
  body,
  entropy = null,
  customEnv = null
) {
  return signRequest(path, pairs, nowMillis, deviceID, versionName, body, entropy, customEnv);
}

export function signPlaybackPOST(
  path,
  pairs,
  nowMillis,
  deviceID,
  versionName,
  body,
  entropy = null,
  customEnv = null,
  nonces = null
) {
  const { query, headers } = signRequest(
    path,
    pairs,
    nowMillis,
    deviceID,
    versionName,
    body,
    entropy,
    customEnv
  );
  const ts = Number(headers["x-khronos"]) >>> 0;
  const bodyMD5 = body && body.length > 0 ? md5Bytes(body) : new Uint8Array(16);
  const aid = playbackAID(query);
  const argusNonce = nonces ? nonces.argus >>> 0 : randUint32();
  const ladonNonce = nonces ? nonces.ladon >>> 0 : randUint32();
  headers["x-argus"] = argusHeader(
    query,
    bodyMD5,
    ts,
    argusNonce,
    aid,
    queryValue(query, "device_id"),
    queryValue(query, "iid")
  );
  headers["x-ladon"] = ladonHeader(ts, ladonNonce, aid);
  delete headers["x-medusa"];
  return { query, headers };
}

export function signPlaybackV5(pairs, nowMillis, body, entropy = null, customEnv = null) {
  const ts = Math.trunc(nowMillis / 1000) >>> 0;
  const hasBody = body !== null && body !== undefined;
  const withTicket = pairs.map(([k, v]) => [k, v]);
  let slot = withTicket.findIndex(([k]) => k === "_rticket");
  if (slot < 0) {
    withTicket.push(["_rticket", ""]);
    slot = withTicket.length - 1;
  }
  for (let offset = 0; offset < 1024; offset++) {
    withTicket[slot][1] = String(nowMillis + offset);
    const query = encodeQuery(withTicket);
    const medusaIn = newMedusaV5Input(query, hasBody ? body : null, ts);
    if (!medusaIn) continue;
    const ent = entropy ? { ...entropy } : drawEntropy(nowMillis);
    const deviceID = queryValue(query, "device_id");
    const env = requestMedusaEnv(query, deviceID, nowMillis, customEnv);
    const headers = {
      "x-khronos": String(ts),
      "x-helios": heliosV5(ts, ent.heliosRandom),
      "x-medusa": assembleMedusaV5(medusaIn, deviceID, env, medusaRandomOf(ent)),
    };
    if (hasBody) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["x-ss-stub"] = host.crypto.md5(body).toUpperCase();
    }
    return { query, headers };
  }
  throw new Error("playback V5 signing branch unavailable");
}
