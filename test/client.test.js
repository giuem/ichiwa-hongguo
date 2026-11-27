import assert from "node:assert/strict";
import test from "node:test";

import { installHost } from "./host.js";
import * as plugin from "../index.js";
import { HongguoClient } from "../src/client.js";
import { ErrCode, HongguoError, toHostError } from "../src/errors.js";

function mockResponse(body, { status = 200, setCookies = [], headers = {} } = {}) {
  const bytes =
    typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(JSON.stringify(body), "utf8");
  return {
    status,
    headers: {
      getSetCookie: () => setCookies,
      get: (name) => {
        const lower = name.toLowerCase();
        if (lower === "set-cookie") return setCookies.join(", ") || null;
        return headers[lower] ?? null;
      },
    },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// fakeServer answers device registration with a new device each time, after
// regDelayMs, and passes every other request to handle(url, init, deviceId).
function fakeServer(handle, { regDelayMs = 30 } = {}) {
  const state = { regs: 0, requests: [] };
  const fetchFn = async (url, init) => {
    const u = new URL(url);
    state.requests.push({ url: u, init });
    if (u.pathname.includes("/service/2/device_register/")) {
      state.regs++;
      const n = state.regs;
      await delay(regDelayMs);
      return mockResponse(
        { device_id_str: `71000000000000000${n}`, install_id_str: `72000000000000000${n}`, new_user: 1 },
        { setCookies: [`ttreq=1$tok${n}; Path=/`] }
      );
    }
    return handle(u, init, u.searchParams.get("device_id") || "");
  };
  return { state, fetchFn };
}

function withFetch(fetchFn) {
  const orig = globalThis.fetch;
  globalThis.fetch = fetchFn;
  return () => {
    globalThis.fetch = orig;
  };
}

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  return {
    lines,
    restore: () => {
      console.log = orig;
    },
  };
}

const PLAY_OK = {
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
              main_url: Buffer.from("https://v3-reading.qznovelvod.com/720.mp4").toString("base64"),
              video_meta: { codec_type: "h264", vwidth: 720, vheight: 1280, bitrate: 1500000 },
            },
          },
        }),
      },
    },
  },
};

test("concurrent plays on a refused device register one new device between them", async () => {
  const host = installHost();
  const { state, fetchFn } = fakeServer((u, init, deviceId) => {
    // The first device is limited: playback answers with an empty body.
    if (deviceId === "710000000000000001") return mockResponse("");
    if (u.pathname.includes("multi_video_model")) return mockResponse(PLAY_OK);
    return mockResponse("");
  });
  const restore = withFetch(fetchFn);
  const logs = captureLogs();
  try {
    // A first call registers device 1.
    await new HongguoClient({ fetch: fetchFn }).ensureGuest(true);
    assert.equal(state.regs, 1);

    const req = {
      mediaId: "7690184933037329432",
      episodeId: "7690261304497458201",
      prefer: { maxHeight: 1080, hevc: true },
    };
    // Each plugin call builds its own client, as each moejs call gets its own
    // runtime; only host.storage and host.cache are shared.
    const results = await Promise.all([1, 2, 3, 4].map(() => plugin.play(req)));
    for (const pb of results) {
      assert.equal(pb.streams[0].url, "https://v3-reading.qznovelvod.com/720.mp4");
    }
    assert.equal(state.regs, 2, "four concurrent calls replace the refused device once");
    const stored = JSON.parse(host.storage.get("hongguo_device_profile"));
    assert.equal(stored.device_id_str, "710000000000000002");
    assert.ok(logs.lines.some((l) => l.includes("device 710000000000000001 refused")));
  } finally {
    logs.restore();
    restore();
  }
});

test("a device replaced by another call is reused instead of registering again", async () => {
  installHost();
  const { state, fetchFn } = fakeServer(() => mockResponse(""));
  const restore = withFetch(fetchFn);
  const logs = captureLogs();
  try {
    const a = new HongguoClient({ fetch: fetchFn });
    await a.ensureGuest(true);
    // Another call replaces device 1 with device 2.
    await new HongguoClient({ fetch: fetchFn }).resetDevice("710000000000000001");
    assert.equal(state.regs, 2);
    // This call also saw device 1 fail; it must pick up device 2.
    const p = await a.resetDevice("710000000000000001");
    assert.equal(p.device_id_str, "710000000000000002");
    assert.equal(state.regs, 2);
  } finally {
    logs.restore();
    restore();
  }
});

