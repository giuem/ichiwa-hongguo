// Pure JavaScript Hongguo anonymous client (ported from openhongguo sdk/).
import { fromUtf8, hexEncode, readU32BE } from "./crypto/bytes.js";
import { deriveContentKey } from "./crypto/spade.js";
import { ErrCode, HongguoError, isErr, isRetryable, retryAfterSeconds } from "./errors.js";
import {
  AID,
  CREDENTIAL_HEADER_NAMES,
  DEFAULT_API_ORIGIN,
  DEFAULT_DEVICE,
  DEFAULT_DISTRIBUTION_ORIGIN,
  DEFAULT_REGISTER_ORIGIN,
  DANMAKU_FALLBACK_DURATION,
  PATH_ALBUM,
  PATH_CELL_CHANGE,
  PATH_DANMAKU,
  PATH_DISCOVER,
  PATH_PLAN,
  PATH_PLAYBACK,
  PATH_PLAYBACK_V5,
  PATH_PROFILE,
  PATH_RANK_CELLS,
  PATH_REGISTER,
  PATH_SEARCH,
  PATH_SERIES,
  PATH_SERIES_BATCH,
  PATH_SHORT_FILTER,
  PATH_SUBSCRIBE_LIST,
  PATH_SUGGEST,
  PATH_USER_WORKS,
  SEARCH_TAB_SHORT_PLAY,
  SHOW_TYPE_DETAIL_RELATED_VIDEO,
  VERSION_NAME,
  deviceOrDefault,
  playbackUserAgent,
  userAgent,
} from "./protocol/app.js";
import { resolveDiscoverChannel, resolveSearchTab, searchOffset } from "./protocol/channel.js";
import {
  authCode,
  baseStatus,
  businessCode,
  classifyCode,
  codeName,
  deviceRejected,
} from "./protocol/codes.js";
import {
  decodeDanmakuCursor,
  decodeFeedCursor,
  decodeShortCursor,
  decodeWorksCursor,
  encodeDanmakuCursor,
  encodeFeedCursor,
  encodeShortCursor,
  encodeWorksCursor,
  validDate,
} from "./protocol/cursor.js";
import { parseJSONSafe } from "./protocol/json.js";
import {
  discoverContinuationTab,
  parseAlbum,
  parseCellChange,
  parseDanmaku,
  parseDiscoverTab,
  parseHotSearch,
  parseNewReleases,
  parsePlanCells,
  parsePlayback,
  parseProfile,
  parseSearchTab,
  parseSeasons,
  parseSeries,
  parseSeriesBatch,
  parseShortFilter,
  parseShortRank,
  parseSuggest,
  parseUserWorks,
  parseWorksTab,
} from "./protocol/parse.js";
import { buildRegisterBody, contentMD5, parseRegister } from "./protocol/register.js";
import {
  SHORT_FILTER_KEYS,
  albumBody,
  danmakuBody,
  deviceQueryPairs,
  playbackBody,
  playbackV5Body,
  playbackV5Pairs,
  readingRequestID,
  seriesBatchBody,
  seriesBody,
  shortFilterBody,
  signedCellChangePairs,
  signedDiscoverPairsIn,
  signedHotSearchPairs,
  signedNewReleasePairs,
  signedPlanPairs,
  signedProfilePairs,
  signedSearchPairsFor,
  signedSeasonPairs,
  signedShortRankPairs,
  signedSuggestPairs,
  userWorksBody,
  userWorksTabsBody,
} from "./protocol/request.js";
import { signGET, signPOST, signPlaybackPOST, signPlaybackV5 } from "./sign/request.js";

const PROFILE_STORAGE_KEY = "hongguo_device_profile";
const DURATION_CACHE_PREFIX = "hongguo_ep_dur:";
const DURATION_CACHE_TTL_SEC = 3600;
const SEEN_CACHE_PREFIX = "hongguo_seen:";
const SEEN_CACHE_TTL_SEC = 1800;
const MAX_CACHED_SEEN = 4000;
const DEVICE_ROTATE_LOCK_KEY = "hongguo_device_rotating";
// The lock lapses this long after it was last renewed: a call cancelled
// while it holds the lock runs no finally, so the lock must lapse by itself.
const DEVICE_ROTATE_LOCK_TTL_SEC = 2;
const DEVICE_ROTATE_RENEW_MS = 500;
// Without host.cache.add, a call writes the lock, waits this long and reads
// it back: of the calls that wrote at once, the last writer holds it.
const DEVICE_ROTATE_SETTLE_MS = 30;
const DEVICE_ROTATE_WAIT_MS = 12000;
const DEVICE_ROTATE_POLL_MS = 40;
const SERIES_BATCH_SIZE = 10;
const MAX_RETRY_WAIT_MS = 2000;

const SEASON_SUFFIX_RE = /\s*(第\s*[0-9一二三四五六七八九十百]+\s*[季部期]|[0-9]+)\s*$/;

const SEARCH_FILTERS = new Set([
  "content_type_short_play",
  "content_type_dynamic_comic",
  "content_type_ai_dynamic_comic",
  "content_type_long_video",
  "search_range_unread",
]);

function isAbortError(err) {
  return Boolean(err && (err.name === "AbortError" || err.code === "ABORT_ERR"));
}

