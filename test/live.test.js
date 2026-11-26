import assert from "node:assert/strict";
import test from "node:test";

import { decryptMP4InPlace, isEncryptedMP4, readBoxes } from "./cenc.js";
import { installHost } from "./host.js";
import * as plugin from "../index.js";

const LIVE = process.env.HONGGUO_LIVE === "1";

test("live smoke test: browse, rank, filter, search, detail, danmaku, play, and CENC decrypt MP4", { skip: !LIVE, timeout: 120_000 }, async () => {
  installHost();
  const observedHosts = new Set();
  const recordUrl = (u) => {
    if (!u) return;
    try {
      observedHosts.add(new URL(u).hostname);
    } catch {
      // Ignore invalid URL.
    }
  };

  // 1. Navigation
  const nav = await plugin.navigation();
  assert.ok(nav.items.length >= 5, "navigation should return >= 5 items");

  // 2. Recommend collection
  const rec = await plugin.collection({ id: "channel:recommend" });
  assert.ok(rec.items.length > 0, "recommend collection should return items");
  for (const it of rec.items) recordUrl(it.image);
  console.log(`[live] recommend: ${rec.items.length} items, first="${rec.items[0].title}" (${rec.items[0].id})`);

  // 3. Rank collection (dramas + actor board + person page)
  const rank = await plugin.collection({ id: "rank" });
  assert.equal(rank.layout, "ranked");
  assert.ok(rank.items.length > 0, "rank should return items");
  assert.ok(rank.filters && rank.filters.length >= 1, "rank should return filter rows");
  for (const it of rank.items) recordUrl(it.image);
  console.log(`[live] rank: ${rank.items.length} items, filters=${rank.filters.map((f) => f.key).join(",")}`);

  const actorContent = rank.filters[0].options.find((o) => o.value === "ranklist_celebrity");
  if (actorContent) {
    const actorRank = await plugin.collection({
      id: "rank",
      filters: { content: actorContent.value },
    });
    assert.ok(actorRank.items.length > 0, "actor rank should return actors");
    const firstActor = actorRank.items.find((it) => it.kind === "collection" && it.id.startsWith("person:"));
    assert.ok(firstActor, "actor rank item should be a person collection card");
    recordUrl(firstActor.image);
    const personPage = await plugin.collection({ id: firstActor.id });
    assert.ok(personPage.header?.title, "person page should have header");
    recordUrl(personPage.header?.image);
    for (const it of personPage.items || []) recordUrl(it.image);
    console.log(`[live] person("${personPage.header.title}"): ${personPage.items.length} works`);
  }

  // 4. Filter collection
  const filtered = await plugin.collection({ id: "filter" });
  assert.ok(filtered.filters && filtered.filters.length >= 1, "filter should return filter rows");
  assert.ok(filtered.items.length > 0, "filter should return items");
  for (const it of filtered.items) recordUrl(it.image);
  console.log(`[live] filter: ${filtered.items.length} items, rows=${filtered.filters.map((f) => f.title).join("/")}`);

  // 5. Search, searchHome, suggest
  const home = await plugin.searchHome();
  assert.ok(home.sections && home.sections.length > 0, "searchHome should return boards");
  for (const sec of home.sections) {
    for (const it of sec.items || []) recordUrl(it.image);
  }
  console.log(`[live] searchHome: ${home.sections.length} boards (${home.sections.map((s) => s.title).join(", ")})`);

  const queryWord = rec.items[0].title.slice(0, 4) || "重生";
  const sug = await plugin.suggest({ query: queryWord });
  assert.ok(Array.isArray(sug.items));
  console.log(`[live] suggest("${queryWord}"): ${sug.items.length} suggestions`);

  const srch = await plugin.search({ query: queryWord });
  assert.ok(srch.items.length > 0, "search should return items");
  for (const it of srch.items) recordUrl(it.image);
  console.log(`[live] search("${queryWord}"): ${srch.items.length} items`);

  // 6. Refresh batch
  const ref = await plugin.refresh({ ids: rec.items.slice(0, 3).map((x) => x.id) });
  assert.ok(ref.items.length > 0, "refresh should return cards");
  for (const it of ref.items) recordUrl(it.image);

  // 7. Media detail + Danmaku + Related
  const targetMedia = rec.items[0];
  const detail = await plugin.media({ id: targetMedia.id });
  assert.equal(detail.id, targetMedia.id);
  assert.ok(detail.episodes.length > 0, "media should have episodes");
  recordUrl(detail.image);
  for (const ep of detail.episodes.slice(0, 5)) recordUrl(ep.image);
  console.log(`[live] media("${detail.title}"): ${detail.episodes.length} episodes, seasons=${detail.seasons?.length || 1}`);

  const playableEp = detail.episodes.find((e) => !e.lock) || detail.episodes[0];
  const dm = await plugin.danmaku({ mediaId: detail.id, episodeId: playableEp.id });
  assert.ok(Array.isArray(dm.items));
  console.log(`[live] danmaku(ep=${playableEp.id}): ${dm.items.length} items in first window`);

  // 8. Play + download + CENC decrypt + verify MP4 boxes (ftyp + moov)
  const pb = await plugin.play({
    mediaId: detail.id,
    episodeId: playableEp.id,
    prefer: { maxHeight: 1080, hevc: true },
  });
  assert.ok(pb.streams.length > 0, "play should return streams");
  for (const s of pb.streams) {
    recordUrl(s.url);
    for (const bu of s.backupUrls || []) recordUrl(bu);
  }
  console.log(
    `[live] play(ep=${playableEp.id}): ${pb.streams.length} streams, top=${pb.streams[0].width}x${pb.streams[0].height} ${pb.streams[0].codec} encrypted=${Boolean(pb.streams[0].encryption)}`
  );

  // Pick the smallest MP4 stream first to keep download fast, falling back to backups and other streams.
  const mp4Streams = [...pb.streams.filter((s) => s.container === "mp4")].sort(
    (a, b) => (a.bitrate || 0) - (b.bitrate || 0)
  );
  assert.ok(mp4Streams.length > 0, "expected at least one mp4 stream");

  let data = null;
  let chosen = null;
  let lastErr = "no urls";
  for (const stream of mp4Streams) {
    for (const u of [stream.url, ...(stream.backupUrls || [])]) {
      try {
        const resp = await fetch(u);
        if (resp.ok) {
          data = Buffer.from(await resp.arrayBuffer());
          chosen = stream;
          break;
        }
        lastErr = `HTTP ${resp.status}`;
      } catch (err) {
        lastErr = err?.cause?.code || err?.message || String(err);
      }
    }
    if (data) break;
  }
  assert.ok(data && data.length > 1024, `failed to download mp4 (${lastErr})`);

  const encryptedBefore = isEncryptedMP4(data);
  if (chosen.encryption || encryptedBefore) {
    assert.ok(chosen.encryption?.key, "encrypted MP4 must carry CENC key");
    decryptMP4InPlace(data, chosen.encryption.key);
  }

  const topBoxes = readBoxes(data, 0, data.length).map((b) => b.typ);
  assert.ok(topBoxes.includes("ftyp"), `decrypted MP4 missing ftyp box: ${topBoxes.join(",")}`);
  assert.ok(topBoxes.includes("moov"), `decrypted MP4 missing moov box: ${topBoxes.join(",")}`);
  assert.equal(isEncryptedMP4(data), false, "decrypted MP4 still contains encv/enca");
  console.log(
    `[live] downloaded ${(data.length / 1024).toFixed(1)} KiB, wasEncrypted=${encryptedBefore}, boxes=[${topBoxes.join(",")}]`
  );
  console.log(`[live] observed media/image hosts: ${[...observedHosts].sort().join(", ")}`);
});