test("the profile and the works of a person page replace the device once between them", async () => {
  installHost();
  let profileCalls = 0;
  const { state, fetchFn } = fakeServer((u, init, deviceId) => {
    if (deviceId === "710000000000000001") {
      return mockResponse({ BaseResp: { StatusCode: 263175 } });
    }
    if (u.pathname.includes("/reading/user/profile/get/v1/")) {
      profileCalls++;
      return mockResponse({
        code: 0,
        data: { ugc_user: { user_id: "12345678", base_info: { user_name: "演员甲" } } },
      });
    }
    if (u.pathname.includes("/novel/commentapi/user/profile/12345678/v1")) {
      const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (!body.tab_type) {
        return mockResponse({
          code: 0,
          data: { tabs: [{ name: "剧作", tab_type: 8, sub_tabs: [{ name: "全部", tab_type: 100 }] }] },
        });
      }
      return mockResponse({
        code: 0,
        data: {
          data_list: [{ video: { video_id: "7100000000000301", common: { title: "代表作" } } }],
          common_list_info: { cursor: "", has_more: false },
        },
      });
    }
    throw new Error(`unexpected ${u}`);
  });
  const restore = withFetch(fetchFn);
  const logs = captureLogs();
  try {
    await new HongguoClient({ fetch: fetchFn }).ensureGuest(true);
    const page = await plugin.collection({ id: "person:12345678" });
    assert.equal(page.header.title, "演员甲");
    assert.equal(page.items[0].id, "7100000000000301");
    assert.equal(state.regs, 2, "profile and works replace the device once between them");
    assert.equal(profileCalls, 1);
  } finally {
    logs.restore();
    restore();
  }
});

test("person page shows the works without a header when the profile fails or is late", async () => {
  installHost();
  let profileMode = "fail";
  const { fetchFn } = fakeServer(async (u, init) => {
    if (u.pathname.includes("/reading/user/profile/get/v1/")) {
      if (profileMode === "fail") return mockResponse({ code: 101000, message: "not exist" });
      await delay(1500);
      return mockResponse({
        code: 0,
        data: { ugc_user: { user_id: "12345678", base_info: { user_name: "演员甲" } } },
      });
    }
    if (u.pathname.includes("/novel/commentapi/user/profile/12345678/v1")) {
      const body = JSON.parse(Buffer.from(init.body).toString("utf8"));
      if (profileMode === "worksFail") return mockResponse({ code: 101000, message: "gone" });
      if (!body.tab_type) {
        return mockResponse({
          code: 0,
          data: { tabs: [{ name: "剧作", tab_type: 8, sub_tabs: [{ name: "全部", tab_type: 100 }] }] },
        });
      }
      return mockResponse({
        code: 0,
        data: {
          data_list: [{ video: { video_id: "7100000000000301", common: { title: "代表作" } } }],
          common_list_info: { cursor: "", has_more: false },
        },
      });
    }
    throw new Error(`unexpected ${u}`);
  });
  const restore = withFetch(fetchFn);
  const logs = captureLogs();
  try {
    const failed = await plugin.collection({ id: "person:12345678" });
    assert.equal(failed.header, undefined);
    assert.equal(failed.items[0].id, "7100000000000301");

    profileMode = "late";
    const start = Date.now();
    const late = await plugin.collection({ id: "person:12345678" });
    const took = Date.now() - start;
    assert.equal(late.header, undefined);
    assert.equal(late.items.length, 1);
    assert.ok(took < 1400, `late profile waited ${took}ms`);
    assert.ok(logs.lines.some((l) => l.includes("is late")));

    profileMode = "worksFail";
    await assert.rejects(plugin.collection({ id: "person:12345678" }), (err) => err.code === "unavailable");
  } finally {
    logs.restore();
    restore();
  }
});

