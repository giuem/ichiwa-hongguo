import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installHost } from "./host.js";
import * as plugin from "../index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
import { emojify } from "../src/emoji.js";
import { ErrCode, HongguoError, toHostError } from "../src/errors.js";
import { parseJSONSafe, quoteLargeIntegers } from "../src/protocol/json.js";
import { parseAlbum, parseHotSearch, parsePlanCells, parseSeries } from "../src/protocol/parse.js";
import {
  decodeDanmakuCursor,
  decodeFeedCursor,
  decodeShortCursor,
  decodeWorksCursor,
  encodeDanmakuCursor,
  encodeFeedCursor,
  encodeShortCursor,
  encodeWorksCursor,
} from "../src/protocol/cursor.js";
import { announceSeasons, calendarDates, seasonsOf } from "../src/seasons.js";

installHost();

function mockResponse(body, { status = 200, setCookies = [] } = {}) {
  const bytes =
    typeof body === "string"
      ? Buffer.from(body, "utf8")
      : Buffer.from(JSON.stringify(body), "utf8");
  return {
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === "set-cookie" ? setCookies.join(", ") : null),
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

test("emojify matches Ichiwa danmaku emoji behavior including nested brackets", () => {
  assert.equal(emojify("太好看了[笑哭][赞]"), "太好看了😂👍");
  assert.equal(emojify("[[笑]哈哈[未知表情][火]"), "[😄哈哈[未知表情]🔥");
  assert.equal(emojify("纯文字没有表情"), "纯文字没有表情");
  assert.equal(emojify("孤立的[括号"), "孤立的[括号");
});

test("cursor encode/decode round-trips for feed, short, works, and danmaku", () => {
  const feed = {
    cellId: "7470092475068071998",
    sessionId: "sess-abc",
    clientTemplate: "2",
    showType: "16",
    tabType: "16",
    offset: "20",
  };
  assert.deepEqual(decodeFeedCursor(encodeFeedCursor(feed)), feed);

  const shortCur = {
    offset: 18,
    seen: ["7100000000000101", "7100000000000102"],
    seenKey: "a1b2c3d4e5f6",
    session: "s-1",
    selections: { genre: ["comic_series"] },
    content: "all",
    board: "hot",
    date: "20261127",
  };
  assert.deepEqual(decodeShortCursor(encodeShortCursor(shortCur)), shortCur);

  const worksCur = { userId: "12345678", next: "next-tok", tab: { tab: 8, sub: 100 } };
  assert.deepEqual(decodeWorksCursor(encodeWorksCursor(worksCur)), worksCur);

  const dmCur = { episodeId: "7690261304497458201", duration: 135000, start: 30000, next: "{}" };
  assert.deepEqual(decodeDanmakuCursor(encodeDanmakuCursor(dmCur)), dmCur);
});

test("seasonsOf and announceSeasons normalize, sort, and annotate via calendar", async () => {
  installHost();
  const normalized = seasonsOf([
    { seriesId: "200", title: "剧名 第二季", index: 0, episodeCount: 0 },
    { seriesId: "100", title: "剧名 第一季", index: 1, episodeCount: 60 },
    { seriesId: "100", title: "剧名 第一季", index: 1, episodeCount: 60 }, // duplicate
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].id, "100");
  assert.equal(normalized[0].index, 1);
  assert.equal(normalized[0].online, true);
  assert.equal(normalized[1].id, "200");
  assert.equal(normalized[1].index, 2);
  assert.equal(normalized[1].online, false);

  assert.deepEqual(
    calendarDates(["20261125", "20261126", "20261127", "20261128", "20261129"], "20261127", false),
    ["20261128", "20261129"]
  );
  assert.deepEqual(
    calendarDates(["20261125", "20261126", "20261127", "20261128"], "20261127", true),
    ["20261126", "20261125"]
  );

  const fakeClient = {
    async newReleases({ date }) {
      if (!date) {
        return {
          date: "20261127",
          dates: ["20261126", "20261127", "20261128"],
          items: [],
          hasMore: false,
          cursor: "",
        };
      }
      if (date === "20261128") {
        return {
          date: "20261128",
          dates: ["20261126", "20261127", "20261128"],
          items: [
            {
              seriesId: "200",
              title: "剧名 第二季",
              online: false,
              publishAt: 1795831200, // 2026-11-29 10:00:00 UTC+8
              note: "11月28日10:00上线",
              heat: "50万预约",
            },
          ],
          hasMore: false,
          cursor: "",
        };
      }
      return { date, dates: [], items: [], hasMore: false, cursor: "" };
    },
  };

  const annotated = await announceSeasons(fakeClient, normalized);
  assert.equal(annotated[1].note, "11月28日10:00上线");
  assert.equal(annotated[1].heat, "50万预约");
});

test("error mapping covers unavailable, rateLimited, notFound, network, and plugin", () => {
  installHost();
  const anon = toHostError(new HongguoError(ErrCode.AnonymousLimited, "empty"), "play");
  assert.equal(anon.code, "unavailable");

  const rate = toHostError(
    new HongguoError(ErrCode.CodeError, "ban", {
      bizCode: 100,
      bizKind: "rate_limited",
      bizMessage: '{"minBanTime":20,"maxBanTime":40}',
    }),
    "play"
  );
  assert.equal(rate.code, "rateLimited");
  assert.equal(rate.retryAfter, 30);

  const notFound = toHostError(
    new HongguoError(ErrCode.CodeError, "not exist", {
      bizCode: 101104,
      bizKind: "content_gone",
    }),
    "media"
  );
  assert.equal(notFound.code, "notFound");

  const net = toHostError(new HongguoError(ErrCode.Transport, "timeout"), "collection");
  assert.equal(net.code, "network");
});

test("plugin exports adhere to protocol with mocked fetch and host.storage", async () => {
  const host = installHost();
  const calls = [];
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    calls.push(`${init?.method || "GET"} ${u.pathname}`);
    if (u.pathname.includes("/service/2/device_register/")) {
      return mockResponse(
        { device_id_str: "7123456789012345678", install_id_str: "7123456789012345679", new_user: 1 },
        {
          setCookies: [
            "ttreq=1$mock-ttreq; Path=/",
            "store-region=cn-zj; Path=/",
            "store-region-src=did; Path=/",
          ],
        }
      );
    }
    if (u.pathname.includes("/reading/bookapi/bookmall/tab/v")) {
      return mockResponse({
        code: 0,
        data: {
          tab_item: [
            {
              tab_type: 16,
              has_more: false,
              session_id: "sess-1",
              cell_data: [
                {
                  cell_id_str: "1001",
                  show_type: 16,
                  video_data: [
                    {
                      series_id: "7690184933037329432",
                      video_detail: {
                        series_title: "测试短剧",
                        series_intro: "精彩简介",
                        series_cover: "https://p3-reading-sign.fqnovelpic.com/cover.jpg",
                        episode_cnt: 60,
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      });
    }
    if (u.pathname.includes("/reading/bookapi/bookmall/cell/change/v")) {
      return mockResponse({
        code: 0,
        data: {
          has_more: true,
          next_offset: 20,
          session_id: "sess-2",
          cell_view: {
            video_data: [
              {
                series_id: "7690184933037329433",
                video_detail: {
                  series_title: "测试短剧2",
                  series_cover: "https://p3-reading-sign.fqnovelpic.com/cover2.jpg",
                  episode_cnt: 40,
                },
              },
            ],
          },
        },
      });
    }
    if (u.pathname.includes("/novel/player/video_detail/v1/")) {
      return mockResponse({
        code: 0,
        data: {
          video_data: {
            series_id_str: "7690184933037329432",
            series_title: "测试短剧",
            series_intro: "简介内容",
            series_cover: "https://p3-reading-sign.fqnovelpic.com/cover.jpg",
            episode_cnt: 2,
            series_play_cnt: 120000000,
            series_sub_title_list: ["甜宠", "反转"],
            video_list: [
              { vid: "7690261304497458201", vid_index: 1, title: "简介内容", duration: 120, vertical: true },
              { vid: "7690261304497458202", vid_index: 2, title: "简介内容", duration: 130, vertical: true, disable_play: true },
            ],
          },
        },
      });
    }
    if (u.pathname.includes("/reading/bookapi/plan/v1/")) {
      return mockResponse({ code: 0, data: [] });
    }
    if (u.pathname.includes("/novel/player/multi_video_model/player/v1")) {
      return mockResponse({
        code: 0,
        data: {
          "1004": {
            "7690261304497458201": {
              video_model: JSON.stringify({
                video_id: "v1",
                video_duration: 120,
                url_expire: 1800000000,
                video_list: {
                  video_1: {
                    main_url: Buffer.from("https://v3-default.365yg.com/720.mp4").toString("base64"),
                    backup_url_1: Buffer.from("https://v9-default.365yg.com/720.mp4").toString("base64"),
                    video_meta: { codec_type: "bytevc1", vwidth: 720, vheight: 1280, bitrate: 1500000 },
                    encrypt_info: {
                      encrypt: true,
                      spade_a: "nLwSxG6JI85zhT//c7AK4HauO+lzrg7TdZwO0XWrP+J0pDypqQ==",
                    },
                  },
                  video_2: {
                    main_url: Buffer.from("https://v3-default.365yg.com/1080.mp4").toString("base64"),
                    video_meta: { codec_type: "h264", vwidth: 1080, vheight: 1920, bitrate: 2500000 },
                    encrypt_info: {
                      encrypt: true,
                      spade_a: "nLwSxG6JI85zhT//c7AK4HauO+lzrg7TdZwO0XWrP+J0pDypqQ==",
                    },
                  },
                },
              }),
            },
          },
        },
      });
    }
    if (u.pathname.includes("/novel/commentapi/comment/list/")) {
      return mockResponse({
        code: 0,
        data: {
          data_list: [
            {
              comment: {
                comment_id: "c1",
                common: { content: { text: "太爽了[笑哭]" } },
                expand: { offset_time: 12500 },
              },
            },
          ],
          common_list_info: { cursor: '{"start_offset_time":0,"end_offset_time":30000}', has_more: false },
          extra: { next_query_danmaku_list_time: 30000 },
        },
      });
    }
    if (u.pathname.includes("/reading/bookapi/search/suggest/v1/")) {
      return mockResponse({
        code: 0,
        data: { query_result: ["霸总", "霸总归来"] },
      });
    }
    throw new Error(`unexpected mock fetch: ${url}`);
  };

  try {
    const nav = await plugin.navigation();
    assert.equal(nav.items.length, 5);
    assert.equal(nav.items[0].id, "channel:recommend");

    const rec = await plugin.collection({ id: "channel:recommend" });
    assert.equal(rec.layout, "grid");
    assert.equal(rec.items.length, 2);
    assert.equal(rec.items[0].id, "7690184933037329432");
    assert.deepEqual(rec.items[0].badges, ["全60集"]);
    assert.ok(rec.cursor);
    assert.ok(host.storage.get("hongguo_device_profile"), "device profile saved to host.storage");

    const m = await plugin.media({ id: "7690184933037329432" });
    assert.equal(m.id, "7690184933037329432");
    assert.equal(m.aspect, "portrait");
    assert.equal(m.episodes.length, 2);
    assert.equal(m.episodes[0].title, "第1集");
    assert.equal(m.episodes[0].lock, undefined);
    assert.equal(m.episodes[1].lock, "unavailable");
    assert.equal(m.sections[0].collection, "related:7690184933037329432");

    const pb = await plugin.play({
      mediaId: "7690184933037329432",
      episodeId: "7690261304497458201",
      prefer: { maxHeight: 1080, hevc: true },
    });
    assert.equal(pb.streams.length, 2);
    assert.equal(pb.streams[0].width, 1080);
    assert.equal(pb.streams[0].codec, "h264");
    assert.equal(pb.streams[1].codec, "hevc");
    assert.deepEqual(pb.streams[1].backupUrls, ["https://v9-default.365yg.com/720.mp4"]);
    assert.deepEqual(pb.streams[0].encryption, {
      scheme: "cenc",
      key: "1be760855c48a8c86000eeb8c5bb1010",
    });

    const dm = await plugin.danmaku({
      mediaId: "7690184933037329432",
      episodeId: "7690261304497458201",
    });
    assert.equal(dm.items.length, 1);
    assert.equal(dm.items[0].text, "太爽了😂");
    assert.equal(dm.items[0].time, 12.5);

    const sug = await plugin.suggest({ query: "霸总" });
    assert.deepEqual(sug.items, ["霸总", "霸总归来"]);

    // Device registration should only happen once across all calls.
    const regCalls = calls.filter((c) => c.includes("device_register"));
    assert.equal(regCalls.length, 1);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("plugin manifest and moejs sandbox constraints", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
  assert.equal(manifest.id, "hongguo");
  assert.equal(manifest.name, "红果短剧");
  assert.equal(manifest.kind, "source");
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.main, "index.js");
  assert.equal(manifest.license, "Apache-2.0");
  assert.ok(fs.existsSync(path.join(ROOT, manifest.icon)));
  assert.ok(Array.isArray(manifest.permissions?.network) && manifest.permissions.network.length > 0);

  // Every required export and declared capability must be an exported function.
  for (const fn of ["navigation", "collection", "media", "play"]) {
    assert.equal(typeof plugin[fn], "function", `missing required export ${fn}`);
  }
  const capMap = {
    search: "search",
    "search.suggest": "suggest",
    "search.home": "searchHome",
    danmaku: "danmaku",
    refresh: "refresh",
  };
  for (const cap of manifest.capabilities) {
    assert.equal(typeof plugin[capMap[cap]], "function", `missing export for capability ${cap}`);
  }

  // Verify no forbidden APIs or Node imports in index.js or src/.
  const runtimeFiles = [path.join(ROOT, "index.js")];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".js")) runtimeFiles.push(full);
    }
  };
  walk(path.join(ROOT, "src"));

  const forbidden = [
    /\bfrom\s+["']node:/,
    /\brequire\s*\(/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bimport\s*\(/,
    /\bWebAssembly\b/,
    /\bprocess\./,
    /\bBuffer\./,
  ];
  for (const f of runtimeFiles) {
    const src = fs.readFileSync(f, "utf8");
    for (const re of forbidden) {
      assert.equal(re.test(src), false, `${path.relative(ROOT, f)} matched forbidden pattern ${re}`);
    }
  }
});

test("rank, filter, person, searchHome, refresh, and fresh-device rotation on 263175", async () => {
  installHost();
  let regCount = 0;
  let rankAttempts = 0;
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes("/service/2/device_register/")) {
      regCount++;
      return mockResponse(
        {
          device_id_str: `712345678901234567${regCount}`,
          install_id_str: `712345678901234568${regCount}`,
          new_user: 1,
        },
        { setCookies: [`ttreq=1$tok${regCount}; Path=/`] }
      );
    }
    if (u.pathname.includes("/reading/bookapi/bookmall/cell/change/v1/")) {
      rankAttempts++;
      if (rankAttempts === 1) {
        // Simulate rejected device -> client must reset device and retry.
        return mockResponse({ BaseResp: { StatusCode: 263175 } });
      }
      if (u.searchParams.get("selected_items") === "ranklist_celebrity") {
        return mockResponse({
          code: 0,
          data: {
            has_more: false,
            cell_view: {
              cell_selector: {
                outer_row: {
                  items: [{ show_name: "演员", selector_item_id: "ranklist_celebrity", is_selected: true }],
                },
              },
              cell_data: [
                {
                  ugc_user_data: [
                    {
                      user_info: {
                        base_info: {
                          user_name: "演员甲",
                          user_avatar: "https://p3-reading-sign.fqnovelpic.com/a.jpg",
                          user_id: "12345678",
                        },
                      },
                      rec_text_item: { RecommendText: "100万人气" },
                      sub_title_list: [{ content: "10部作品" }],
                    },
                  ],
                },
              ],
            },
          },
        });
      }
      return mockResponse({
        code: 0,
        data: {
          has_more: false,
          cell_view: {
            cell_selector: {
              outer_row: {
                items: [
                  {
                    show_name: "全部",
                    selector_item_id: "all",
                    is_selected: true,
                    sub_cell_selector: {
                      outer_row: {
                        items: [{ show_name: "推荐榜", selector_item_id: "hot", is_selected: true }],
                      },
                    },
                  },
                ],
              },
            },
            cell_data: [
              {
                video_data: [
                  {
                    series_id: "7100000000000101",
                    title: "第一名短剧",
                    cover: "https://p3-reading-sign.fqnovelpic.com/1.jpg",
                    episode_cnt: 50,
                    rec_text_item: { RecommendText: "999万热度" },
                  },
                  {
                    series_id: "7100000000000102",
                    title: "推广项",
                    cover: "https://p3-reading-sign.fqnovelpic.com/2.jpg",
                    episode_cnt: 30,
                    rec_text_item: { RecommendText: "平台推荐" },
                  },
                ],
              },
            ],
          },
        },
      });
    }
    if (u.pathname.includes("/reading/distribution/category/landpage/v1/")) {
      const reqBody = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (reqBody.req_type === "only_panel") {
        return mockResponse({
          code: 0,
          data: {
            selector_rows: [
              {
                type: "genre",
                row_name: "全部体裁",
                items: [
                  { show_name: "真人剧", selector_item_id: "short_play" },
                  { show_name: "漫剧", selector_item_id: "comic_series" },
                ],
              },
              {
                type: "category_dim_theme",
                row_name: "全部主题",
                items:
                  reqBody.req_scene === "comic_series"
                    ? [{ show_name: "热血", selector_item_id: "comic_hot" }]
                    : [{ show_name: "甜宠", selector_item_id: "live_sweet" }],
              },
            ],
          },
        });
      }
      return mockResponse({
        code: 0,
        data: {
          has_more: false,
          video_data: [
            {
              series_id: "7100000000000201",
              title: "筛选结果剧",
              cover: "https://p3-reading-sign.fqnovelpic.com/f.jpg",
              episode_cnt: 80,
            },
          ],
        },
      });
    }
    if (u.pathname.includes("/reading/user/profile/get/v1/")) {
      return mockResponse({
        code: 0,
        data: {
          ugc_user: {
            user_id: "12345678",
            base_info: {
              user_name: "演员甲",
              description: "简介",
              user_avatar: "https://p3-reading-sign.fqnovelpic.com/a.jpg",
            },
            user_tag: { sub_title_list: [{ text: "女演员" }] },
            user_relation: { fans_num: 120000, recv_digged_count: 500000 },
          },
        },
      });
    }
    if (u.pathname.includes("/novel/commentapi/user/profile/12345678/v1")) {
      const reqBody = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (!reqBody.tab_type) {
        return mockResponse({
          code: 0,
          data: {
            tabs: [{ name: "剧作", tab_type: 8, sub_tabs: [{ name: "全部", tab_type: 100 }] }],
          },
        });
      }
      return mockResponse({
        code: 0,
        data: {
          data_list: [
            {
              video: {
                video_id: "7100000000000301",
                common: {
                  title: "代表作",
                  intro: "很好看",
                  cover: "https://p3-reading-sign.fqnovelpic.com/w.jpg",
                },
                stat: { play_cnt: 2500000 },
                expand: { episode_cnt: 66, sub_title_list: [{ text: "66集" }, { text: "古装" }] },
              },
            },
          ],
          common_list_info: { cursor: "", has_more: false },
        },
      });
    }
    if (u.pathname.includes("/novel/player/multi_video_detail/player/v1")) {
      return mockResponse({
        code: 0,
        data: {
          "7100000000000101": {
            video_data: {
              series_id_str: "7100000000000101",
              series_title: "刷新后的剧",
              series_cover: "https://p3-reading-sign.fqnovelpic.com/r.jpg",
              episode_cnt: 72,
              video_list: [],
            },
          },
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    // Rank should recover from 263175 via device rotation and omit promoted rows.
    const r = await plugin.collection({ id: "rank" });
    assert.equal(regCount, 2, "should register a fresh device after 263175");
    assert.equal(r.items.length, 1, "promoted row should be filtered out");
    assert.equal(r.items[0].id, "7100000000000101");
    assert.equal(r.filters.length, 2);

    // Actor rank produces collection cards pointing to person:<userId>.
    const ar = await plugin.collection({ id: "rank", filters: { content: "ranklist_celebrity" } });
    assert.equal(ar.items[0].kind, "collection");
    assert.equal(ar.items[0].id, "person:12345678");
    assert.equal(ar.items[0].shape, "circle");

    // Person collection returns header + works with non-"集" tag note.
    const person = await plugin.collection({ id: "person:12345678" });
    assert.equal(person.header.title, "演员甲");
    assert.equal(person.header.shape, "circle");
    assert.equal(person.items.length, 1);
    assert.equal(person.items[0].note, "古装");

    // Filter switching genre from short_play to comic_series clears incompatible theme option.
    const f = await plugin.collection({
      id: "filter",
      filters: { genre: "comic_series", category_dim_theme: "live_sweet" },
    });
    assert.equal(f.filters[0].value, "comic_series");
    assert.equal(f.filters[1].value, "");
    assert.equal(f.filters[1].title, "主题");
    assert.equal(f.items.length, 1);

    // Refresh returns updated media cards.
    const ref = await plugin.refresh({ ids: ["7100000000000101"] });
    assert.equal(ref.items.length, 1);
    assert.deepEqual(ref.items[0].badges, ["全72集"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("parseJSONSafe preserves 16+ digit integer IDs in top-level and nested JSON", () => {
  const raw =
    '{"small":123456789012345,"ts":1795440816123,"big":7709414179219721278,' +
    '"neg":-9007199254740993,"flt":1234567890123456.5,"sci":1234567890123456e2,' +
    '"str":"keep 7709414179219721278 and \\"7709414179219721279\\" untouched",' +
    '"arr":[7709414179219721278,123]}';
  const obj = parseJSONSafe(raw);
  assert.equal(obj.small, 123456789012345);
  assert.equal(obj.ts, 1795440816123);
  assert.equal(obj.big, "7709414179219721278");
  assert.equal(obj.neg, "-9007199254740993");
  assert.equal(typeof obj.flt, "number");
  assert.equal(typeof obj.sci, "number");
  assert.equal(obj.str, 'keep 7709414179219721278 and "7709414179219721279" untouched');
  assert.deepEqual(obj.arr, ["7709414179219721278", 123]);

  // Invalid leading zero should not be turned into a valid string.
  assert.throws(() => parseJSONSafe('{"bad":01234567890123456}'));
  assert.equal(quoteLargeIntegers('{"x":42}'), '{"x":42}');

  // Series response with numeric 64-bit series_id, related_album_id, related_novel_book_id.
  const seriesRaw =
    '{"code":0,"data":{"video_data":{' +
    '"series_id":7690184933037329432,' +
    '"series_title":"大整数测试剧",' +
    '"related_album_id":7709414179219721278,' +
    '"related_novel_book_id":7709414179219721999,' +
    '"video_list":[{"vid":7690261304497458201,"vid_index":1,"duration":120}]' +
    "}}}";
  const detail = parseSeries(parseJSONSafe(seriesRaw));
  assert.equal(detail.series.id, "7690184933037329432");
  assert.equal(detail.series.relatedAlbumId, "7709414179219721278");
  assert.equal(detail.series.relatedNovelBookId, "7709414179219721999");
  assert.equal(detail.episodes[0].id, "7690261304497458201");

  // Plan cells with numeric 64-bit cell_id.
  const planRaw = '{"code":0,"data":[{"show_type":160,"cell_id":7709414179219721278,"video_data":[]}]}';
  const cells = parsePlanCells(parseJSONSafe(planRaw));
  assert.equal(cells[0].cellId, "7709414179219721278");

  // Nested JSON string in album_data and lynx_data.
  const albumRaw = JSON.stringify({
    code: 0,
    data: {
      album_data:
        '{"album_id":7709414179219721278,"series_list":[{"series_id":7709414179219721279,"series_title":"第一季","season_index":1,"episode_cnt":60}]}',
    },
  });
  const album = parseAlbum(parseJSONSafe(albumRaw), "");
  assert.equal(album.id, "7709414179219721278");
  assert.equal(album.seasons[0].seriesId, "7709414179219721279");

  const hotRaw = JSON.stringify({
    code: 0,
    data: [
      {
        lynx_data:
          '[{"cell_data":[{"cell_name":"热榜","video_data":[{"series_id":7709414179219721278,"title":"热剧"}]}]}]',
      },
    ],
  });
  const hot = parseHotSearch(parseJSONSafe(hotRaw));
  assert.equal(hot.boards[0].items[0].seriesId, "7709414179219721278");
});

test("shortFilter pagination across 20 pages keeps cursor well under 4096 bytes and tolerates cache loss", async () => {
  const host = installHost();
  const seenSent = [];
  const origFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes("/service/2/device_register/")) {
      return mockResponse(
        { device_id_str: "7123456789012345678", install_id_str: "7123456789012345679", new_user: 1 },
        { setCookies: ["ttreq=1$mock; Path=/"] }
      );
    }
    if (u.pathname.includes("/reading/distribution/category/landpage/v1/")) {
      const reqBody = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (reqBody.req_type === "only_panel") {
        return mockResponse({
          code: 0,
          data: {
            selector_rows: [
              {
                type: "genre",
                row_name: "全部体裁",
                items: [{ show_name: "真人剧", selector_item_id: "short_play" }],
              },
              {
                type: "category_dim_theme",
                row_name: "全部主题",
                items: [{ show_name: "甜宠", selector_item_id: "sweet" }],
              },
            ],
          },
        });
      }
      seenSent.push(reqBody.filter_ids ? reqBody.filter_ids.split(",") : []);
      const offset = reqBody.offset || 0;
      const items = [];
      for (let i = 0; i < 18; i++) {
        items.push({
          series_id: String(7700000000000000000n + BigInt(offset + i + 1)),
          series_title: `剧${offset + i + 1}`,
          series_cover: "https://p3-reading-sign.fqnovelpic.com/c.jpg",
          episode_cnt: 60,
        });
      }
      return mockResponse({
        code: 0,
        data: {
          has_more: true,
          next_offset: offset + 18,
          session_id: "7700999999999999999",
          video_data: items,
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    let cursor = "";
    const cursorSizes = [];
    for (let pageIdx = 0; pageIdx < 20; pageIdx++) {
      const page = await plugin.collection({
        id: "filter",
        filters: pageIdx === 0 ? { genre: "short_play", category_dim_theme: "sweet" } : undefined,
        cursor: cursor || undefined,
      });
      assert.equal(page.items.length, 18);
      assert.ok(page.cursor, `page ${pageIdx + 1} should return a cursor`);
      const byteLen = Buffer.byteLength(page.cursor, "utf8");
      cursorSizes.push(byteLen);
      assert.ok(byteLen < 512, `page ${pageIdx + 1} cursor too large: ${byteLen} bytes`);
      cursor = page.cursor;
    }
    assert.equal(seenSent.length, 20);
    assert.equal(seenSent[0].length, 0);
    assert.equal(seenSent[19].length, 19 * 18);
    assert.ok(Math.max(...cursorSizes) < 512);

    // Simulate host.cache eviction: next page should still work without throwing.
    const decoded = decodeShortCursor(cursor);
    assert.ok(decoded.seenKey);
    host.cache.delete(`hongguo_seen:${decoded.seenKey}`);
    const afterEvict = await plugin.collection({ id: "filter", cursor });
    assert.equal(afterEvict.items.length, 18);
    assert.equal(seenSent[20].length, 0);
    assert.ok(Buffer.byteLength(afterEvict.cursor, "utf8") < 512);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("announceSeasons enforces time budget, reads days concurrently, and caches only complete days", async () => {
  const host = installHost();
  const normalized = seasonsOf([
    { seriesId: "100", title: "多季剧 第一季", index: 1, episodeCount: 60 },
    { seriesId: "200", title: "多季剧 第二季", index: 2, episodeCount: 60 },
  ]);

  let inFlight = 0;
  let maxConcurrent = 0;
  let slowPage2Aborted = false;
  const fetchedDays = [];

  const fakeClient = {
    async newReleases({ date, cursor, signal }) {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      try {
        if (!date && !cursor) {
          return {
            date: "20261127",
            dates: ["20261125", "20261126", "20261127"],
            items: [],
            hasMore: false,
            cursor: "",
          };
        }
        if (date === "20261126") {
          fetchedDays.push("20261126");
          await new Promise((r) => setTimeout(r, 20));
          return {
            date: "20261126",
            dates: ["20261125", "20261126", "20261127"],
            items: [],
            hasMore: false,
            cursor: "",
          };
        }
        if (date === "20261125") {
          fetchedDays.push("20261125:p1");
          await new Promise((r) => setTimeout(r, 20));
          return {
            date: "20261125",
            dates: ["20261125", "20261126", "20261127"],
            items: [],
            hasMore: true,
            cursor: "cur-20261125-p2",
          };
        }
        if (cursor === "cur-20261125-p2") {
          fetchedDays.push("20261125:p2");
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 500);
            if (signal) {
              signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(t);
                  slowPage2Aborted = true;
                  const err = new Error("aborted");
                  err.name = "AbortError";
                  reject(err);
                },
                { once: true }
              );
            }
          });
          return {
            date: "20261125",
            dates: ["20261125", "20261126", "20261127"],
            items: [
              {
                seriesId: "200",
                title: "多季剧 第二季",
                online: true,
                publishAt: 1795564800, // 2026-11-25 08:00 UTC+8
              },
            ],
            hasMore: false,
            cursor: "",
          };
        }
        return { date: date || "", dates: [], items: [], hasMore: false, cursor: "" };
      } finally {
        inFlight--;
      }
    },
  };

  const t0 = Date.now();
  await announceSeasons(fakeClient, normalized, { budgetMs: 120 });
  const elapsed = Date.now() - t0;

  assert.ok(elapsed < 400, `announceSeasons exceeded budget: ${elapsed}ms`);
  assert.ok(maxConcurrent >= 2, `days should be fetched concurrently, saw maxConcurrent=${maxConcurrent}`);
  assert.equal(slowPage2Aborted, true, "in-flight request should be aborted on budget timeout");
  assert.ok(host.cache.get("hongguo_cal:today"), "complete today should be cached");
  assert.ok(host.cache.get("hongguo_cal:20261126"), "complete day 20261126 should be cached");
  assert.equal(host.cache.get("hongguo_cal:20261125"), undefined, "incomplete day 20261125 must NOT be cached");

  // Second run: cached days are not refetched; 20261125 completes within generous budget and gets cached.
  fetchedDays.length = 0;
  const second = await announceSeasons(fakeClient, normalized, { budgetMs: 1500 });
  assert.equal(fetchedDays.includes("20261126"), false, "cached day 20261126 should not be refetched");
  assert.equal(second[1].note, "11月25日上新");
  assert.ok(host.cache.get("hongguo_cal:20261125"), "completed day 20261125 should now be cached");
});

test("media populates seasons name and image fields", async () => {
  installHost();
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
      return mockResponse({
        code: 0,
        data: {
          video_data: {
            series_id_str: "7100000000000001",
            series_title: "家里家外 第一季",
            series_cover: "https://p3-reading-sign.fqnovelpic.com/s1.jpg",
            episode_cnt: 1,
            is_multi_season: true,
            season_index: 1,
            video_list: [{ vid: "7100000000001001", vid_index: 1, duration: 90, vertical: true }],
          },
        },
      });
    }
    if (u.pathname.includes("/reading/bookapi/plan/v1/")) {
      return mockResponse({
        code: 0,
        data: [
          {
            show_type: 547,
            video_data: [
              {
                series_id: "7100000000000001",
                title: "家里家外 第一季",
                season_index: 1,
                cover: "https://p3-reading-sign.fqnovelpic.com/s1.jpg",
                episode_cnt: 60,
              },
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
      return mockResponse({
        code: 0,
        data: {
          calendar_schema: { default_date: "20261127", date_list: ["20261127"] },
          has_more: false,
          subscribe_items: [],
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    const m = await plugin.media({ id: "7100000000000001" });
    assert.equal(m.seasons.length, 2);
    assert.deepEqual(m.seasons[0], {
      id: "7100000000000001",
      title: "第1季",
      name: "家里家外 第一季",
      image: "https://p3-reading-sign.fqnovelpic.com/s1.jpg",
      current: true,
      available: true,
    });
    assert.deepEqual(m.seasons[1], {
      id: "7100000000000002",
      title: "第2季",
      name: "家里家外2",
      image: "https://p3-reading-sign.fqnovelpic.com/s2.jpg",
      current: false,
      available: true,
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});
