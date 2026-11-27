import assert from "node:assert/strict";
import test from "node:test";

import { installHost } from "./host.js";
import * as plugin from "../index.js";

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

function dramaRanking(offset) {
  return {
    code: 0,
    data: {
      has_more: true,
      next_offset: offset + 1,
      session_id: "sess",
      cell_view: {
        cell_selector: {
          outer_row: {
            items: [
              {
                show_name: "全部",
                selector_item_id: "all",
                is_selected: true,
                sub_cell_selector: {
                  outer_row: { items: [{ show_name: "推荐榜", selector_item_id: "hot", is_selected: true }] },
                },
              },
              { show_name: "漫剧", selector_item_id: "comic" },
            ],
          },
        },
        cell_data: [
          { video_data: [{ series_id: `710000000000010${offset}`, title: `第${offset + 1}名`, episode_cnt: 50 }] },
        ],
      },
    },
  };
}

function actorRanking(board) {
  const fans = board === "ranklist_actor_fans";
  return {
    code: 0,
    data: {
      has_more: false,
      cell_view: {
        cell_selector: {
          outer_row: {
            items: [
              {
                show_name: "演员",
                selector_item_id: "ranklist_celebrity",
                is_selected: true,
                sub_cell_selector: {
                  outer_row: {
                    items: [
                      { show_name: "剧星榜", selector_item_id: "ranklist_series_actor", is_selected: !fans },
                      { show_name: "星光榜", selector_item_id: "ranklist_actor_fans", is_selected: fans },
                    ],
                  },
                },
              },
            ],
          },
        },
        cell_data: [
          {
            ugc_user_data: [
              {
                user_info: {
                  base_info: { user_name: fans ? "演员乙" : "演员甲", user_id: fans ? "22345678" : "12345678" },
                },
                rec_text_item: { RecommendText: "100万人气" },
              },
            ],
          },
        ],
      },
    },
  };
}

// rankServer answers registrations and the rankings, recording the query of
// each ranking request.
function rankServer() {
  const requests = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname.includes("/service/2/device_register/")) {
      return mockResponse(
        { device_id_str: "7123456789012345678", install_id_str: "7123456789012345679", new_user: 1 },
        { setCookies: ["ttreq=1$mock; Path=/"] }
      );
    }
    if (u.pathname.includes("/reading/bookapi/bookmall/cell/change/v1/")) {
      requests.push(u.searchParams);
      if (u.searchParams.get("selected_items") === "ranklist_celebrity") {
        return mockResponse(actorRanking(u.searchParams.get("sub_selected_items")));
      }
      return mockResponse(dramaRanking(Number(u.searchParams.get("offset") || 0)));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return { requests, restore: () => (globalThis.fetch = orig) };
}

const FALLBACK_CONTENTS = ["all", "series_album", "comic_series_rank", "human", "ai_playlet", "ranklist_celebrity"];

test("the ranking always offers the actor ranking and later pages send only the cursor", async () => {
  installHost();
  const { requests, restore } = rankServer();
  try {
    const first = await plugin.collection({ id: "rank" });
    const content = first.filters[0];
    assert.deepEqual(
      content.options.map((o) => o.value),
      ["all", "comic", "ranklist_celebrity"]
    );
    assert.equal(content.options.at(-1).title, "演员榜");
    assert.equal(first.filters[1].key, "board");

    // Page 2 continues the cursor even when the filters sent along differ.
    const second = await plugin.collection({
      id: "rank",
      filters: { content: "comic", board: "x" },
      cursor: first.cursor,
    });
    assert.equal(second.filters, undefined);
    assert.equal(second.items[0].id, "7100000000000101");
    assert.equal(requests.at(-1).get("selected_items"), "all");
    assert.equal(requests.at(-1).get("sub_selected_items"), "hot", "the cursor's board, not the filters'");

    const actors = await plugin.collection({ id: "rank", filters: { content: "ranklist_celebrity" } });
    assert.equal(actors.items[0].kind, "collection");
    assert.equal(actors.items[0].id, "person:12345678");
    assert.equal(actors.filters[0].value, "ranklist_celebrity");
    assert.deepEqual(
      actors.filters[0].options.map((o) => o.value),
      ["all", "comic", "ranklist_celebrity"],
      "the other 类别 stay on offer"
    );
    assert.equal(actors.filters[0].options.at(-1).title, "演员榜", "not the server's 演员");
    assert.deepEqual(
      actors.filters[1].options.map((o) => o.title),
      ["剧星榜", "星光榜"]
    );
    assert.equal(actors.filters[1].value, "ranklist_series_actor");

    // A board left over from another 类别 is dropped.
    await plugin.collection({ id: "rank", filters: { content: "ranklist_celebrity", board: "hot" } });
    assert.equal(requests.at(-1).get("sub_selected_items"), null, "no stale board on the actor ranking");
    await plugin.collection({ id: "rank", filters: { content: "all", board: "ranklist_actor_fans" } });
    assert.equal(requests.at(-1).get("sub_selected_items"), null, "no stale actor board on the dramas");
  } finally {
    restore();
  }
});

