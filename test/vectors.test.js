import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installHost } from "./host.js";
import { fromUtf8, gzipEncode, hexDecode, hexEncode, md5Bytes } from "../src/crypto/bytes.js";
import { sha512 } from "../src/crypto/sha512.js";
import { sm3Sum } from "../src/crypto/sm3.js";
import { deriveContentKey } from "../src/crypto/spade.js";
import { ttEncrypt } from "../src/crypto/tt_encrypt.js";
import { decodePlaybackURL } from "../src/protocol/playback_url.js";
import { buildBootstrapPlaintext, registerHeader } from "../src/protocol/register.js";
import {
  albumBody,
  danmakuBody,
  playbackBody,
  playbackV5Body,
  playbackV5PlainBody,
  seriesBatchBody,
  seriesBody,
  shortFilterBody,
  userWorksBody,
  userWorksTabsBody,
} from "../src/protocol/request.js";
import { encryptPlaybackV5 } from "../src/sign/aes.js";
import {
  f13V5,
  f13V5HeadMD5,
  f13V5HeadSHA,
  f13V5Tail,
  f13V5Variant,
} from "../src/sign/f13.js";
import { xGorgonFlags } from "../src/sign/gorgon.js";
import { heliosV5 } from "../src/sign/helios.js";
import {
  assembleMedusaV5,
  defaultMedusaEnv,
  keyHash,
  medusaDeviceOf,
  medusaV5DeviceBlock,
  newMedusaV5Input,
  xmxor,
} from "../src/sign/medusa.js";
import { argusHeader, ladonHeader } from "../src/sign/playback.js";
import { encodeQuery, signPlaybackPOST, signPlaybackV5, signRequest } from "../src/sign/request.js";
import {
  deviceQueryPairs,
  playbackV5Pairs as buildPlaybackV5Pairs,
  signedSuggestPairs,
} from "../src/protocol/request.js";
import {
  encodeDanmakuCursor,
  encodeFeedCursor,
  encodeShortCursor,
  encodeWorksCursor,
} from "../src/protocol/cursor.js";
import * as parsers from "../src/protocol/parse.js";
import { parseJSONSafe } from "../src/protocol/json.js";
import { DEFAULT_DEVICE } from "../src/protocol/app.js";

installHost();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "vectors", "vectors.json"), "utf8")
);

test("SHA-512 matches Go crypto/sha512 byte-for-byte", () => {
  for (const tc of vectors.sha512) {
    const got = hexEncode(sha512(hexDecode(tc.inputHex)));
    assert.equal(got, tc.digest);
  }
});

test("SM3 matches openhongguo byte-for-byte", () => {
  for (const tc of vectors.sm3) {
    const got = hexEncode(sm3Sum(hexDecode(tc.inputHex)));
    assert.equal(got, tc.digest);
  }
});

test("DRM spade_a key derivation matches openhongguo (v1 + app_v2 + web_v2)", () => {
  for (const tc of vectors.spade) {
    const got = deriveContentKey(tc.spadeA);
    assert.equal(got.hex, tc.hex);
    assert.equal(got.version, tc.version);
  }
  for (const bad of ["", "not base64 !!", "AAAA", "MTIzNDU2Nzg5MDEyMzQ1Ng=="]) {
    assert.throws(() => deriveContentKey(bad));
  }
});

test("TTEncrypt matches openhongguo byte-for-byte", () => {
  for (const tc of vectors.ttEncrypt) {
    const got = hexEncode(ttEncrypt(hexDecode(tc.inputHex)));
    assert.equal(got, tc.outputHex);
  }
});

test("Playback URL decoding (plaintext, base64, 0xa8 AES-CBC) matches openhongguo", () => {
  for (const tc of vectors.playbackUrl) {
    assert.equal(decodePlaybackURL(tc.value, tc.seed), tc.want);
  }
});

