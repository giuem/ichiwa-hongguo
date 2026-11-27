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

const actorRanking = {
  code: 0,
  data: {
    has_more: false,
    cell_view: {
      cell_selector: {
        outer_row: { items: [{ show_name: "演员", selector_item_id: "ranklist_celebrity", is_selected: true }] },
      },
      cell_data: [
        {
          ugc_user_data: [
            {
              user_info: { base_info: { user_name: "演员甲", user_id: "12345678" } },
              rec_text_item: { RecommendText: "100万人气" },
            },
          ],
        },
      ],
    },
  },
};

test("the ranking always offers the actor ranking and later pages send only the cursor", async () => {
  installHost();
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
      if (u.searchParams.get("selected_items") === "ranklist_celebrity") return mockResponse(actorRanking);
      return mockResponse(dramaRanking(Number(u.searchParams.get("offset") || 0)));
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
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

    const actors = await plugin.collection({ id: "rank", filters: { content: "ranklist_celebrity", board: "hot" } });
    assert.equal(requests.at(-1).get("sub_selected_items"), null, "no stale board on the actor ranking");
    assert.equal(actors.items[0].kind, "collection");
    assert.equal(actors.items[0].id, "person:12345678");
    assert.equal(actors.filters.length, 1, "the actor ranking has no 榜单 row");
    assert.equal(actors.filters[0].value, "ranklist_celebrity");
    assert.deepEqual(
      actors.filters[0].options.map((o) => o.value),
      ["all", "comic", "ranklist_celebrity"],
      "the other 类别 stay on offer"
    );
  } finally {
    globalThis.fetch = orig;
  }
});