test("rate limits longer than 2 seconds fail at once with retryAfter", async () => {
  installHost();
  let calls = 0;
  let ban = { minBanTime: 8, maxBanTime: 10 };
  const { fetchFn } = fakeServer(() => {
    calls++;
    if (ban) return mockResponse({ code: 100, message: JSON.stringify(ban) });
    return mockResponse({ code: 0, data: { query_result: ["甲"] } });
  });
  const restore = withFetch(fetchFn);
  const logs = captureLogs();
  try {
    const start = Date.now();
    await assert.rejects(plugin.suggest({ query: "甲" }), (err) => {
      assert.equal(err.code, "rateLimited");
      assert.equal(err.retryAfter, 9);
      assert.equal(err.message, "请求太频繁，请稍后再试");
      return true;
    });
    assert.ok(Date.now() - start < 1000, "does not sleep inside the call");
    assert.equal(calls, 1);
    assert.ok(logs.lines.some((l) => l.includes("rate limited")));

    // A short ban is waited out within the call.
    calls = 0;
    ban = { minBanTime: 1, maxBanTime: 1 };
    const fetchShort = fetchFn;
    let first = true;
    const restore2 = withFetch(async (url, init) => {
      const r = await fetchShort(url, init);
      if (!new URL(url).pathname.includes("device_register") && first) {
        first = false;
        ban = null;
      }
      return r;
    });
    try {
      const got = await plugin.suggest({ query: "甲" });
      assert.deepEqual(got.items, ["甲"]);
      assert.equal(calls, 2);
    } finally {
      restore2();
    }

    // HTTP 429 with Retry-After beyond the limit fails at once too.
    const restore3 = withFetch(async () => mockResponse("", { status: 429, headers: { "retry-after": "20" } }));
    try {
      await assert.rejects(plugin.suggest({ query: "甲" }), (err) => {
        assert.equal(err.code, "rateLimited");
        assert.equal(err.retryAfter, 20);
        return true;
      });
    } finally {
      restore3();
    }
  } finally {
    logs.restore();
    restore();
  }
});

test("errors shown to users are short Chinese sentences and details go to the log", () => {
  installHost();
  const logs = captureLogs();
  try {
    const cases = [
      [new Error("invalid JSON response: Unexpected token < in JSON"), "collection", "plugin"],
      [new HongguoError(ErrCode.APIError, "HTTP 500", { httpStatus: 500 }), "media", "plugin"],
      [new HongguoError(ErrCode.Transport, "network error: ECONNRESET"), "media", "network"],
      [new HongguoError(ErrCode.AnonymousLimited, "anonymous response was empty"), "play", "unavailable"],
      [new HongguoError(ErrCode.AuthRequired, "HTTP 401", { httpStatus: 401 }), "play", "unavailable"],
      [
        new HongguoError(ErrCode.CodeError, "gone", { bizCode: 101000, bizKind: "content_gone" }),
        "media",
        "unavailable",
      ],
      [
        new HongguoError(ErrCode.CodeError, "oversea", { bizCode: 101145, bizKind: "content_gone" }),
        "media",
        "unavailable",
      ],
      [
        new HongguoError(ErrCode.CodeError, "not exist", { bizCode: 101104, bizKind: "content_gone" }),
        "media",
        "notFound",
      ],
      [new HongguoError(ErrCode.InvalidOptions, "invalid series ID", { invalidId: true }), "media", "notFound"],
    ];
    for (const [err, ctx, code] of cases) {
      const he = toHostError(err, ctx);
      assert.equal(he.code, code, `${err.message} -> ${code}`);
      assert.match(he.message, /^[一-鿿，。、：]+$/u, `message is Chinese only: ${he.message}`);
      assert.ok(Array.from(he.message).length <= 30);
    }
    assert.ok(logs.lines.some((l) => l.includes("HTTP 500")));
    assert.ok(logs.lines.some((l) => l.includes("Unexpected token")));

    const anon = toHostError(new HongguoError(ErrCode.AnonymousLimited, "x"), "play");
    assert.equal(anon.retryAfter, 30);
  } finally {
    logs.restore();
  }
});

test("media with a malformed ID is notFound in Chinese", async () => {
  installHost();
  const logs = captureLogs();
  try {
    await assert.rejects(plugin.media({ id: "abc" }), (err) => {
      assert.equal(err.code, "notFound");
      assert.equal(err.message, "找不到这部剧");
      return true;
    });
  } finally {
    logs.restore();
  }
});