test("Medusa keyHash and xmxor match openhongguo byte-for-byte", () => {
  for (const tc of vectors.keyHash) {
    const { hash, seed } = keyHash(hexDecode(tc.signKeyHex), tc.random);
    assert.equal(hexEncode(hash), tc.hashHex);
    assert.equal(hexEncode(seed), tc.seedHex);
  }
  for (const tc of vectors.xmxor) {
    const got = hexEncode(xmxor(hexDecode(tc.dataHex), hexDecode(tc.keyHex)));
    assert.equal(got, tc.outputHex);
  }
});

test("encryptPlaybackV5 matches openhongguo across all timestamp % 4 modes", () => {
  for (const tc of vectors.encryptPlaybackV5) {
    const got = hexEncode(
      encryptPlaybackV5(
        hexDecode(tc.dataHex),
        hexDecode(tc.keyHex),
        hexDecode(tc.ivHex),
        tc.timestamp
      )
    );
    assert.equal(got, tc.outputHex);
  }
});

test("f13V5 variant, MD5 head, SHA head, tail, and full digest match openhongguo", () => {
  for (const tc of vectors.f13V5) {
    const q = hexDecode(tc.querySM3Hex);
    const b = hexDecode(tc.bodyMD5Hex);
    assert.equal(f13V5Variant(q, b, tc.ts), tc.variant);
    assert.equal(hexEncode(f13V5HeadMD5(q, b, tc.ts)), tc.headMD5Hex);
    assert.equal(hexEncode(f13V5HeadSHA(q, b, tc.ts)), tc.headSHAHex);
    assert.equal(hexEncode(f13V5Tail(hexDecode(tc.headMD5Hex))), tc.tailHex);
    const full = f13V5(q, b, tc.ts);
    if (tc.supported) {
      assert.ok(full);
      assert.equal(hexEncode(full), tc.fullHex);
    } else {
      assert.equal(full, null);
    }
  }
});

test("x-gorgon matches openhongguo byte-for-byte", () => {
  for (const tc of vectors.gorgon) {
    const body = tc.hasBody ? hexDecode(tc.bodyHex) : null;
    const flags = hexDecode(tc.flagsHex);
    const got = xGorgonFlags(tc.query, body, tc.hasBody, tc.khronos, tc.random, flags);
    assert.equal(got, tc.want);
  }
});

test("x-helios v5 matches openhongguo byte-for-byte", () => {
  for (const tc of vectors.helios) {
    assert.equal(heliosV5(tc.ts, tc.random), tc.want);
  }
});

test("medusaDeviceOf and medusaV5DeviceBlock match openhongguo byte-for-byte", () => {
  for (const tc of vectors.medusaDevice) {
    const env = defaultMedusaEnv(tc.launchMillis);
    env.device = medusaDeviceOf(tc.query, tc.deviceId);
    assert.ok(env.device);
    const block = medusaV5DeviceBlock(tc.deviceId, env, tc.nowMillis);
    assert.equal(hexEncode(block), tc.blockHex);
  }
});

test("assembleMedusaV5 (emulator + device, GET + POST) matches openhongguo byte-for-byte", () => {
  for (const tc of vectors.medusaV5) {
    const body = tc.hasBody ? hexDecode(tc.bodyHex) : null;
    const input = newMedusaV5Input(tc.query, body, tc.ts);
    assert.ok(input);
    const env = defaultMedusaEnv(tc.launchMillis);
    env.pid = tc.pid;
    env.ppid = tc.ppid;
    env.status = tc.status;
    env.counter = tc.counter;
    env.device = tc.useDevice ? medusaDeviceOf(tc.query, tc.deviceId) : null;
    const got = assembleMedusaV5(input, tc.deviceId, env, {
      message: tc.rndMessage,
      key: tc.rndKey,
      packed: tc.rndPacked,
    });
    assert.equal(got, tc.want);
  }
});

test("Argus 551 and Ladon match openhongguo golden vectors byte-for-byte", () => {
  for (const tc of vectors.argus) {
    const body = hexDecode(tc.bodyHex);
    const bodyMD5 = body.length > 0 ? md5Bytes(body) : new Uint8Array(16);
    const got = argusHeader(
      tc.query,
      bodyMD5,
      tc.ts,
      tc.nonce,
      tc.aid,
      tc.deviceId,
      tc.installId
    );
    assert.equal(got, tc.want);
  }
  for (const tc of vectors.ladon) {
    assert.equal(ladonHeader(tc.ts, tc.nonce, tc.aid), tc.want);
  }
});

