// Runs plugin calls the way the host does: each call in a runtime of its own
// (a worker thread with a fresh copy of the plugin), all calls at once,
// sharing only host.storage and host.cache. The workers reach the shared
// storage and cache synchronously, as moejs calls do, so the reads and
// writes of different calls interleave for real.
import { Worker } from "node:worker_threads";

import { createHost } from "./host.js";

const WORKER_URL = new URL("./runtime-worker.js", import.meta.url);
const SYNC_BYTES = 1 << 20;

// createRuntimes returns calls that run in their own runtimes. handle(url,
// init) answers every request the plugin makes with { status, body,
// setCookies, headers }; it may be async.
export function createRuntimes({ handle, cacheAdd = true } = {}) {
  const shared = createHost({ cacheAdd });
  const logs = [];
  const idle = [];
  const live = new Set();

  function spawn() {
    const sab = new SharedArrayBuffer(8 + SYNC_BYTES);
    const flag = new Int32Array(sab, 0, 2);
    const data = new Uint8Array(sab, 8);
    const worker = new Worker(WORKER_URL, { workerData: { sab, cacheAdd } });
    live.add(worker);
    const rt = { worker, done: null };
    rt.ready = new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.on("message", async (msg) => {
        switch (msg.type) {
          case "ready":
            resolve(rt);
            break;
          case "sync": {
            let out;
            try {
              out = { v: shared[msg.area][msg.op](...msg.args) };
            } catch (err) {
              out = { err: String(err?.message || err) };
            }
            const bytes = Buffer.from(JSON.stringify(out), "utf8");
            data.set(bytes);
            Atomics.store(flag, 1, bytes.length);
            Atomics.store(flag, 0, 1);
            Atomics.notify(flag, 0);
            break;
          }
          case "fetch": {
            let res;
            try {
              res = await handle(new URL(msg.url), msg.init);
            } catch (err) {
              res = { error: String(err?.message || err) };
            }
            const body = res.body === undefined ? "" : typeof res.body === "string" ? res.body : JSON.stringify(res.body);
            worker.postMessage({
              type: "fetchResult",
              id: msg.id,
              error: res.error,
              status: res.status || 200,
              setCookies: res.setCookies || [],
              headers: res.headers || {},
              body,
            });
            break;
          }
          case "log":
            logs.push(msg.line);
            break;
          case "done":
            rt.done?.(msg);
            break;
        }
      });
    });
    return rt;
  }

  function take() {
    const rt = idle.shift() || spawn();
    idle.push(spawn()); // keep one warming up for the next call
    return rt;
  }

  // start runs fn(req) in a fresh runtime. cancel() ends the runtime at once,
  // as the host does with a call it no longer needs: nothing of it runs on,
  // not even its finally blocks.
  function start(fn, req) {
    const rt = take();
    let cancel;
    const promise = rt.ready.then(
      () =>
        new Promise((resolve, reject) => {
          cancel = () => {
            rt.worker.terminate();
            live.delete(rt.worker);
            reject(Object.assign(new Error("cancelled"), { cancelled: true }));
          };
          rt.done = (msg) => {
            rt.worker.terminate();
            live.delete(rt.worker);
            if (msg.ok) resolve(msg.value);
            else reject(Object.assign(new Error(msg.error.message), msg.error));
          };
          rt.worker.postMessage({ type: "call", fn, req });
        })
    );
    return {
      promise,
      cancel: () => {
        if (cancel) cancel();
        else rt.ready.then(() => cancel());
      },
    };
  }

  return {
    host: shared,
    logs,
    // warm starts n runtimes ahead, so calls started together start together.
    async warm(n) {
      while (idle.length < n) idle.push(spawn());
      await Promise.all(idle.map((rt) => rt.ready));
    },
    call: (fn, req) => start(fn, req).promise,
    start,
    async close() {
      await Promise.all([...live].map((w) => w.terminate()));
    },
  };
}