test("every request carries the plugin's own Cookie header", async () => {
  installHost();
  const { state, fetchFn } = fakeServer(() => mockResponse({ code: 0, data: { query_result: ["甲"] } }));
  const restore = withFetch(fetchFn);
  try {
    await plugin.suggest({ query: "甲" });
    assert.ok(state.requests.length >= 2);
    for (const { url, init } of state.requests) {
      const keys = Object.keys(init.headers).filter((k) => k.toLowerCase() === "cookie");
      assert.equal(keys.length, 1, `${url.pathname} sends exactly one Cookie header`);
      const value = init.headers[keys[0]];
      if (url.pathname.includes("device_register")) {
        assert.equal(value, "", "registration sends an explicit empty Cookie");
      } else {
        assert.match(value, /install_id=720000000000000001; ttreq=1\$tok1$/);
      }
    }
  } finally {
    restore();
  }
});

const REFUSED = { BaseResp: { StatusCode: 263175 } };

test("nested calls leave device rotation to the outer call", async () => {
  installHost();
  // Every device is refused: only the outer call may rotate, deviceResets
  // (3) times, so 1 + 3 devices are registered in all.
  const { state, fetchFn } = fakeServer(() => mockResponse(REFUSED), { regDelayMs: 1 });
  const restore = withFetch(fetchFn);
  const logs = captureLogs();
  try {
    // danmaku reads the episode's length through the details, nested.
    await assert.rejects(plugin.danmaku({ mediaId: "7100000000000001", episodeId: "7100000000001001" }));
    assert.equal(state.regs, 4, "danmaku");

    // The season list may fall back to the album, search and batch reads,
    // all nested.
    installHost();
    state.regs = 0;
    const client = new HongguoClient({ fetch: fetchFn, retryAttempts: 1, deviceResets: 3 });
    await assert.rejects(client.seasons("7100000000000001"));
    assert.equal(state.regs, 4, "seasons");
  } finally {
    logs.restore();
    restore();
  }
});

test("a device without a ticket sends an empty Cookie, not an empty ttreq", async () => {
  installHost();
  const { state, fetchFn } = fakeServer(() => mockResponse({ code: 0, data: { query_result: ["甲"] } }));
  // The registration sets no cookies at all.
  const noCookies = async (url, init) => {
    const r = await fetchFn(url, init);
    if (new URL(url).pathname.includes("device_register")) {
      r.headers.getSetCookie = () => [];
      r.headers.get = () => null;
    }
    return r;
  };
  const restore = withFetch(noCookies);
  const logs = captureLogs();
  try {
    await plugin.suggest({ query: "甲" });
    const sent = state.requests.filter(({ url }) => !url.pathname.includes("device_register"));
    assert.ok(sent.length > 0);
    for (const { init } of sent) assert.equal(init.headers.Cookie, "");
  } finally {
    logs.restore();
    restore();
  }
});

test("big integers in a response keep every digit", async () => {
  installHost();
  const { fetchFn } = fakeServer((u) => {
    if (u.pathname.includes("/novel/player/video_detail/v1/")) {
      // Numbers, not strings: JSON.parse would round them.
      return mockResponse(
        '{"code":0,"data":{"video_data":{"series_id":7100000000000000123,"series_title":"剧","episode_cnt":1,' +
          '"video_list":[{"vid":7100000000000001123,"vid_index":1,"duration":90}]}}}'
      );
    }
    return mockResponse({ code: 0, data: {} });
  });
  const restore = withFetch(fetchFn);
  const logs = captureLogs();
  try {
    const m = await plugin.media({ id: "7100000000000000123" });
    assert.equal(m.id, "7100000000000000123");
    assert.equal(m.episodes[0].id, "7100000000000001123");
  } finally {
    logs.restore();
    restore();
  }
});

test("the device lock keeps real time whatever the client's clock says", async () => {
  // Without host.cache.add the lock is read back by its time; a client
  // whose clock is far off must not see a live lock as lapsed.
  installHost({ cacheAdd: false });
  const { state, fetchFn } = fakeServer(() => mockResponse(""), { regDelayMs: 2500 });
  const logs = captureLogs();
  try {
    const clock = () => 1_600_000_000_000;
    await Promise.all([
      new HongguoClient({ fetch: fetchFn, clock }).ensureGuest(true),
      delay(100).then(() => new HongguoClient({ fetch: fetchFn, clock }).ensureGuest(true)),
    ]);
    assert.equal(state.regs, 1);
  } finally {
    logs.restore();
  }
});