test("encodeQuery matches openhongguo byte-for-byte", () => {
  for (const tc of vectors.encodeQuery) {
    assert.equal(encodeQuery(tc.pairs), tc.want);
  }
});

test("JSON request bodies match openhongguo byte-for-byte", () => {
  const rb = vectors.requestBodies;
  assert.equal(fromUtf8(seriesBody("7690184933037329432")), rb.series);
  assert.equal(
    fromUtf8(seriesBatchBody(["7690184933037329432", "7100000000000101"])),
    rb.seriesBatch
  );
  assert.equal(fromUtf8(albumBody("7690184933037329432")), rb.album);
  assert.equal(fromUtf8(playbackBody("7690261304497458201")), rb.playback);
  assert.equal(
    fromUtf8(shortFilterBody("default", null, true, { offset: 0, seen: [], session: "" })),
    rb.shortFilterPanel
  );
  assert.equal(
    fromUtf8(
      shortFilterBody(
        "comic_series",
        { genre: ["comic_series"], sort: ["hot_score"] },
        false,
        { offset: 18, seen: ["111", "222"], session: "sess-1" }
      )
    ),
    rb.shortFilterQuery
  );
  assert.equal(fromUtf8(userWorksTabsBody("12345678")), rb.userWorksTabs);
  assert.equal(
    fromUtf8(userWorksBody("12345678", "cur-1", { tab: 8, sub: 100 })),
    rb.userWorks
  );
  assert.equal(
    fromUtf8(danmakuBody("7690184933037329432", "7690261304497458201", 30000, 135000, 90, "")),
    rb.danmaku
  );
  // The V5 playback body is gzip; the JSON inside must match Go's.
  assert.equal(fromUtf8(playbackV5PlainBody("7690261304497458201")), rb.playbackV5Plain);
  assert.equal(fromUtf8(host.encoding.gunzip(playbackV5Body("7690261304497458201"))), rb.playbackV5Plain);
});

test("Register plaintext and gzip round-trip match openhongguo", () => {
  const rp = vectors.registerPlaintext;
  const header = registerHeader(
    {
      cdid: rp.cdid,
      openudid: rp.openudid,
      clientudid: rp.clientudid,
      oaid: rp.oaid,
      req_id: rp.reqId,
    },
    rp.generatedAtMs
  );
  const plain = buildBootstrapPlaintext(header, rp.generatedAtMs);
  assert.equal(fromUtf8(plain), rp.plaintext);

  // Verify pure-JS gzipEncode round-trips cleanly through host.encoding.gunzip
  const gz = gzipEncode(plain, Math.trunc(rp.generatedAtMs / 1000));
  assert.equal(fromUtf8(host.encoding.gunzip(gz)), rp.plaintext);

  const pbGz = playbackV5Body("7690261304497458201");
  assert.equal(
    fromUtf8(host.encoding.gunzip(pbGz)),
    fromUtf8(playbackV5PlainBody("7690261304497458201"))
  );
});

const SIGN_IDENTITY = {
  deviceId: "7123456789012345678",
  installId: "7123456789012345679",
  cdid: "11111111-1111-4111-8111-111111111111",
  openudid: "0123456789abcdef",
  device: DEFAULT_DEVICE,
};