test("choosing 星光榜 on the actor ranking shows 星光榜", async () => {
  installHost();
  const { requests, restore } = rankServer();
  try {
    const page = await plugin.collection({
      id: "rank",
      filters: { content: "ranklist_celebrity", board: "ranklist_actor_fans" },
    });
    assert.equal(requests.at(-1).get("sub_selected_items"), "ranklist_actor_fans");
    assert.equal(page.items[0].id, "person:22345678");
    assert.equal(page.filters[1].value, "ranklist_actor_fans");

    // Also once the actor ranking's own boards are cached.
    await plugin.collection({ id: "rank", filters: { content: "ranklist_celebrity" } });
    const again = await plugin.collection({
      id: "rank",
      filters: { content: "ranklist_celebrity", board: "ranklist_actor_fans" },
    });
    assert.equal(requests.at(-1).get("sub_selected_items"), "ranklist_actor_fans");
    assert.equal(again.filters[1].value, "ranklist_actor_fans");
  } finally {
    restore();
  }
});

test("the actor ranking keeps the other 类别 when the cache is cold", async () => {
  const host = installHost();
  const { restore } = rankServer();
  try {
    // Never saw another ranking: the fallback list.
    const cold = await plugin.collection({ id: "rank", filters: { content: "ranklist_celebrity" } });
    assert.deepEqual(cold.filters[0].options.map((o) => o.value), FALLBACK_CONTENTS);
    assert.equal(cold.filters[0].options.find((o) => o.value === "comic_series_rank").title, "漫剧");

    // The list last seen lives in host.storage, past the cache.
    await plugin.collection({ id: "rank" });
    const stored = host.storage.get("hongguo_rank_contents");
    for (const key of ["hongguo_rank_contents", "hongguo_rank_contents:ranklist_celebrity"]) host.cache.delete(key);
    const warm = await plugin.collection({ id: "rank", filters: { content: "ranklist_celebrity" } });
    assert.deepEqual(warm.filters[0].options.map((o) => o.value), ["all", "comic", "ranklist_celebrity"]);
    assert.deepEqual(JSON.parse(stored), [
      { id: "all", name: "全部" },
      { id: "comic", name: "漫剧" },
    ]);
  } finally {
    restore();
  }
});

test("a ranking cursor sent twice gets the same page and the same places", async () => {
  installHost();
  const { requests, restore } = rankServer();
  try {
    const first = await plugin.collection({ id: "rank" });
    const second = await plugin.collection({ id: "rank", cursor: first.cursor });
    const sentSecond = requests.at(-1);
    await plugin.collection({ id: "rank", cursor: second.cursor });
    const again = await plugin.collection({ id: "rank", cursor: first.cursor });
    const sentAgain = requests.at(-1);
    assert.equal(sentAgain.get("offset"), sentSecond.get("offset"));
    assert.equal(sentAgain.get("filter_ids"), sentSecond.get("filter_ids"));
    assert.equal(sentAgain.get("filter_ids"), "7100000000000100");
    assert.deepEqual(again.items, second.items);
  } finally {
    restore();
  }
});

test("ranking cursors stay short however far the list is read", async () => {
  installHost();
  const { restore } = rankServer();
  try {
    let page = await plugin.collection({ id: "rank" });
    const lengths = [];
    for (let i = 0; i < 20 && page.cursor; i++) {
      lengths.push(page.cursor.length);
      page = await plugin.collection({ id: "rank", cursor: page.cursor });
    }
    assert.equal(lengths.length, 20);
    assert.ok(Math.max(...lengths) <= 256, `cursor grew to ${Math.max(...lengths)} characters`);
  } finally {
    restore();
  }
});
