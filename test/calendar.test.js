// The 上新 calendar, cached page by page (src/seasons.js).
import assert from "node:assert/strict";
import test from "node:test";

import { installHost } from "./host.js";
import { createRuntimes } from "./runtimes.js";
import { announceSeasons, seasonsOf, startCalendar } from "../src/seasons.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const TODAY = "20261127";
// Only past days: the seasons looked for are not out yet, so only today and
// the days to come are read.
const DATES = ["20261124", "20261125", "20261126", "20261127"];

function quietLogs() {
  const orig = console.log;
  console.log = () => {};
  return () => {
    console.log = orig;
  };
}

// fakeCalendar serves pages[date] = [items of page 1, page 2, ...]. Each
// first page opens a session; a cursor names its session and page, and is
// good once: sent again, it answers the page after, as the server does.
function fakeCalendar(pages, { pageMs = 5, device = "dev-1", fail = () => false } = {}) {
  const log = [];
  const used = new Set();
  let sessions = 0;
  const client = {
    device,
    currentDeviceId: () => client.device,
    async newReleases({ date, cursor, deviceId, signal }) {
      const day = cursor ? cursor.split("|")[0] : date || TODAY;
      let page = 0;
      let session;
      if (cursor) {
        if (deviceId && deviceId !== client.device) throw new Error("calendar cursor belongs to another device");
        [, session, page] = cursor.split("|");
        page = Number(page);
        if (used.has(cursor)) page++;
        used.add(cursor);
      } else {
        session = `s${++sessions}`;
      }
      log.push(cursor ? `${day}:p${page + 1}` : `${day}:p1`);
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, typeof pageMs === "function" ? pageMs(day, page) : pageMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
      if (fail(day, page)) throw new Error("HTTP 500");
      const all = pages[day] || [[]];
      const more = page + 1 < all.length;
      return {
        date: day,
        dates: DATES,
        items: all[page] || [],
        hasMore: more,
        cursor: more ? `${day}|${session}|${page + 1}` : "",
        deviceId: client.device,
      };
    },
  };
  return { client, log };
}

const rel = (seriesId, title, extra = {}) => ({ seriesId, title, online: false, note: `note ${seriesId}`, ...extra });
const twoSeasons = () =>
  seasonsOf([
    { seriesId: "100", title: "剧 第一季", index: 1, episodeCount: 60 },
    { seriesId: "200", title: "剧 第二季", index: 2, episodeCount: 0 },
  ]);
const day = (date) => JSON.parse(host().cache.get(`hongguo_cal:${date}`) || "null");
const host = () => globalThis.host;

test("a day is read page by page across opens and complete only when whole", async () => {
  installHost();
  // The season is on page 3 of today; each open has time for one page.
  const pages = { [TODAY]: [[rel("1", "甲")], [rel("2", "乙")], [rel("200", "剧 第二季")]] };
  const { client, log } = fakeCalendar(pages, { pageMs: 300 });
  for (let i = 0; i < 2; i++) {
    const out = await announceSeasons(client, twoSeasons(), { budgetMs: 350 });
    assert.equal(out[1].note, "", `open ${i + 1} has no note yet`);
  }
  assert.deepEqual(log, [`${TODAY}:p1`, `${TODAY}:p2`]);
  let rec = day(TODAY);
  assert.equal(rec.pages, 2);
  assert.equal(rec.complete, false);
  assert.deepEqual(rec.items.map((r) => r.seriesId), ["1", "2"]);

  const out = await announceSeasons(client, twoSeasons(), { budgetMs: 350 });
  assert.equal(out[1].note, "note 200");
  rec = day(TODAY);
  assert.equal(rec.pages, 3);
  assert.equal(rec.complete, true, "three pages make a day whole");
  assert.equal(rec.next, "");

  // has_more=false makes it whole too.
  installHost();
  const short = fakeCalendar({ [TODAY]: [[rel("200", "剧 第二季")]] });
  await announceSeasons(short.client, twoSeasons(), { budgetMs: 500 });
  assert.equal(day(TODAY).complete, true);
  assert.equal(day(TODAY).pages, 1);
});

