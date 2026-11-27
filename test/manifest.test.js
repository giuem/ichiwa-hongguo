import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const manifest = JSON.parse(fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));

// Each host is in the allowlist because live traffic reached it or the
// openhongguo source names it; see the PR for the evidence.
test("the network allowlist holds only hosts with evidence", () => {
  assert.deepEqual(manifest.permissions.network, [
    "api5-normal-sinfonlinea.fqnovel.com", // openhongguo APIHost; every API call
    "log5-applog-lq.fqnovel.com", // openhongguo RegisterHost; device registration
    "*.fqnovelpic.com", // covers and avatars (p3-reading-sign)
    "*.byteimg.com", // covers (p3-novel, p6-novel)
    "*.qznovelvod.com", // every stream and backup URL seen
  ]);
});

function allowed(url) {
  const h = new URL(url).hostname;
  return manifest.permissions.network.some((p) =>
    p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p
  );
}

test("hosts seen in live traffic match the allowlist", () => {
  for (const u of [
    "https://api5-normal-sinfonlinea.fqnovel.com/reading/bookapi/search/tab/v",
    "https://log5-applog-lq.fqnovel.com/service/2/device_register/",
    "https://p3-reading-sign.fqnovelpic.com/novel-pic/x.heic",
    "https://p3-novel.byteimg.com/img/x.jpg",
    "https://p6-novel.byteimg.com/img/x.jpg",
    "https://v5-se-bjtc-reading-video.qznovelvod.com/x.mp4",
    "https://v95-aw-reading-video.qznovelvod.com/x.mp4",
  ]) {
    assert.ok(allowed(u), u);
  }
  assert.equal(allowed("https://v3-default.365yg.com/x.mp4"), false);
});