test("whole signed requests (query and every header) match openhongguo", () => {
  const builders = {
    get: () => signedSuggestPairs(SIGN_IDENTITY, "家里家外"),
    post: () => deviceQueryPairs(SIGN_IDENTITY),
    playbackPost: () => deviceQueryPairs(SIGN_IDENTITY),
    playbackV5: () => buildPlaybackV5Pairs(SIGN_IDENTITY),
  };
  assert.equal(vectors.signed.length, 4);
  for (const tc of vectors.signed) {
    // The pair builders agree with Go, too.
    assert.deepEqual(builders[tc.kind](), tc.pairs, `${tc.kind} pairs`);
    const e = tc.entropy;
    const entropy = {
      envLaunch: e.EnvLaunch,
      envPID: e.EnvPID,
      nowSecs: e.NowSecs,
      messageRandom: e.MessageRandom,
      random: e.Random,
      packedRandom: e.PackedRandom,
      gorgonRandom: e.GorgonRandom,
      heliosRandom: e.HeliosRandom,
    };
    const env = defaultMedusaEnv(tc.launchMillis);
    env.pid = tc.pid;
    env.ppid = tc.ppid;
    env.counter = tc.counter;
    // As in production, the device layout comes from the signed query.
    delete env.device;
    const body = tc.hasBody ? hexDecode(tc.bodyHex) : null;
    let got;
    switch (tc.kind) {
      case "get":
        got = signRequest("/reading/bookapi/search/tab/v", tc.pairs, tc.nowMillis, tc.deviceId, tc.versionName, null, entropy, env);
        break;
      case "post":
        got = signRequest(tc.path, tc.pairs, tc.nowMillis, tc.deviceId, tc.versionName, body, entropy, env);
        break;
      case "playbackPost":
        got = signPlaybackPOST(tc.path, tc.pairs, tc.nowMillis, tc.deviceId, tc.versionName, body, entropy, env, {
          argus: tc.argusNonce,
          ladon: tc.ladonNonce,
        });
        break;
      case "playbackV5":
        got = signPlaybackV5(tc.pairs, tc.nowMillis, body, entropy, env);
        break;
    }
    assert.equal(got.query, tc.query, `${tc.kind} query`);
    assert.deepEqual(got.headers, tc.headers, `${tc.kind} headers`);
  }
});

test("cursor encoding matches openhongguo byte-for-byte", () => {
  for (const tc of vectors.cursors) {
    const f = tc.fields;
    let got;
    switch (tc.kind) {
      case "feed":
        got = encodeFeedCursor({
          cellId: f.CellID,
          sessionId: f.SessionID,
          clientTemplate: f.ClientTemplate,
          showType: f.ShowType,
          tabType: f.TabType,
          offset: f.Offset,
        });
        break;
      case "short":
        got = encodeShortCursor({
          offset: f.o,
          seen: f.s,
          session: f.x,
          selections: f.q,
          content: f.c,
          board: f.b,
          date: f.d,
        });
        break;
      case "works":
        got = encodeWorksCursor({ userId: f.u, next: f.n, tab: f.w ? { tab: f.w.t, sub: f.w.s } : null });
        break;
      case "danmaku":
        got = encodeDanmakuCursor({ episodeId: f.e, duration: f.d, start: f.t, next: f.n });
        break;
    }
    assert.equal(got, tc.token, tc.kind);
  }
});

// Fields the Go parsers fill that the port leaves out on purpose: nothing in
// the plugin reads them. They are skipped by path, array indices written []
// and map keys (IDs) written *, so a field of the same name elsewhere, such
// as the filter panel's rows, is still compared.
const UNPARSED_FIELDS = [
  /\.coverExpiresAt$/, // signed cover URLs are used as given
  /^series\.series\.rows$/, // series info rows (Series.Rows); the plugin shows its own meta
  /^series_batch\.\*\.series\.rows$/,
  /^short_rank(_actor)?\.items\[\]\.change$/, // a ranking row's move since last time
];

const unparsed = (where) => {
  const path = where.replace(/\[\d+\]/g, "[]").replace(/\.\d+(?=\.|$)/g, ".*");
  return UNPARSED_FIELDS.some((re) => re.test(path));
};

const camel = (k) =>
  k.includes("_")
    ? k.split("_").map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join("")
    : k.replace(/ID/g, "Id").replace(/URL/g, "Url").replace(/^[A-Z]/, (c) => c.toLowerCase());