test("today's next page is sent as the calendar starts", async () => {
  installHost();
  const pages = { [TODAY]: [[rel("1", "甲")], [rel("200", "剧 第二季")]] };
  const { client, log } = fakeCalendar(pages, { pageMs: 50 });
  await announceSeasons(client, twoSeasons(), { budgetMs: 80 }); // reads page 1 only
  assert.deepEqual(log, [`${TODAY}:p1`]);

  // The next open starts with page 2, before the season list is in.
  const cal = startCalendar(client);
  await delay(1);
  assert.deepEqual(log, [`${TODAY}:p1`, `${TODAY}:p2`]);
  const out = await announceSeasons(client, twoSeasons(), { budgetMs: 500, calendar: cal });
  assert.equal(out[1].note, "note 200");
});

test("a cursor page that cannot come back in time is not sent", async () => {
  installHost();
  const pages = { [TODAY]: [[rel("1", "甲")], [rel("200", "剧 第二季")]] };
  const { client, log } = fakeCalendar(pages, { pageMs: 50 });
  await announceSeasons(client, twoSeasons(), { budgetMs: 80 });
  // Earlier calls found a page takes 1.5 seconds: more than the budget.
  host().cache.set("hongguo_cal_page_ms", "1500", 600);
  const cal = startCalendar(client);
  await delay(1);
  await announceSeasons(client, twoSeasons(), { budgetMs: 200, calendar: cal });
  assert.deepEqual(log, [`${TODAY}:p1`], "the estimate keeps the cursor page from starting");
  assert.ok(day(TODAY).next, "the cursor is still there for later");
  // The estimate is kept, smoothed, for the calls after.
  assert.ok(Number(host().cache.get("hongguo_cal_page_ms")) > 0);
});

test("a cursor is never sent twice and a failed cursor page is not retried", async () => {
  installHost();
  const restore = quietLogs();
  try {
    const pages = { [TODAY]: [[rel("1", "甲")], [rel("2", "乙")], [rel("200", "剧 第二季")]] };
    const { client, log } = fakeCalendar(pages, { fail: (d, page) => page === 1 && log.length === 2 });
    await announceSeasons(client, twoSeasons(), { budgetMs: 500 });
    // Page 2 failed once: the session is dropped, not the cursor sent again.
    assert.deepEqual(log, [`${TODAY}:p1`, `${TODAY}:p2`]);
    const rec = day(TODAY);
    assert.equal(rec.next, "");
    assert.equal(rec.pending, null);
    assert.equal(rec.complete, false);

    // The next open starts today over from page 1, keeping the items in.
    const out = await announceSeasons(client, twoSeasons(), { budgetMs: 500 });
    assert.deepEqual(log.slice(2), [`${TODAY}:p1`, `${TODAY}:p2`, `${TODAY}:p3`]);
    assert.equal(out[1].note, "note 200");
    assert.deepEqual(day(TODAY).items.map((r) => r.seriesId), ["1", "2", "200"], "no repeats");
  } finally {
    restore();
  }
});

