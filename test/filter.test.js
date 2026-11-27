import assert from "node:assert/strict";
import test from "node:test";

import { installHost } from "./host.js";
import * as plugin from "../index.js";

function mockResponse(body, { status = 200, setCookies = [] } = {}) {
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  return {
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => (name.toLowerCase() === "set-cookie" ? setCookies.join(", ") || null : null),
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

function panel(scene) {
  return {
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
            scene === "comic_series"
              ? [{ show_name: "热血", selector_item_id: "hot" }, { show_name: "甜宠", selector_item_id: "sweet" }]
              : [{ show_name: "甜宠", selector_item_id: "sweet" }],
        },
      ],
    },
  };
}

function setup({ failList = false } = {}) {
  installHost();
  const bodies = [];
  const orig = globalThis.fetch;
  const origLog = console.log;
  console.log = () => {};
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.includes("/service/2/device_register/")) {
      return mockResponse(
        { device_id_str: "7123456789012345678", install_id_str: "7123456789012345679", new_user: 1 },
        { setCookies: ["ttreq=1$mock; Path=/"] }
      );
    }
    if (u.pathname.includes("/reading/distribution/category/landpage/v1/")) {
      const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (body.req_type === "only_panel") return mockResponse(panel(body.req_scene));
      bodies.push(body);
      if (failList) return mockResponse({}, { status: 500 });
      return mockResponse({
        code: 0,
        data: {
          has_more: true,
          next_offset: (body.offset || 0) + 18,
          session_id: "sess",
          video_data: [{ series_id: `71000000000002${String(bodies.length).padStart(2, "0")}`, title: "剧" }],
        },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return {
    bodies,
    restore: () => {
      globalThis.fetch = orig;
      console.log = origLog;
    },
  };
}

test("filter values outside the genre row carry the genre and lapse when the genre changes", async () => {
  const { bodies, restore } = setup();
  try {
    const first = await plugin.collection({ id: "filter", filters: { genre: "short_play" } });
    const theme = first.filters.find((r) => r.key === "category_dim_theme");
    assert.deepEqual(theme.options, [
      { value: "", title: "全部" },
      { value: "short_play:sweet", title: "甜宠" },
    ]);

    // Choose 甜宠 under 真人剧: it is sent unprefixed.
    const sweet = await plugin.collection({
      id: "filter",
      filters: { genre: "short_play", category_dim_theme: "short_play:sweet" },
    });
    assert.equal(sweet.filters[1].value, "short_play:sweet");
    assert.deepEqual(bodies.at(-1).select_items.category_dim_theme, ["sweet"]);
    assert.deepEqual(bodies.at(-1).select_items.genre, ["short_play"]);

    // Switch to 漫剧: 漫剧 has its own 甜宠 with the same raw value, yet the
    // choice made under 真人剧 lapses.
    const comic = await plugin.collection({
      id: "filter",
      filters: { genre: "comic_series", category_dim_theme: "short_play:sweet" },
    });
    assert.equal(comic.filters[0].value, "comic_series");
    assert.equal(comic.filters[1].value, "");
    assert.deepEqual(comic.filters[1].options.map((o) => o.value), ["", "comic_series:hot", "comic_series:sweet"]);
    assert.deepEqual(bodies.at(-1).select_items.category_dim_theme, []);

    // The next page sends only the cursor; the selections come from it.
    const next = await plugin.collection({
      id: "filter",
      filters: { genre: "short_play", category_dim_theme: "short_play:sweet" },
      cursor: sweet.cursor,
    });
    assert.equal(next.filters, undefined);
    assert.equal(bodies.at(-1).offset, 18);
    assert.deepEqual(bodies.at(-1).select_items.category_dim_theme, ["sweet"]);
  } finally {
    restore();
  }
});

test("filter rows come back with a page error when only the list fails", async () => {
  const { restore } = setup({ failList: true });
  try {
    const page = await plugin.collection({ id: "filter", filters: { genre: "comic_series" } });
    assert.equal(page.filters.length, 2);
    assert.equal(page.filters[0].value, "comic_series");
    assert.deepEqual(page.items, []);
    assert.equal(page.cursor, undefined);
    assert.equal(page.error.code, "plugin");
    assert.match(page.error.message, /^[一-鿿，]+$/u);
  } finally {
    restore();
  }
});

test("a filter cursor sent twice gets the same page", async () => {
  const { bodies, restore } = setup();
  try {
    const first = await plugin.collection({ id: "filter", filters: { genre: "short_play" } });
    const second = await plugin.collection({ id: "filter", cursor: first.cursor });
    const sentSecond = bodies.at(-1);
    // Reading on from page 2 records page 2's IDs as seen.
    const third = await plugin.collection({ id: "filter", cursor: second.cursor });
    assert.ok(third.cursor);
    // The host asks for page 2 again: the same offset and the same seen IDs.
    await plugin.collection({ id: "filter", cursor: first.cursor });
    const again = bodies.at(-1);
    assert.equal(again.offset, sentSecond.offset);
    assert.equal(again.filter_ids, sentSecond.filter_ids);
    assert.equal(again.filter_ids, first.items.map((i) => i.id).join(","));
  } finally {
    restore();
  }
});

test("filter cursors stay short however far the list is read", async () => {
  const { restore } = setup();
  try {
    let page = await plugin.collection({ id: "filter", filters: { genre: "short_play" } });
    const lengths = [];
    for (let i = 0; i < 20 && page.cursor; i++) {
      lengths.push(page.cursor.length);
      page = await plugin.collection({ id: "filter", cursor: page.cursor });
    }
    assert.equal(lengths.length, 20);
    assert.ok(Math.max(...lengths) <= 256, `cursor grew to ${Math.max(...lengths)} characters`);
  } finally {
    restore();
  }
});