function makeAbortError() {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(makeAbortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, ms);
    function onAbort() {
      if (typeof clearTimeout === "function") clearTimeout(timer);
      reject(makeAbortError());
    }
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function readRotateLock() {
  try {
    const raw = host.cache.get(DEVICE_ROTATE_LOCK_KEY);
    if (!raw) return null;
    const lock = JSON.parse(raw);
    if (!lock || typeof lock.token !== "string") return null;
    // host.cache drops the lock when it lapses; this guards a host that keeps
    // it a little longer.
    if (Date.now() - (Number(lock.at) || 0) > DEVICE_ROTATE_LOCK_TTL_SEC * 1000) return null;
    return lock;
  } catch {
    return null;
  }
}

// acquireRotateLock takes the device lock shared by every call of the
// plugin, or returns null while another call holds it. The lock is renewed
// every DEVICE_ROTATE_RENEW_MS until released, and lapses within
// DEVICE_ROTATE_LOCK_TTL_SEC once its holder stops renewing it. With
// host.cache.add the lock is taken atomically; without it, a call writes the
// lock, waits DEVICE_ROTATE_SETTLE_MS and holds it only if the lock it reads
// back is still its own.
async function acquireRotateLock() {
  const token = hexEncode(host.crypto.randomBytes(8));
  const value = () => JSON.stringify({ token, at: Date.now() });
  try {
    if (typeof host.cache.add === "function") {
      if (!host.cache.add(DEVICE_ROTATE_LOCK_KEY, value(), DEVICE_ROTATE_LOCK_TTL_SEC)) return null;
    } else {
      if (readRotateLock()) return null;
      host.cache.set(DEVICE_ROTATE_LOCK_KEY, value(), DEVICE_ROTATE_LOCK_TTL_SEC);
      await sleep(DEVICE_ROTATE_SETTLE_MS);
      if (readRotateLock()?.token !== token) return null;
    }
  } catch {
    // Without a working cache there is nothing to coordinate with.
  }
  let released = false;
  let timer = null;
  const renew = () => {
    if (released) return;
    try {
      if (readRotateLock()?.token === token) {
        host.cache.set(DEVICE_ROTATE_LOCK_KEY, value(), DEVICE_ROTATE_LOCK_TTL_SEC);
      }
    } catch {
      // Ignore cache errors.
    }
    timer = setTimeout(renew, DEVICE_ROTATE_RENEW_MS);
  };
  timer = setTimeout(renew, DEVICE_ROTATE_RENEW_MS);
  return {
    token,
    release() {
      released = true;
      if (typeof clearTimeout === "function") clearTimeout(timer);
      try {
        if (readRotateLock()?.token === token) host.cache.delete(DEVICE_ROTATE_LOCK_KEY);
      } catch {
        // Ignore cache errors.
      }
    },
  };
}

function validID(id) {
  return typeof id === "string" && id.length >= 4 && id.length <= 25 && /^[0-9]+$/.test(id);
}

function randomInt31() {
  return readU32BE(host.crypto.randomBytes(4), 0) & 0x7fffffff;
}

function newAnonymousProfile(device, nowMs) {
  return {
    cdid: host.crypto.uuid(),
    openudid: hexEncode(host.crypto.randomBytes(8)),
    clientudid: host.crypto.uuid(),
    oaid: host.crypto.uuid(),
    req_id: host.crypto.uuid(),
    device_id_str: "",
    install_id_str: "",
    ttreq: "",
    store_region: "",
    store_region_src: "",
    created_at: new Date(nowMs).toISOString(),
    device: deviceOrDefault(device),
  };
}

function guestReady(p) {
  return Boolean(
    p &&
      p.device_id_str &&
      p.install_id_str &&
      p.device_id_str !== "0" &&
      p.install_id_str !== "0"
  );
}

// guestCookie is the Cookie header of a guest device: the same cookies the
// SDK sends, or none before the device has a ticket. The plugin always sends
// it explicitly, even empty, so the host never adds cookies from its own jar
// (plugin-design.md §11), such as those of a device already replaced.
function guestCookie(p) {
  if (!p || !p.ttreq) return "";
  return (
    `passport_csrf_token=; passport_csrf_token_default=; ` +
    `store-region=${p.store_region || ""}; store-region-src=${p.store_region_src || ""}; ` +
    `install_id=${p.install_id_str}; ttreq=${p.ttreq}`
  );
}

function extractResponseCookies(headers) {
  const cookies = {};
  if (!headers) return cookies;
  let list = [];
  if (typeof headers.getSetCookie === "function") {
    list = headers.getSetCookie();
  } else {
    const raw = headers.get("set-cookie");
    if (raw) {
      // Split comma-joined Set-Cookie headers without splitting Expires=Thu, 01 Jan ...
      list = raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/);
    }
  }
  for (const entry of list) {
    const first = String(entry).split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) {
      const name = first.slice(0, eq).trim();
      const val = first.slice(eq + 1).trim();
      if (name) cookies[name] = val;
    }
  }
  return cookies;
}

function shortFilterScene(genre) {
  if (!genre || genre === "short_play") return "default";
  if (genre === "comic_series" || genre === "ai_series") return genre;
  throw new Error(`unknown short-drama genre ${JSON.stringify(genre)}`);
}

function sameSelections(a, b) {
  const norm = (m) => {
    const out = {};
    if (!m) return out;
    for (const [k, v] of Object.entries(m)) {
      if (Array.isArray(v) && v.length > 0) out[k] = v.join(",");
    }
    return out;
  };
  const na = norm(a);
  const nb = norm(b);
  const ka = Object.keys(na);
  if (ka.length !== Object.keys(nb).length) return false;
  return ka.every((k) => na[k] === nb[k]);
}

function seasonBaseTitle(title) {
  let t = String(title || "").trim();
  if (!t) return t;
  const m = SEASON_SUFFIX_RE.exec(t);
  if (m && m.index > 0) {
    t = t.slice(0, m.index).trim();
  }
  return t;
}

function sortSeasons(seasons) {
  seasons.sort((a, b) => {
    if (a.index !== b.index) return a.index - b.index;
    return a.seriesId < b.seriesId ? -1 : a.seriesId > b.seriesId ? 1 : 0;
  });
}

