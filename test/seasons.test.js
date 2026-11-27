import assert from "node:assert/strict";
import test from "node:test";

import { installHost } from "./host.js";
import * as plugin from "../index.js";
import { announceSeasons, CALENDAR_PARALLEL, seasonsOf } from "../src/seasons.js";

function mockResponse(body, { setCookies = [] } = {}) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  return {
    status: 200,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === "set-cookie" ? setCookies.join(", ") || null : null),
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const DAYS = ["20261120", "20261121", "20261122", "20261123", "20261124", "20261125", "20261126", "20261127"];

function quietLogs() {
  const orig = console.log;
  console.log = () => {};
  return () => {
    console.log = orig;
  };
}

test("announceSeasons reads at most four calendar days at once", async () => {
  installHost();
  const seasons = seasonsOf([
    { seriesId: "100", title: "剧 第一季", index: 1, episodeCount: 60 },
    { seriesId: "200", title: "剧 第二季", index: 2, episodeCount: 60 },
  ]);
  let inFlight = 0;
  let maxInFlight = 0;
  const client = {
    async newReleases({ date }) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await delay(date ? 40 : 1);
        const items =
          date === "20261120" ? [{ seriesId: "200", title: "剧 第二季", online: true, publishAt: 1795132800 }] : [];
        return { date: date || "20261127", dates: DAYS, items, hasMore: false, cursor: "" };
      } finally {
        inFlight--;
      }
    },
  };
  const out = await announceSeasons(client, seasons, { budgetMs: 1000 });
  assert.equal(CALENDAR_PARALLEL, 4);
  assert.equal(maxInFlight, 4, `read ${maxInFlight} days at once`);
  assert.equal(out[1].note, "11月20日上新");
});

test("media reads the details and the season list at once and caches the list but not the notes", async () => {
  installHost();
  const restoreLogs = quietLogs();
  const counts = { detail: 0, plan: 0, calendar: 0 };
  let detailDone = 0;
  let planStarted = 0;
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes("/service/2/device_register/")) {
      return mockResponse(
        { device_id_str: "7123456789012345678", install_id_str: "7123456789012345679", new_user: 1 },
        { setCookies: ["ttreq=1$mock; Path=/"] }
      );
    }
    if (u.pathname.includes("/novel/player/video_detail/v1/")) {
      counts.detail++;
      await delay(150);
      detailDone = Date.now();
      return mockResponse({
        code: 0,
        data: {
          video_data: {
            series_id_str: "7100000000000001",
            series_title: "家里家外 第一季",
            episode_cnt: 1,
            is_multi_season: true,
            season_index: 1,
            video_list: [{ vid: "7100000000001001", vid_index: 1, duration: 90, vertical: true }],
          },
        },
      });
    }
    if (u.pathname.includes("/reading/bookapi/plan/v1/")) {
      counts.plan++;
      planStarted = Date.now();
      await delay(100);
      return mockResponse({
        code: 0,
        data: [
          {
            show_type: 547,
            video_data: [
              { series_id: "7100000000000001", title: "家里家外 第一季", season_index: 1, episode_cnt: 60 },
              {
                series_id: "7100000000000002",
                title: "家里家外2",
                season_index: 2,
                cover: "https://p3-reading-sign.fqnovelpic.com/s2.jpg",
                episode_cnt: 80,
              },
            ],
          },
        ],
      });
    }
    if (u.pathname.includes("/reading/user/subscribe/list/v1/")) {
      counts.calendar++;
      const date = u.searchParams.get("target_date") || "20261127";
      await delay(20);
      const items =
        date === "20261122"
          ? [
              {
                item_id: "7100000000000002",
                name: "家里家外2",
                is_online: true,
                schedule_publish_time: 1795305600,
                rec_tags: [{ content: "12万热度" }],
              },
            ]
          : [];
      return mockResponse({
        code: 0,
        data: {
          calendar_schema: { default_date: date, date_list: DAYS },
          has_more: false,
          subscribe_items: items,
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const first = await plugin.media({ id: "7100000000000001" });
    assert.ok(planStarted > 0 && planStarted < detailDone, "the season list is requested before the details are in");
    assert.equal(first.seasons.length, 2);
    assert.equal(first.seasons[1].name, "家里家外2");
    assert.equal(first.seasons[1].image, "https://p3-reading-sign.fqnovelpic.com/s2.jpg");
    const note = first.seasons[1].note;
    assert.match(note || "", /^11月22日上新/);
    assert.ok(counts.calendar >= 2);

    // The list and the whole calendar days are cached; the notes are put
    // together again from the cached days.
    const calendarBefore = counts.calendar;
    const second = await plugin.media({ id: "7100000000000001" });
    assert.equal(counts.plan, 1, "the season list comes from host.cache");
    assert.equal(counts.calendar, calendarBefore, "the days come from host.cache");
    assert.equal(second.seasons[1].note, note);

    // Season 2 opened from season 1 reuses the cached list too.
    await plugin.media({ id: "7100000000000002" }).catch(() => {});
    assert.equal(counts.plan, 1);
  } finally {
    globalThis.fetch = origFetch;
    restoreLogs();
  }
});