test("a pending page left by a call cut off starts the day over; one in flight is left alone", async () => {
  installHost();
  const pages = { [TODAY]: [[rel("1", "甲")], [rel("200", "剧 第二季")]] };
  const { client, log } = fakeCalendar(pages);
  const base = { date: TODAY, dates: DATES, items: [rel("9", "旧")], pages: 1, next: "", deviceId: "dev-1", complete: false };
  host().cache.set("hongguo_cal:today", JSON.stringify({ date: TODAY, dates: DATES }), 600);

  // Another call sent page 2 a moment ago: only what is cached is used.
  host().cache.set(
    `hongguo_cal:${TODAY}`,
    JSON.stringify({ ...base, startedAt: Date.now(), pending: { at: Date.now() - 1000, token: "x" } }),
    600
  );
  await announceSeasons(client, twoSeasons(), { budgetMs: 300 });
  assert.deepEqual(log, [], "nothing is sent for a day another call reads");

  // A call cut off 20 seconds ago left its mark: the session is lost.
  host().cache.set(
    `hongguo_cal:${TODAY}`,
    JSON.stringify({ ...base, startedAt: Date.now() - 30_000, pending: { at: Date.now() - 20_000, token: "x" } }),
    600
  );
  const out = await announceSeasons(client, twoSeasons(), { budgetMs: 500 });
  assert.deepEqual(log, [`${TODAY}:p1`, `${TODAY}:p2`]);
  assert.equal(out[1].note, "note 200");
  assert.deepEqual(day(TODAY).items.map((r) => r.seriesId), ["9", "1", "200"]);
});

test("a cursor issued to another device starts the day over", async () => {
  installHost();
  const pages = { [TODAY]: [[rel("1", "甲")], [rel("200", "剧 第二季")]] };
  const { client, log } = fakeCalendar(pages, { pageMs: 50 });
  await announceSeasons(client, twoSeasons(), { budgetMs: 80 });
  client.device = "dev-2";
  await announceSeasons(client, twoSeasons(), { budgetMs: 500 });
  assert.deepEqual(log, [`${TODAY}:p1`, `${TODAY}:p1`, `${TODAY}:p2`]);
  assert.equal(day(TODAY).deviceId, "dev-2");
});

test("a day lives ten minutes from its first page and is never extended", async () => {
  installHost();
  const pages = { [TODAY]: [[rel("1", "甲")], [rel("2", "乙")], [rel("200", "剧 第二季")]] };
  const { client } = fakeCalendar(pages);
  const ttls = [];
  const set = host().cache.set;
  host().cache.set = (k, v, ttl) => {
    if (k === `hongguo_cal:${TODAY}`) ttls.push([JSON.parse(v).pages, ttl]);
    return set(k, v, ttl);
  };
  host().cache.set("hongguo_cal:today", JSON.stringify({ date: TODAY, dates: DATES }), 600);
  // The session started 590 seconds ago.
  set(
    `hongguo_cal:${TODAY}`,
    JSON.stringify({
      date: TODAY, dates: DATES, items: [rel("1", "甲")], pages: 1, next: `${TODAY}|s0|1`,
      deviceId: "dev-1", startedAt: Date.now() - 590_000, complete: false, pending: null,
    }),
    600
  );
  await announceSeasons(client, twoSeasons(), { budgetMs: 500 });
  assert.ok(ttls.length >= 2);
  for (const [pages, ttl] of ttls) assert.ok(ttl <= 10, `page ${pages} kept for ${ttl}s`);
});

test("the days are searched in order, by ID before title within a day", async () => {
  installHost();
  const seasons = seasonsOf([
    { seriesId: "100", title: "剧 第一季", index: 1, episodeCount: 60 },
    { seriesId: "200", title: "剧 第二季", index: 2, episodeCount: 0 },
    { seriesId: "300", title: "", index: 3, episodeCount: 0 },
  ]);
  const pages = {
    // Today: season 2 by title on page 1, by ID on page 2.
    [TODAY]: [[rel("999", "剧 第二季", { note: "by title" })], [rel("200", "别名", { note: "by id" })]],
    // Tomorrow is read first and fast, yet today comes first.
    "20261128": [[rel("300", "剧 第三季", { note: "tomorrow" })]],
    // The day after has season 3 too, by ID, but comes later.
    "20261129": [[rel("300", "剧 第三季", { note: "later" })]],
  };
  const dates = [...DATES, "20261128", "20261129"];
  const { client } = fakeCalendar(pages, { pageMs: (d) => (d === TODAY ? 60 : 5) });
  const nr = client.newReleases;
  client.newReleases = async (q) => ({ ...(await nr(q)), dates });
  const out = await announceSeasons(client, seasons, { budgetMs: 1000 });
  assert.equal(out[1].note, "by id", "an ID match on today's page 2 beats a title match on page 1");
  assert.equal(out[2].note, "tomorrow");
  assert.equal(out[2].title, "剧 第三季", "an empty season name comes from the calendar");
});

