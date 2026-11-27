// Device registration and rotation across calls that run at once, each in a
// runtime of its own (test/runtimes.js), sharing host.storage and host.cache.
import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimes } from "./runtimes.js";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PROFILE_KEY = "hongguo_device_profile";
const LOCK_KEY = "hongguo_device_rotating";

// server registers a new device per registration, after regDelay(n) ms, and
// answers 联想 for any device not in rejected.
function server({ regDelay = () => 30 } = {}) {
  const state = { regs: 0, rejected: new Set() };
  state.handle = async (u) => {
    if (u.pathname.includes("/service/2/device_register/")) {
      const n = ++state.regs;
      await delay(regDelay(n));
      return {
        body: { device_id_str: String(710000000000000000n + BigInt(n)), install_id_str: String(720000000000000000n + BigInt(n)), new_user: 1 },
        setCookies: [`ttreq=1$tok${n}; Path=/`],
      };
    }
    await delay(5);
    if (state.rejected.has(u.searchParams.get("device_id"))) {
      return { body: { BaseResp: { StatusCode: 263175 } } };
    }
    return { body: { code: 0, data: { query_result: ["甲"] } } };
  };
  return state;
}

function storedDevice(rt) {
  return JSON.parse(rt.host.storage.get(PROFILE_KEY) || "null")?.device_id_str;
}

async function rounds(rt, srv, n, before) {
  const regsPerRound = [];
  for (let i = 0; i < n; i++) {
    before();
    await rt.warm(4);
    const start = srv.regs;
    const results = await Promise.all([1, 2, 3, 4].map(() => rt.call("suggest", { query: "甲" })));
    for (const r of results) assert.deepEqual(r.items, ["甲"]);
    regsPerRound.push(srv.regs - start);
  }
  return regsPerRound;
}

for (const cacheAdd of [true, false]) {
  const mode = cacheAdd ? "with host.cache.add" : "without host.cache.add";

  test(`four calls on a cold start register one device between them (${mode})`, { timeout: 60_000 }, async () => {
    const srv = server();
    const rt = createRuntimes({ handle: srv.handle, cacheAdd });
    try {
      const regs = await rounds(rt, srv, 25, () => {
        rt.host.storage.delete(PROFILE_KEY);
        rt.host.cache.delete(LOCK_KEY);
      });
      assert.deepEqual(regs, regs.map(() => 1), `registrations per round: ${regs.join(",")}`);
    } finally {
      await rt.close();
    }
  });

  test(`four calls on a refused device replace it once between them (${mode})`, { timeout: 60_000 }, async () => {
    const srv = server();
    const rt = createRuntimes({ handle: srv.handle, cacheAdd });
    try {
      await rt.call("suggest", { query: "甲" });
      const regs = await rounds(rt, srv, 25, () => srv.rejected.add(storedDevice(rt)));
      assert.deepEqual(regs, regs.map(() => 1), `registrations per round: ${regs.join(",")}`);
    } finally {
      await rt.close();
    }
  });

  test(`a slow registration is waited for, not repeated (${mode})`, { timeout: 60_000 }, async () => {
    const srv = server({ regDelay: () => 3500 });
    const rt = createRuntimes({ handle: srv.handle, cacheAdd });
    try {
      await rt.warm(4);
      const t0 = Date.now();
      const took = await Promise.all(
        [1, 2, 3, 4].map(() => rt.call("suggest", { query: "甲" }).then(() => Date.now() - t0))
      );
      assert.equal(srv.regs, 1);
      for (const ms of took) assert.ok(ms < 4500, `a call took ${ms}ms`);
    } finally {
      await rt.close();
    }
  });

  test(`a lock left by a cancelled call lapses (${mode})`, { timeout: 60_000 }, async () => {
    const srv = server({ regDelay: (n) => (n === 1 ? 10_000 : 30) });
    const rt = createRuntimes({ handle: srv.handle, cacheAdd });
    try {
      await rt.warm(2);
      const holder = rt.start("suggest", { query: "甲" });
      holder.promise.catch(() => {});
      await delay(300);
      assert.ok(rt.host.cache.get(LOCK_KEY), "the first call holds the lock");
      holder.cancel();
      const t0 = Date.now();
      await rt.call("suggest", { query: "甲" });
      const took = Date.now() - t0;
      assert.equal(srv.regs, 2);
      assert.ok(took < 3000, `the next call took ${took}ms`);
    } finally {
      await rt.close();
    }
  });
}
