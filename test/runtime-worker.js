// One plugin runtime for test/runtimes.js. node --test also loads this file
// as a test of its own; outside a worker it does nothing.
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { createHost } from "./host.js";

if (!isMainThread) await run();

async function run() {

  const flag = new Int32Array(workerData.sab, 0, 2);
  const data = new Uint8Array(workerData.sab, 8);

  function syncCall(area, op, args) {
    Atomics.store(flag, 0, 0);
    parentPort.postMessage({ type: "sync", area, op, args });
    Atomics.wait(flag, 0, 0);
    const len = Atomics.load(flag, 1);
    const out = JSON.parse(Buffer.from(data.subarray(0, len)).toString("utf8"));
    if (out.err) throw new Error(out.err);
    return out.v;
  }

  const host = createHost({ cacheAdd: workerData.cacheAdd });
  for (const area of ["storage", "cache"]) {
    for (const op of Object.keys(host[area])) {
      host[area][op] = (...args) => syncCall(area, op, args);
    }
  }
  globalThis.host = host;

  console.log = (...args) => parentPort.postMessage({ type: "log", line: args.join(" ") });

  let nextId = 0;
  const pending = new Map();
  globalThis.fetch = (url, init = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const signal = init.signal;
      if (signal?.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      signal?.addEventListener("abort", () => {
        pending.delete(id);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
      pending.set(id, { resolve, reject });
      let body = init.body;
      if (body instanceof Uint8Array) body = Array.from(body);
      parentPort.postMessage({
        type: "fetch",
        id,
        url: String(url),
        init: { method: init.method || "GET", headers: { ...(init.headers || {}) }, body },
      });
    });

  parentPort.on("message", async (msg) => {
    if (msg.type === "fetchResult") {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) {
        p.reject(new TypeError(msg.error));
        return;
      }
      const bytes = Buffer.from(msg.body, "utf8");
      const headers = msg.headers;
      p.resolve({
        status: msg.status,
        ok: msg.status >= 200 && msg.status < 300,
        headers: {
          getSetCookie: () => msg.setCookies,
          get: (name) => {
            const lower = name.toLowerCase();
            if (lower === "set-cookie") return msg.setCookies.join(", ") || null;
            return headers[lower] ?? null;
          },
        },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      });
      return;
    }
    if (msg.type === "call") {
      try {
        const value = await plugin[msg.fn](msg.req);
        parentPort.postMessage({ type: "done", ok: true, value });
      } catch (err) {
        parentPort.postMessage({
          type: "done",
          ok: false,
          error: { message: String(err?.message || err), code: err?.code, retryAfter: err?.retryAfter },
        });
      }
    }
  });

  const plugin = await import("../index.js");
  parentPort.postMessage({ type: "ready" });
}