// Four opens at once, each in a runtime of its own, share the cached pages.
test("media opened at once in several runtimes never send a cursor twice", { timeout: 60_000 }, async () => {
  const sent = [];
  const twice = [];
  let sessions = 0;
  const used = new Set();
  const handle = async (u) => {
    const p = u.pathname;
    if (p.includes("/service/2/device_register/")) {
      await delay(10);
      return {
        body: { device_id_str: "7123456789012345678", install_id_str: "7123456789012345679", new_user: 1 },
        setCookies: ["ttreq=1$mock; Path=/"],
      };
    }
    if (p.includes("/novel/player/video_detail/v1/")) {
      await delay(30);
      return {
        body: {
          code: 0,
          data: {
            video_data: {
              series_id_str: "7100000000000001",
              series_title: "剧 第一季",
              episode_cnt: 1,
              is_multi_season: true,
              season_index: 1,
              video_list: [{ vid: "7100000000001001", vid_index: 1, duration: 90 }],
            },
          },
        },
      };
    }
    if (p.includes("/reading/bookapi/plan/v1/")) {
      await delay(20);
      return {
        body: {
          code: 0,
          data: [
            {
              show_type: 547,
              video_data: [
                { series_id: "7100000000000001", title: "剧 第一季", season_index: 1, episode_cnt: 60 },
                { series_id: "7100000000000002", title: "剧 第二季", season_index: 2, episode_cnt: 0 },
              ],
            },
          ],
        },
      };
    }
    if (p.includes("/reading/user/subscribe/list/v1/")) {
      const offset = Number(u.searchParams.get("offset") || 0);
      const session = u.searchParams.get("session_id") || `s${++sessions}`;
      const date = u.searchParams.get("target_date") || TODAY;
      const key = `${date}|${session}|${offset}`;
      if (offset > 0) {
        sent.push(key);
        if (used.has(key)) twice.push(key);
        used.add(key);
      }
      await delay(80);
      const last = offset >= 30;
      return {
        body: {
          code: 0,
          data: {
            calendar_schema: { default_date: date, date_list: [TODAY, "20261128"] },
            has_more: !last,
            next_offset: offset + 15,
            session_id: session,
            subscribe_items:
              date === "20261128" && last
                ? [{ item_id: "7100000000000002", name: "剧 第二季", is_online: false, sub_info: "明天上线" }]
                : [{ item_id: `71000000000099${String(offset).padStart(2, "0")}`, name: `别的剧${offset}`, is_online: false }],
          },
        },
      };
    }
    throw new Error(`unexpected ${u}`);
  };
  for (const cacheAdd of [true, false]) {
    sent.length = 0;
    twice.length = 0;
    used.clear();
    const rt = createRuntimes({ handle, cacheAdd });
    try {
      for (let round = 0; round < 3; round++) {
        await rt.warm(4);
        await Promise.all([1, 2, 3, 4].map(() => rt.call("media", { id: "7100000000000001" })));
      }
      const today = JSON.parse(rt.host.cache.get(`hongguo_cal:${TODAY}`));
      assert.equal(today.complete, true, "today read whole between the opens");
      assert.equal(today.pending, null);
      assert.ok(sent.length >= 2, `cursor pages sent: ${sent.join(", ")}`);
      assert.deepEqual(twice, [], "no cursor is sent twice");
      const later = await rt.call("media", { id: "7100000000000001" });
      assert.match(later.seasons[1].note || "", /明天上线/);
    } finally {
      await rt.close();
    }
  }
});