function mergeSeries(base, extra) {
  const seen = new Set();
  const out = [];
  for (const item of [...base, ...extra]) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export class HongguoClient {
  constructor(options = {}) {
    this.apiOrigin = (options.apiOrigin || DEFAULT_API_ORIGIN).replace(/\/+$/, "");
    this.registerOrigin = (options.registerOrigin || DEFAULT_REGISTER_ORIGIN).replace(/\/+$/, "");
    this.distOrigin = (options.distOrigin || DEFAULT_DISTRIBUTION_ORIGIN).replace(/\/+$/, "");
    this.device = deviceOrDefault(options.device || DEFAULT_DEVICE);
    this.retryAttempts = options.retryAttempts ?? 3;
    this.deviceResets = options.deviceResets ?? 3;
    this.clock = options.clock || (() => Date.now());
    this.fetchFn = options.fetch || ((url, init) => fetch(url, init));
    this._inflightRegister = null;
  }

  _loadProfile() {
    try {
      const raw = host.storage.get(PROFILE_STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  _saveProfile(profile) {
    host.storage.set(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  }

  _resetProfile() {
    host.storage.delete(PROFILE_STORAGE_KEY);
  }

  _deviceOf(p) {
    return deviceOrDefault(p?.device || this.device);
  }

  _identity(p) {
    return {
      deviceId: p.device_id_str,
      installId: p.install_id_str,
      cdid: p.cdid,
      openudid: p.openudid,
      device: this._deviceOf(p),
    };
  }

  _anonymousHeaders(p, ticket, headers) {
    const out = { ...(headers || {}) };
    out["User-Agent"] = userAgent(this._deviceOf(p));
    out["x-ss-dp"] = AID;
    out["lc"] = "101";
    out["x-reading-request"] = readingRequestID(ticket, randomInt31());
    out["Cookie"] = guestCookie(p);
    return out;
  }

  async _doOnce(method, rawURL, headers, body, signal = null) {
    if (signal?.aborted) {
      throw makeAbortError();
    }
    const hdrs = { ...(headers || {}) };
    for (const k of Object.keys(hdrs)) {
      if (CREDENTIAL_HEADER_NAMES.includes(k.toLowerCase())) {
        throw new HongguoError(ErrCode.AuthRequired, "credential header refused");
      }
    }
    if (!Object.keys(hdrs).some((k) => k.toLowerCase() === "accept")) {
      hdrs["Accept"] = "application/json";
    }
    if (!Object.keys(hdrs).some((k) => k.toLowerCase() === "cookie")) {
      hdrs["Cookie"] = "";
    }
    let resp;
    try {
      const init = {
        method,
        headers: hdrs,
        body: body ?? undefined,
      };
      if (signal) init.signal = signal;
      resp = await this.fetchFn(rawURL, init);
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      throw new HongguoError(ErrCode.Transport, `network error: ${e?.message || e}`);
    }
    if (signal?.aborted) {
      throw makeAbortError();
    }
    if (!resp) {
      throw new HongguoError(ErrCode.Transport, "empty response");
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new HongguoError(ErrCode.AuthRequired, `HTTP ${resp.status}`, {
        httpStatus: resp.status,
      });
    }
    if (resp.status === 429) {
      let retryAfter = 0;
      const ra = resp.headers?.get?.("retry-after");
      if (ra) {
        const n = Number(String(ra).trim());
        if (Number.isFinite(n) && n > 0) retryAfter = n;
      }
      throw new HongguoError(ErrCode.RateLimited, "HTTP 429", { httpStatus: 429, retryAfter });
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new HongguoError(ErrCode.APIError, `HTTP ${resp.status}`, { httpStatus: resp.status });
    }
    let rawBytes;
    try {
      rawBytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      if (signal?.aborted || isAbortError(e)) throw e;
      throw new HongguoError(ErrCode.Transport, `network error: ${e?.message || e}`);
    }
    if (signal?.aborted) {
      throw makeAbortError();
    }
    // Handle servers/mocks returning raw gzipped bytes without fetch auto-decompression.
    if (rawBytes.length >= 2 && rawBytes[0] === 0x1f && rawBytes[1] === 0x8b) {
      rawBytes = host.encoding.gunzip(rawBytes);
    }
    const text = fromUtf8(rawBytes).trim();
    if (!text) {
      throw new HongguoError(ErrCode.AnonymousLimited, "anonymous response was empty");
    }
    let json;
    try {
      json = parseJSONSafe(text);
    } catch (e) {
      throw new HongguoError(ErrCode.APIError, `invalid JSON response: ${e?.message || e}`);
    }
    const biz = businessCode(json);
    if (biz && biz.code !== "" && biz.code !== "0") {
      const n = Number(biz.code);
      if (!Number.isInteger(n)) {
        if (authCode(biz.code, biz.message)) {
          throw new HongguoError(ErrCode.AuthRequired, biz.message || "authentication required");
        }
        throw new HongguoError(ErrCode.CodeError, biz.message || `code ${biz.code}`, {
          bizMessage: biz.message,
          bizKind: classifyCode(0, biz.message),
        });
      }
      const bKind = classifyCode(n, biz.message);
      throw new HongguoError(ErrCode.CodeError, biz.message || `code ${n}`, {
        bizCode: n,
        bizName: codeName(n),
        bizMessage: biz.message,
        bizKind: bKind,
      });
    }
    const base = baseStatus(json);
    if (deviceRejected(base)) {
      throw new HongguoError(ErrCode.CodeError, `device rejected (${base})`, {
        bizCode: base,
        bizName: "DEVICE_REJECTED",
        bizKind: "device_rejected",
      });
    }
    const cookies = extractResponseCookies(resp.headers);
    return { json, cookies };
  }

  async _doRaw(method, rawURL, headers, body = null, signal = null) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this._doOnce(method, rawURL, headers, body, signal);
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          throw err;
        }
        const rateLimited = isErr(err, ErrCode.RateLimited);
        if (!isRetryable(err) || attempt + 1 >= this.retryAttempts) {
          if (rateLimited) {
            const waitSec = Math.ceil(retryAfterSeconds(err, 30));
            console.log(
              `[hongguo] rate limited (code=${err.bizCode || err.httpStatus || "unknown"} wait=${waitSec}s), giving up after ${attempt + 1} attempt(s)`
            );
          }
          throw err;
        }
        let backoffMs = Math.min(300 * (1 << attempt), 5000);
        const jitter = 0.8 + 0.4 * ((randomInt31() % 100) / 100);
        backoffMs = Math.round(backoffMs * jitter);
        const waitSec = retryAfterSeconds(err, backoffMs / 1000);
        const waitMs = Math.round(waitSec * 1000);
        if (waitMs > MAX_RETRY_WAIT_MS) {
          if (rateLimited) {
            console.log(
              `[hongguo] rate limited (code=${err.bizCode || err.httpStatus || "unknown"} wait=${Math.ceil(waitSec)}s > ${MAX_RETRY_WAIT_MS / 1000}s), failing fast`
            );
          }
          throw err;
        }
        if (rateLimited) {
          console.log(
            `[hongguo] rate limited (code=${err.bizCode || err.httpStatus || "unknown"} wait=${waitMs}ms), retrying attempt ${attempt + 1}`
          );
        }
        await sleep(waitMs, signal);
      }
    }
  }

  _profileSatisfies(p, failedDeviceId, needTicket) {
    if (!guestReady(p)) return false;
    if (needTicket && !p.ttreq) return false;
    if (failedDeviceId && p.device_id_str === failedDeviceId) return false;
    return true;
  }

  // _registerFreshProfile registers a new device unless a usable one is
  // already stored. Calls of the plugin run at once, each in a runtime of its
  // own, so registering is guarded by a lock in host.cache shared by all of
  // them: one call registers and the others wait for its device.
  async _registerFreshProfile(failedDeviceId, needTicket) {
    const existing = this._loadProfile();
    if (this._profileSatisfies(existing, failedDeviceId, needTicket)) {
      if (failedDeviceId) {
        console.log(
          `[hongguo] device already rotated from ${failedDeviceId} to ${existing.device_id_str}, reusing`
        );
      }
      return existing;
    }

    // Nested calls inside this runtime share one registration.
    if (this._inflightRegister) {
      const shared = await this._inflightRegister.catch(() => null);
      if (this._profileSatisfies(shared, failedDeviceId, needTicket)) {
        return shared;
      }
    }

    const deadline = Date.now() + DEVICE_ROTATE_WAIT_MS;
    let lock = null;
    let waited = false;
    for (;;) {
      const cur = this._loadProfile();
      if (this._profileSatisfies(cur, failedDeviceId, needTicket)) {
        if (waited) console.log(`[hongguo] reused device=${cur.device_id_str} registered by a concurrent call`);
        return cur;
      }
      lock = await acquireRotateLock();
      if (lock) break;
      if (Date.now() >= deadline) {
        console.log(`[hongguo] waited ${DEVICE_ROTATE_WAIT_MS}ms for a concurrent registration; registering anyway`);
        break;
      }
      waited = true;
      await sleep(DEVICE_ROTATE_POLL_MS);
    }

    const task = (async () => {
      try {
        // The lock may have come free because another call just finished.
        const latest = this._loadProfile();
        if (this._profileSatisfies(latest, failedDeviceId, needTicket)) return latest;
        return await this._register(failedDeviceId, needTicket);
      } finally {
        lock?.release();
      }
    })();
    this._inflightRegister = task;
    try {
      return await task;
    } finally {
      if (this._inflightRegister === task) {
        this._inflightRegister = null;
      }
    }
  }

  async _register(failedDeviceId, needTicket) {
    const nowMs = this.clock();
    const p = newAnonymousProfile(this.device, nowMs);
    const body = buildRegisterBody(p, nowMs);
    const qs = new URLSearchParams({ req_id: p.req_id, tt_data: "a" }).toString();
    const headers = {
      "User-Agent": userAgent(p.device),
      "Content-Type": "application/octet-stream;tt-data=a",
      "log-encode-type": "gzip",
      "sdk-version": "2",
      "passport-sdk-version": "5051452",
      "x-vc-bdturing-sdk-version": "4.0.3.cn",
      "x-ss-dp": AID,
      "X-SS-STUB": contentMD5(body),
      Cookie: "",
    };
    const { json, cookies } = await this._doRaw(
      "POST",
      `${this.registerOrigin}${PATH_REGISTER}?${qs}`,
      headers,
      body
    );
    const reg = parseRegister(json);
    p.device_id_str = reg.deviceId;
    p.install_id_str = reg.installId;
    if (cookies.ttreq) p.ttreq = cookies.ttreq;
    if (cookies["store-region"]) p.store_region = cookies["store-region"];
    if (cookies["store-region-src"]) p.store_region_src = cookies["store-region-src"];
    if (needTicket && Object.keys(cookies).length > 0 && !p.ttreq) {
      throw new HongguoError(ErrCode.AnonymousLimited, "guest ticket missing");
    }
    // Do not overwrite a newer device saved by a call that went ahead
    // without the lock.
    const latest = this._loadProfile();
    if (this._profileSatisfies(latest, failedDeviceId, needTicket)) {
      console.log(`[hongguo] keeping concurrently registered device=${latest.device_id_str}`);
      return latest;
    }
    this._saveProfile(p);
    console.log(
      `[hongguo] registered anonymous device=${p.device_id_str}${failedDeviceId ? ` (replaced ${failedDeviceId})` : ""}`
    );
    return p;
  }

  async ensureGuest(needTicket = true, ctx = null) {
    let p = this._loadProfile();
    if (p && !p.device) {
      p.device = this.device;
      this._saveProfile(p);
    }
    if (!guestReady(p) || (needTicket && !p.ttreq)) {
      p = await this._registerFreshProfile("", needTicket);
    }
    if (ctx) ctx.deviceId = p.device_id_str;
    return p;
  }

  // resetDevice replaces failedDeviceId with a fresh anonymous device. When
  // another call already replaced it, the stored device is reused as is.
  async resetDevice(failedDeviceId = "") {
    const targetFailed = failedDeviceId || this._loadProfile()?.device_id_str || "";
    return this._registerFreshProfile(targetFailed, false);
  }

  // _withFreshDevice runs fn, replacing the device and running it again when
  // the server rejects the device (or, for playback, limits it). fn receives
  // a context that records the device it used, so a rotation can tell
  // whether another call already replaced that device. A nested call passes
  // its caller's context as parentCtx and leaves the retries to the caller.
  async _withFreshDevice(playback, fn, parentCtx = null) {
    if (parentCtx) {
      return fn(parentCtx);
    }
    if (this.deviceResets <= 0) {
      return fn({ deviceId: "" });
    }
    for (let i = 0; ; i++) {
      const ctx = { deviceId: "" };
      try {
        return await fn(ctx);
      } catch (err) {
        const needsFresh =
          isErr(err, ErrCode.DeviceRejected) ||
          (playback && isErr(err, ErrCode.AnonymousLimited));
        if (i >= this.deviceResets || !needsFresh) {
          throw err;
        }
        const failedId = ctx.deviceId || this._loadProfile()?.device_id_str || "";
        const reason = err.bizCode ? `code=${err.bizCode}` : err.kind || err.message;
        console.log(
          `[hongguo] device ${failedId || "none"} refused (${reason}); rotating, attempt ${i + 1}/${this.deviceResets}`
        );
        try {
          await this.resetDevice(failedId);
        } catch (rotErr) {
          console.log(`[hongguo] device rotation failed: ${rotErr?.message || rotErr}`);
          throw err;
        }
      }
    }
  }

  async _cellChange(p, id, next) {
    const ticket = this.clock();
    const { query, headers } = signGET(
      signedCellChangePairs(id, next),
      ticket,
      p.device_id_str,
      VERSION_NAME
    );
    const { json } = await this._doRaw(
      "GET",
      `${this.apiOrigin}${PATH_CELL_CHANGE}?${query}`,
      this._anonymousHeaders(p, ticket, headers)
    );
    return parseCellChange(json);
  }

  _finishDiscover(items, next, more) {
    if (items.length === 0) {
      throw new HongguoError(ErrCode.AnonymousLimited, "discover returned empty");
    }
    const page = { items, hasMore: more.hasMore, cursor: "" };
    if (!more.hasMore || more.nextOffset <= 0 || more.items.length === 0) {
      return page;
    }
    const updated = {
      ...next,
      sessionId: more.sessionId || next.sessionId,
      offset: String(more.nextOffset),
    };
    try {
      page.cursor = encodeFeedCursor(updated);
    } catch {
      page.cursor = "";
    }
    return page;
  }

  async discover(opts = {}) {
    return this._withFreshDevice(false, async (ctx) => {
      const channel = resolveDiscoverChannel(opts.channel || "");
      const p = await this.ensureGuest(true, ctx);
      const id = this._identity(p);
      if (opts.cursor) {
        const next = decodeFeedCursor(opts.cursor);
        if (next.tabType !== String(channel.responseTab)) {
          throw new Error("discover cursor is not verified");
        }
        const more = await this._cellChange(p, id, next);
        return this._finishDiscover(more.items, next, more);
      }
      const ticket = this.clock();
      const { query, headers } = signGET(
        signedDiscoverPairsIn(id, channel.requestTab, channel.bottomTab),
        ticket,
        p.device_id_str,
        VERSION_NAME
      );
      let json;
      try {
        ({ json } = await this._doRaw(
          "GET",
          `${this.apiOrigin}${PATH_DISCOVER}?${query}`,
          this._anonymousHeaders(p, ticket, headers)
        ));
      } catch (err) {
        if (isErr(err, ErrCode.EndOfList)) {
          return { items: [], hasMore: false, cursor: "" };
        }
        throw err;
      }
      const parsed = parseDiscoverTab(json, channel.responseTab);
      const next = discoverContinuationTab(json, channel.responseTab);
      if (next) {
        next.offset = "0";
        const more = await this._cellChange(p, id, next);
        const merged = mergeSeries(parsed.items, more.items);
        return this._finishDiscover(merged, next, more);
      }
      if (parsed.items.length === 0) {
        throw new HongguoError(ErrCode.AnonymousLimited, "discover returned empty");
      }
      return { items: parsed.items, hasMore: parsed.hasMore, cursor: "" };
    });
  }

  async search(keyword, opts = {}) {
    return this._withFreshDevice(false, async (ctx) => {
      if (!keyword) throw new Error("missing search query");
      const tab = resolveSearchTab(opts.tab || "");
      const offset = searchOffset(opts.cursor || "");
      let selected = "";
      if (Array.isArray(opts.filters) && opts.filters.length > 0) {
        if (tab !== SEARCH_TAB_SHORT_PLAY) {
          throw new Error("search filters apply to the 综合 tab only");
        }
        const uniq = [];
        for (const f of opts.filters) {
          if (!SEARCH_FILTERS.has(f)) throw new Error(`unknown search filter ${f}`);
          if (!uniq.includes(f)) uniq.push(f);
        }
        selected = uniq.join(",");
      }
      const p = await this.ensureGuest(true, ctx);
      const count = opts.pageSize > 0 ? opts.pageSize : 20;
      const pairs = signedSearchPairsFor(this._identity(p), keyword, count, offset, tab);
      if (selected) pairs.push(["selected_items", selected]);
      const ticket = this.clock();
      const { query, headers } = signGET(pairs, ticket, p.device_id_str, VERSION_NAME);
      let json;
      try {
        ({ json } = await this._doRaw(
          "GET",
          `${this.apiOrigin}${PATH_SEARCH}?${query}`,
          this._anonymousHeaders(p, ticket, headers)
        ));
      } catch (err) {
        if (isErr(err, ErrCode.EndOfList)) {
          return { items: [], hasMore: false, cursor: "" };
        }
        throw err;
      }
      const parsed = parseSearchTab(json, Number(tab));
      if (parsed.items.length === 0) {
        throw new HongguoError(ErrCode.AnonymousLimited, "search returned empty");
      }
      const cursor =
        parsed.hasMore && parsed.nextOffset > offset ? String(parsed.nextOffset) : "";
      return { items: parsed.items, hasMore: parsed.hasMore, cursor };
    }, opts.ctx || null);
  }

  async suggest(prefix) {
    return this._withFreshDevice(false, async (ctx) => {
      const q = String(prefix || "").trim();
      if (!q) return [];
      const p = await this.ensureGuest(true, ctx);
      const ticket = this.clock();
      const { query, headers } = signGET(
        signedSuggestPairs(this._identity(p), q),
        ticket,
        p.device_id_str,
        VERSION_NAME
      );
      const { json } = await this._doRaw(
        "GET",
        `${this.apiOrigin}${PATH_SUGGEST}?${query}`,
        this._anonymousHeaders(p, ticket, headers)
      );
      return parseSuggest(json);
    });
  }

  async hotSearch() {
    return this._withFreshDevice(false, async (ctx) => {
      const p = await this.ensureGuest(true, ctx);
      const ticket = this.clock();
      const { query, headers } = signGET(
        signedHotSearchPairs(this._identity(p)),
        ticket,
        p.device_id_str,
        VERSION_NAME
      );
      const { json } = await this._doRaw(
        "GET",
        `${this.apiOrigin}${PATH_PLAN}?${query}`,
        this._anonymousHeaders(p, ticket, headers)
      );
      const hot = parseHotSearch(json);
      if (hot.boards.length === 0 && hot.guesses.length === 0) {
        throw new HongguoError(ErrCode.ContentUnavailable, "hot search empty");
      }
      return hot;
    });
  }

  async newReleases(q = {}) {
    return this._withFreshDevice(false, async (ctx) => {
      const cur = decodeShortCursor(q.cursor || "");
      let date = q.date || "";
      if (date && !validDate(date)) {
        throw new Error("date must be YYYYMMDD");
      }
      if (q.cursor && date && date !== cur.date) {
        throw new Error(`cursor belongs to ${cur.date}, not ${date}`);
      }
      if (q.cursor) {
        date = cur.date;
      }
      const p = await this.ensureGuest(true, ctx);
      const ticket = this.clock();
      const { query, headers } = signGET(
        signedNewReleasePairs(this._identity(p), date, cur),
        ticket,
        p.device_id_str,
        VERSION_NAME
      );
      const { json } = await this._doRaw(
        "GET",
        `${this.apiOrigin}${PATH_SUBSCRIBE_LIST}?${query}`,
        this._anonymousHeaders(p, ticket, headers),
        null,
        q.signal || null
      );
      const res = parseNewReleases(json);
      const pageDate = res.date || date;
      let cursor = "";
      if (res.hasMore && res.items.length > 0 && res.nextOffset > cur.offset) {
        cursor = encodeShortCursor({
          offset: res.nextOffset,
          session: res.sessionId || cur.session,
          date: pageDate,
        });
      }
      return {
        date: pageDate,
        dates: res.dates,
        items: res.items,
        hasMore: res.hasMore,
        cursor,
      };
    });
  }

  _cacheEpisodeDurations(episodes) {
    for (const ep of episodes || []) {
      if (ep.id && ep.durationSeconds > 0) {
        try {
          host.cache.set(
            DURATION_CACHE_PREFIX + ep.id,
            String(ep.durationSeconds * 1000 + 1000),
            DURATION_CACHE_TTL_SEC
          );
        } catch {
          // Ignore cache error.
        }
      }
    }
  }

  async getSeriesDetail(seriesID, parentCtx = null) {
    return this._withFreshDevice(false, async (ctx) => {
      if (!validID(seriesID)) {
        throw new HongguoError(ErrCode.InvalidOptions, "invalid series ID", { invalidId: true });
      }
      const p = await this.ensureGuest(true, ctx);
      const body = seriesBody(seriesID);
      const ticket = this.clock();
      const { query, headers } = signPOST(
        PATH_SERIES,
        deviceQueryPairs(this._identity(p)),
        ticket,
        p.device_id_str,
        VERSION_NAME,
        body
      );
      const { json } = await this._doRaw(
        "POST",
        `${this.apiOrigin}${PATH_SERIES}?${query}`,
        this._anonymousHeaders(p, ticket, headers),
        body
      );
      const detail = parseSeries(json);
      this._cacheEpisodeDurations(detail.episodes);
      return detail;
    }, parentCtx);
  }

  async getSeriesBatch(seriesIDs, parentCtx = null) {
    return this._withFreshDevice(false, async (ctx) => {
      const ids = [];
      const seen = new Set();
      for (const id of seriesIDs || []) {
        if (!validID(id)) continue;
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      const found = {};
      for (let start = 0; start < ids.length; start += SERIES_BATCH_SIZE) {
        const chunk = ids.slice(start, start + SERIES_BATCH_SIZE);
        const body = seriesBatchBody(chunk);
        const p = await this.ensureGuest(true, ctx);
        const ticket = this.clock();
        const { query, headers } = signPOST(
          PATH_SERIES_BATCH,
          deviceQueryPairs(this._identity(p)),
          ticket,
          p.device_id_str,
          VERSION_NAME,
          body
        );
        const { json } = await this._doRaw(
          "POST",
          `${this.apiOrigin}${PATH_SERIES_BATCH}?${query}`,
          this._anonymousHeaders(p, ticket, headers),
          body
        );
        const got = parseSeriesBatch(json);
        for (const [id, detail] of Object.entries(got)) {
          found[id] = detail;
          this._cacheEpisodeDurations(detail.episodes);
        }
      }
      return ids.filter((id) => found[id]).map((id) => found[id]);
    }, parentCtx);
  }

  async getAlbum(albumID, parentCtx = null) {
    return this._withFreshDevice(false, async (ctx) => {
      if (!validID(albumID)) throw new HongguoError(ErrCode.InvalidOptions, "invalid album ID", { invalidId: true });
      const p = await this.ensureGuest(true, ctx);
      const body = albumBody(albumID);
      const ticket = this.clock();
      const { query, headers } = signPOST(
        PATH_ALBUM,
        deviceQueryPairs(this._identity(p)),
        ticket,
        p.device_id_str,
        VERSION_NAME,
        body
      );
      const { json } = await this._doRaw(
        "POST",
        `${this.apiOrigin}${PATH_ALBUM}?${query}`,
        this._anonymousHeaders(p, ticket, headers),
        body
      );
      return parseAlbum(json, albumID);
    }, parentCtx);
  }

  async seriesRecommend(seriesID) {
    return this._withFreshDevice(false, async (ctx) => {
      if (!validID(seriesID)) throw new HongguoError(ErrCode.InvalidOptions, "invalid series ID", { invalidId: true });
      const p = await this.ensureGuest(true, ctx);
      const ticket = this.clock();
      const { query, headers } = signGET(
        signedPlanPairs(this._identity(p), seriesID, host.crypto.uuid()),
        ticket,
        p.device_id_str,
        VERSION_NAME
      );
      const { json } = await this._doRaw(
        "GET",
        `${this.apiOrigin}${PATH_PLAN}?${query}`,
        this._anonymousHeaders(p, ticket, headers)
      );
      const cells = parsePlanCells(json);
      for (const cell of cells) {
        if (cell.showType === SHOW_TYPE_DETAIL_RELATED_VIDEO && cell.items.length > 0) {
          return { cellTitle: cell.cellName, sessionId: cell.sessionId, items: cell.items };
        }
      }
      for (const cell of cells) {
        if (cell.items.length > 0) {
          return { cellTitle: cell.cellName, sessionId: cell.sessionId, items: cell.items };
        }
      }
      throw new HongguoError(ErrCode.ContentUnavailable, "no related recommendations");
    });
  }

  async _seriesSeasons(seriesID, ctx = null) {
    const p = await this.ensureGuest(true, ctx);
    const ticket = this.clock();
    const { query, headers } = signGET(
      signedSeasonPairs(this._identity(p), seriesID, host.crypto.uuid()),
      ticket,
      p.device_id_str,
      VERSION_NAME
    );
    const { json } = await this._doRaw(
      "GET",
      `${this.apiOrigin}${PATH_PLAN}?${query}`,
      this._anonymousHeaders(p, ticket, headers)
    );
    return parseSeasons(json);
  }

  // seasons lists the seasons of seriesID. preloadedSeries is the series, or
  // a promise of it, when the caller reads the details anyway; the season
  // list is requested at once, alongside the details.
  async seasons(seriesID, preloadedSeries = null) {
    return this._withFreshDevice(false, async (ctx) => {
      const listP = this._seriesSeasons(seriesID, ctx).then(
        (list) => ({ list }),
        (err) => ({ list: [], err })
      );
      const series = await (preloadedSeries ||
        this.getSeriesDetail(seriesID, ctx).then((d) => d.series));
      const { list, err } = await listP;
      if (err && isErr(err, ErrCode.DeviceRejected)) throw err;
      if (list.length > 0) {
        for (const s of list) {
          if (s.seriesId === series.id) s.status = series.status;
        }
        sortSeasons(list);
        return {
          id: series.relatedAlbumId,
          title: seasonBaseTitle(series.title),
          seasonCount: list.length,
          seasons: list,
        };
      }
      if (series.relatedAlbumId) {
        try {
          const album = await this.getAlbum(series.relatedAlbumId, ctx);
          if (album.seasons.length > 0) return album;
        } catch {
          // Fallback to search.
        }
      }
      const base = seasonBaseTitle(series.title);
      if (!series.isMultiSeason && !series.relatedAlbumId) {
        return {
          id: "",
          title: base,
          seasonCount: 1,
          seasons: [
            {
              seriesId: series.id,
              title: series.title,
              index: 1,
              coverUrl: series.coverUrl,
              episodeCount: series.episodeCount,
              status: series.status,
            },
          ],
        };
      }
      const out = [
        {
          seriesId: series.id,
          title: series.title,
          index: series.seasonIndex,
          coverUrl: series.coverUrl,
          episodeCount: series.episodeCount,
          status: series.status,
        },
      ];
      const chars = Array.from(base);
      const q = chars.length > 6 ? chars.slice(0, 6).join("") : base;
      let page = null;
      try {
        page = await this.search(q, { pageSize: 20, ctx });
      } catch (err) {
        if (!isErr(err, ErrCode.AnonymousLimited)) throw err;
      }
      const candidates = [];
      for (const item of page?.items || []) {
        if (item.id === series.id || candidates.length >= SERIES_BATCH_SIZE) continue;
        const candBase = seasonBaseTitle(item.title);
        if (candBase !== base && !candBase.startsWith(base) && !base.startsWith(candBase)) {
          continue;
        }
        candidates.push(item.id);
      }
      if (candidates.length > 0) {
        const details = await this.getSeriesBatch(candidates, ctx);
        for (const d of details) {
          if (series.relatedAlbumId && d.series.relatedAlbumId !== series.relatedAlbumId) continue;
          out.push({
            seriesId: d.series.id,
            title: d.series.title,
            index: d.series.seasonIndex,
            coverUrl: d.series.coverUrl,
            episodeCount: d.series.episodeCount,
            status: d.series.status,
          });
        }
      }
      sortSeasons(out);
      return { id: series.relatedAlbumId, title: base, seasonCount: out.length, seasons: out };
    });
  }

  async _shortFilterPost(body, ctx = null) {
    const p = await this.ensureGuest(true, ctx);
    const ticket = this.clock();
    const { query, headers } = signPOST(
      PATH_SHORT_FILTER,
      deviceQueryPairs(this._identity(p)),
      ticket,
      p.device_id_str,
      VERSION_NAME,
      body
    );
    const { json } = await this._doRaw(
      "POST",
      `${this.distOrigin}${PATH_SHORT_FILTER}?${query}`,
      this._anonymousHeaders(p, ticket, headers),
      body
    );
    return parseShortFilter(json);
  }

  async shortFilterPanel(genre = "") {
    return this._withFreshDevice(false, async (ctx) => {
      const scene = shortFilterScene(genre);
      const body = shortFilterBody(scene, null, true, { offset: 0, seen: [], session: "" });
      const res = await this._shortFilterPost(body, ctx);
      if (res.rows.length === 0) {
        throw new HongguoError(ErrCode.ContentUnavailable, "filter panel empty");
      }
      return res.rows;
    });
  }

  _loadSeen(cur) {
    if (cur.seen && cur.seen.length > 0) return cur.seen;
    if (!cur.seenKey) return [];
    try {
      const raw = host.cache.get(SEEN_CACHE_PREFIX + cur.seenKey);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((id) => typeof id === "string" && id) : [];
    } catch {
      return [];
    }
  }

  // _saveSeen stores the IDs seen up to the next page under a key of its
  // own and returns the key. Every page gets a new key, never the one its
  // cursor came with: a cursor sent again, say after the host dropped a
  // late answer, must find the same IDs and so get the same page. Old keys
  // lapse with their TTL, or go first when the cache is full.
  _saveSeen(prevSeen, newIds) {
    const key = hexEncode(host.crypto.randomBytes(6));
    const merged = [];
    const uniq = new Set();
    for (const id of prevSeen) {
      if (id && !uniq.has(id)) {
        uniq.add(id);
        merged.push(id);
      }
    }
    for (const id of newIds) {
      if (id && !uniq.has(id)) {
        uniq.add(id);
        merged.push(id);
      }
    }
    const bounded =
      merged.length > MAX_CACHED_SEEN ? merged.slice(merged.length - MAX_CACHED_SEEN) : merged;
    try {
      host.cache.set(SEEN_CACHE_PREFIX + key, JSON.stringify(bounded), SEEN_CACHE_TTL_SEC);
    } catch {
      // Ignore cache quota errors; tolerate minor duplicates if cache drops seen IDs.
    }
    return key;
  }

  async shortFilter(q = {}) {
    return this._withFreshDevice(false, async (ctx) => {
      let selections = q.selections || {};
      for (const [key, values] of Object.entries(selections)) {
        if (!SHORT_FILTER_KEYS.includes(key)) {
          throw new Error(`unknown short filter row ${key}`);
        }
        for (const v of values) {
          if (!String(v).trim()) throw new Error(`empty value for short filter row ${key}`);
        }
      }
      const cur = decodeShortCursor(q.cursor || "");
      if (q.cursor) {
        if (Object.keys(selections).length === 0) {
          selections = cur.selections || {};
        } else if (!sameSelections(selections, cur.selections)) {
          throw new Error("cursor continues a different filter");
        }
      }
      const seen = this._loadSeen(cur);
      const genre =
        Array.isArray(selections.genre) && selections.genre.length === 1
          ? selections.genre[0]
          : "";
      const scene = shortFilterScene(genre);
      const body = shortFilterBody(scene, selections, false, { ...cur, seen });
      const res = await this._shortFilterPost(body, ctx);
      if (res.items.length === 0 && cur.offset === 0) {
        throw new HongguoError(ErrCode.ContentUnavailable, "no matching series");
      }
      const ids = res.items.map((it) => it.id);
      let cursor = "";
      if (res.hasMore && ids.length > 0 && res.nextOffset > cur.offset) {
        const seenKey = this._saveSeen(seen, ids);
        cursor = encodeShortCursor({
          offset: res.nextOffset,
          seenKey,
          session: res.sessionId,
          selections,
        });
      }
      return { items: res.items, hasMore: res.hasMore, cursor };
    });
  }

  async shortRank(q = {}) {
    return this._withFreshDevice(false, async (ctx) => {
      const cur = decodeShortCursor(q.cursor || "");
      let content = String(q.content || "").trim();
      let board = String(q.board || "").trim();
      if (q.cursor) {
        if ((content && content !== cur.content) || (board && board !== cur.board)) {
          throw new Error("cursor continues a different ranking");
        }
        content = cur.content;
        board = cur.board;
      }
      if (!content) content = "all";
      const seen = this._loadSeen(cur);
      const p = await this.ensureGuest(true, ctx);
      const ticket = this.clock();
      const { query, headers } = signGET(
        signedShortRankPairs(this._identity(p), content, board, { ...cur, seen }),
        ticket,
        p.device_id_str,
        VERSION_NAME
      );
      const { json } = await this._doRaw(
        "GET",
        `${this.apiOrigin}${PATH_RANK_CELLS}?${query}`,
        this._anonymousHeaders(p, ticket, headers)
      );
      const res = parseShortRank(json);
      if (res.items.length === 0 && cur.offset === 0) {
        throw new HongguoError(ErrCode.ContentUnavailable, "ranking empty");
      }
      let outContent = "";
      let outBoard = "";
      for (const c of res.contents) {
        if (!c.selected) continue;
        outContent = c.id;
        for (const b of c.boards) {
          if (b.selected) outBoard = b.id;
        }
      }
      if (!outContent) {
        outContent = content;
        outBoard = board;
      }
      const seenCount = seen.length || cur.offset;
      const items = res.items.map((it) => ({ ...it, position: it.position + seenCount }));
      const ids = res.items.map((it) => it.seriesId || it.actorId);
      let cursor = "";
      if (res.hasMore && ids.length > 0 && res.nextOffset > cur.offset) {
        const seenKey = this._saveSeen(seen, ids);
        cursor = encodeShortCursor({
          offset: res.nextOffset,
          seenKey,
          session: res.sessionId,
          content: outContent,
          board: outBoard,
        });
      }
      return {
        contents: res.contents,
        content: outContent,
        board: outBoard,
        version: res.version,
        items,
        hasMore: res.hasMore,
        cursor,
      };
    });
  }

  async person(userID) {
    return this._withFreshDevice(false, async (ctx) => {
      if (!validID(userID)) throw new HongguoError(ErrCode.InvalidOptions, "invalid user ID", { invalidId: true });
      const p = await this.ensureGuest(true, ctx);
      const ticket = this.clock();
      const { query, headers } = signGET(
        signedProfilePairs(this._identity(p), userID),
        ticket,
        p.device_id_str,
        VERSION_NAME
      );
      const { json } = await this._doRaw(
        "GET",
        `${this.apiOrigin}${PATH_PROFILE}?${query}`,
        this._anonymousHeaders(p, ticket, headers)
      );
      const person = parseProfile(json);
      if (!person.name) {
        throw new HongguoError(ErrCode.ContentUnavailable, "person not found");
      }
      return person;
    });
  }

  async _postUserProfile(p, userID, body) {
    const path = PATH_USER_WORKS(userID);
    const ticket = this.clock();
    const { query, headers } = signPOST(
      path,
      deviceQueryPairs(this._identity(p)),
      ticket,
      p.device_id_str,
      VERSION_NAME,
      body
    );
    const { json } = await this._doRaw(
      "POST",
      `${this.apiOrigin}${path}?${query}`,
      this._anonymousHeaders(p, ticket, headers),
      body
    );
    return json;
  }

  async personWorks(userID, cursor = "") {
    return this._withFreshDevice(false, async (ctx) => {
      if (!validID(userID)) throw new HongguoError(ErrCode.InvalidOptions, "invalid user ID", { invalidId: true });
      const cur = decodeWorksCursor(cursor);
      if (cursor && cur.userId !== userID) {
        throw new Error("cursor belongs to another person");
      }
      const p = await this.ensureGuest(true, ctx);
      let tab = cur.tab;
      if (!tab) {
        const tabsJson = await this._postUserProfile(p, userID, userWorksTabsBody(userID));
        tab = parseWorksTab(tabsJson);
        if (!tab) return { items: [], hasMore: false, cursor: "" };
      }
      const worksJson = await this._postUserProfile(p, userID, userWorksBody(userID, cur.next, tab));
      const res = parseUserWorks(worksJson);
      let nextCursor = "";
      if (res.hasMore && res.cursor && res.items.length > 0) {
        nextCursor = encodeWorksCursor({ userId: userID, next: res.cursor, tab });
      }
      return { items: res.items, hasMore: res.hasMore, cursor: nextCursor };
    });
  }

  async _episodeDurationMs(seriesID, episodeID, ctx = null) {
    try {
      const cached = host.cache.get(DURATION_CACHE_PREFIX + episodeID);
      if (cached) {
        const n = Number(cached);
        if (n > 0) return n;
      }
    } catch {
      // Ignore cache error.
    }
    const detail = await this.getSeriesDetail(seriesID, ctx);
    for (const ep of detail.episodes) {
      if (ep.id === episodeID) {
        return ep.durationSeconds > 0 ? ep.durationSeconds * 1000 + 1000 : DANMAKU_FALLBACK_DURATION;
      }
    }
    throw new Error(`episode ${episodeID} is not in series ${seriesID}`);
  }

  async listDanmaku(seriesID, episodeID, opts = {}) {
    return this._withFreshDevice(false, async (ctx) => {
      if (!validID(seriesID)) throw new HongguoError(ErrCode.InvalidOptions, "invalid series ID", { invalidId: true });
      if (!validID(episodeID)) throw new HongguoError(ErrCode.InvalidOptions, "invalid episode ID", { invalidId: true });
      const cur = decodeDanmakuCursor(opts.cursor || "");
      if (opts.cursor && cur.episodeId !== episodeID) {
        throw new Error("cursor belongs to another episode");
      }
      if (!opts.cursor) {
        cur.duration = await this._episodeDurationMs(seriesID, episodeID, ctx);
        cur.start = opts.startMs || 0;
        if (cur.start >= cur.duration) {
          return { items: [], startMs: cur.start, endMs: cur.start, total: 0, hasMore: false, cursor: "" };
        }
      }
      const body = danmakuBody(
        seriesID,
        episodeID,
        cur.start,
        cur.duration,
        opts.pageSize || 0,
        cur.next
      );
      const p = await this.ensureGuest(true, ctx);
      const path = PATH_DANMAKU(episodeID);
      const ticket = this.clock();
      const { query, headers } = signPOST(
        path,
        deviceQueryPairs(this._identity(p)),
        ticket,
        p.device_id_str,
        VERSION_NAME,
        body
      );
      const { json } = await this._doRaw(
        "POST",
        `${this.apiOrigin}${path}?${query}`,
        this._anonymousHeaders(p, ticket, headers),
        body
      );
      const res = parseDanmaku(json);
      let hasMore = false;
      let nextCursor = "";
      if (res.hasMore && res.next > cur.start && res.next < cur.duration) {
        hasMore = true;
        nextCursor = encodeDanmakuCursor({
          episodeId: episodeID,
          duration: cur.duration,
          start: res.next,
          next: res.cursor,
        });
      }
      return {
        items: res.items,
        startMs: res.start || cur.start,
        endMs: res.end,
        total: res.total,
        hasMore,
        cursor: nextCursor,
      };
    });
  }

  async resolvePlayback(episodeID) {
    if (!validID(episodeID)) throw new HongguoError(ErrCode.InvalidOptions, "invalid episode ID", { invalidId: true });
    const v5Body = playbackV5Body(episodeID);
    return this._withFreshDevice(true, async (ctx) => {
      const p = await this.ensureGuest(true, ctx);
      let json = null;
      let lastErr = null;

      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const ticket = this.clock();
          const { query, headers } = signPlaybackV5(
            playbackV5Pairs(this._identity(p)),
            ticket,
            v5Body
          );
          const reqHeaders = this._anonymousHeaders(p, ticket, headers);
          reqHeaders["User-Agent"] = playbackUserAgent(this._deviceOf(p));
          reqHeaders["Accept"] = "application/json; charset=utf-8,application/x-protobuf";
          reqHeaders["x-xs-from-web"] = "0";
          reqHeaders["Content-Encoding"] = "gzip";
          ({ json } = await this._doRaw(
            "POST",
            `${this.apiOrigin}${PATH_PLAYBACK_V5}?${query}`,
            reqHeaders,
            v5Body
          ));
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isErr(err, ErrCode.AnonymousLimited) || attempt === 1) {
            break;
          }
          await sleep(300);
        }
      }

      if (lastErr) {
        const routeUnavailable =
          lastErr instanceof HongguoError &&
          lastErr.kind === ErrCode.APIError &&
          (lastErr.httpStatus === 404 || lastErr.httpStatus === 405);
        if (!isErr(lastErr, ErrCode.AnonymousLimited) && !routeUnavailable) {
          throw lastErr;
        }
        const legacyBody = playbackBody(episodeID);
        const ticket = this.clock();
        const { query, headers } = signPlaybackPOST(
          PATH_PLAYBACK,
          deviceQueryPairs(this._identity(p)),
          ticket,
          p.device_id_str,
          VERSION_NAME,
          legacyBody
        );
        try {
          ({ json } = await this._doRaw(
            "POST",
            `${this.apiOrigin}${PATH_PLAYBACK}?${query}`,
            this._anonymousHeaders(p, ticket, headers),
            legacyBody
          ));
        } catch (legacyErr) {
          const legacyRouteUnavail =
            legacyErr instanceof HongguoError &&
            legacyErr.kind === ErrCode.APIError &&
            (legacyErr.httpStatus === 404 || legacyErr.httpStatus === 405);
          throw legacyRouteUnavail ? lastErr : legacyErr;
        }
      }
      return parsePlayback(json, episodeID);
    });
  }

  contentKey(pb) {
    if (!pb || !pb.protected) return null;
    return deriveContentKey(pb.keyMaterial);
  }
}