// sameAsGo checks every field of the Go result against the JS result: keys
// are matched in camelCase, Go times compare as Unix seconds, and Go zero
// values match an absent JS field.
function sameAsGo(where, goVal, jsVal) {
  if (goVal === null && (jsVal === undefined || (Array.isArray(jsVal) && jsVal.length === 0))) return;
  if (typeof goVal === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(Z|[+-]\d\d:\d\d)$/.test(goVal)) {
    const secs = Date.parse(goVal) / 1000;
    if (secs <= 0) assert.ok(!jsVal, where);
    else assert.equal(jsVal, secs, where);
    return;
  }
  if (goVal === null || typeof goVal !== "object") {
    if (jsVal === undefined && (goVal === "" || goVal === 0 || goVal === false)) return;
    assert.equal(jsVal, goVal, where);
    return;
  }
  if (Array.isArray(goVal)) {
    assert.ok(Array.isArray(jsVal), `${where} is an array`);
    assert.equal(jsVal.length, goVal.length, `${where} length`);
    goVal.forEach((x, i) => sameAsGo(`${where}[${i}]`, x, jsVal[i]));
    return;
  }
  assert.ok(jsVal && typeof jsVal === "object", `${where} is an object`);
  for (const [k, v] of Object.entries(goVal)) {
    const key = camel(k);
    if (unparsed(`${where}.${key}`)) continue;
    sameAsGo(`${where}.${key}`, v, jsVal[key]);
  }
}

test("response parsing matches openhongguo on live responses", () => {
  const read = {
    discover: (e) => parsers.parseDiscoverTab(e, 16),
    cell_change: parsers.parseCellChange,
    search: (e) => parsers.parseSearchTab(e, 11),
    suggest: parsers.parseSuggest,
    hot_search: parsers.parseHotSearch,
    series: parsers.parseSeries,
    series_batch: parsers.parseSeriesBatch,
    seasons: parsers.parseSeasons,
    plan_recommend: parsers.parsePlanCells,
    new_releases: parsers.parseNewReleases,
    profile: parsers.parseProfile,
    // Go returns (tab, ok); its WorksTab marshals as {t, s}.
    works_tabs: (e) => {
      const tab = parsers.parseWorksTab(e);
      return { oK: Boolean(tab), tab: tab ? { t: tab.tab, s: tab.sub } : null };
    },
    user_works: parsers.parseUserWorks,
    short_filter: parsers.parseShortFilter,
    short_filter_panel: parsers.parseShortFilter,
    short_rank: parsers.parseShortRank,
    short_rank_actor: parsers.parseShortRank,
    danmaku: parsers.parseDanmaku,
  };
  const names = Object.keys(vectors.parse).sort();
  assert.deepEqual(names, Object.keys(read).sort(), "every fixture has a parser");
  for (const name of names) {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors", "responses", `${name}.json`), "utf8"));
    sameAsGo(name, vectors.parse[name], read[name](parseJSONSafe(fx.response)));
  }
});

test("the parse comparison reaches the filter panel's rows", () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "vectors", "responses", "short_filter_panel.json"), "utf8")
  );
  const good = parsers.parseShortFilter(parseJSONSafe(fx.response));
  assert.ok(good.rows.length > 0 && good.rows.every((r) => r.options.length > 0));
  sameAsGo("short_filter_panel", vectors.parse.short_filter_panel, good);
  // A panel parsed wrong must fail the comparison.
  const broken = { ...good, rows: good.rows.map((r) => ({ ...r, name: "", options: [] })) };
  assert.throws(() => sameAsGo("short_filter_panel", vectors.parse.short_filter_panel, broken));
  const renamed = { ...good, rows: good.rows.map((r, i) => (i === 0 ? { ...r, name: `${r.name}x` } : r)) };
  assert.throws(() => sameAsGo("short_filter_panel", vectors.parse.short_filter_panel, renamed));
  // So must a series whose episodes lose their lengths.
  const sx = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors", "responses", "series.json"), "utf8"));
  const series = parsers.parseSeries(parseJSONSafe(sx.response));
  assert.deepEqual(
    series.episodes.map((e) => e.durationSeconds),
    vectors.episodeDurations.series,
    "episode lengths match Go"
  );
});
