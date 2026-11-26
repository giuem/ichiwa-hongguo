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
import { encodeQuery } from "../src/sign/request.js";

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
