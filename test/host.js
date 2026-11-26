import crypto from "node:crypto";
import zlib from "node:zlib";

const MAX_STORAGE_BYTES = 64 * 1024;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ITEM_BYTES = 256 * 1024;
const MAX_DECOMPRESS_BYTES = 4 * 1024 * 1024;

function toBuffer(data) {
  if (typeof data === "string") {
    return Buffer.from(data, "utf8");
  }
  if (data instanceof Uint8Array) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("expected string or Uint8Array");
}

function toUint8Array(buf) {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * Create a Node.js implementation of the Ichiwa plugin Host API (plugin-design.md §8).
 */
export function createHost(options = {}) {
  const storageMap = new Map();
  const cacheMap = new Map();
  const deviceInfo = {
    platform: options.platform ?? "macos",
    appVersion: options.appVersion ?? "2026.1201.1",
    locale: options.locale ?? "zh-CN",
  };

  function storageBytes() {
    let total = 0;
    for (const [k, v] of storageMap) {
      total += Buffer.byteLength(k, "utf8") + Buffer.byteLength(v, "utf8");
    }
    return total;
  }

  function pruneCache() {
    const now = Date.now();
    for (const [k, entry] of cacheMap) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) {
        cacheMap.delete(k);
      }
    }
  }

  function cacheBytes() {
    let total = 0;
    for (const [k, entry] of cacheMap) {
      total += Buffer.byteLength(k, "utf8") + Buffer.byteLength(entry.value, "utf8");
    }
    return total;
  }

  const host = {
    storage: {
      get(key) {
        return storageMap.get(String(key));
      },
      set(key, value) {
        const k = String(key);
        const v = String(value);
        const prev = storageMap.get(k);
        storageMap.set(k, v);
        if (storageBytes() > MAX_STORAGE_BYTES) {
          if (prev === undefined) {
            storageMap.delete(k);
          } else {
            storageMap.set(k, prev);
          }
          throw new Error("host.storage quota exceeded (64 KiB)");
        }
      },
      delete(key) {
        storageMap.delete(String(key));
      },
    },

    cache: {
      get(key) {
        pruneCache();
        const entry = cacheMap.get(String(key));
        return entry ? entry.value : undefined;
      },
      set(key, value, ttlSeconds) {
        pruneCache();
        const k = String(key);
        const v = String(value);
        const itemBytes = Buffer.byteLength(k, "utf8") + Buffer.byteLength(v, "utf8");
        if (itemBytes > MAX_CACHE_ITEM_BYTES) {
          throw new Error("host.cache item exceeds 256 KiB");
        }
        const expiresAt =
          typeof ttlSeconds === "number" && ttlSeconds > 0
            ? Date.now() + ttlSeconds * 1000
            : null;
        cacheMap.delete(k);
        cacheMap.set(k, { value: v, expiresAt });
        while (cacheBytes() > MAX_CACHE_BYTES && cacheMap.size > 0) {
          const oldest = cacheMap.keys().next().value;
          cacheMap.delete(oldest);
        }
      },
      delete(key) {
        cacheMap.delete(String(key));
      },
    },

    crypto: {
      md5(data) {
        return crypto.createHash("md5").update(toBuffer(data)).digest("hex");
      },
      sha1(data) {
        return crypto.createHash("sha1").update(toBuffer(data)).digest("hex");
      },
      sha256(data) {
        return crypto.createHash("sha256").update(toBuffer(data)).digest("hex");
      },
      hmac(alg, key, data) {
        if (!["md5", "sha1", "sha256"].includes(alg)) {
          throw new Error(`unsupported hmac algorithm: ${alg}`);
        }
        return crypto.createHmac(alg, toBuffer(key)).update(toBuffer(data)).digest("hex");
      },
      aes({ mode, key, iv, data, decrypt = false, padding = "pkcs7", aad }) {
        const keyBuf = toBuffer(key);
        const dataBuf = toBuffer(data);
        const bits = keyBuf.length * 8;
        if (bits !== 128 && bits !== 192 && bits !== 256) {
          throw new Error(`invalid AES key length: ${keyBuf.length}`);
        }
        const alg = `aes-${bits}-${mode}`;
        const ivBuf = mode === "ecb" ? null : toBuffer(iv ?? new Uint8Array(0));

        if (mode === "gcm") {
          if (decrypt) {
            if (dataBuf.length < 16) {
              throw new Error("GCM ciphertext too short");
            }
            const tag = dataBuf.subarray(dataBuf.length - 16);
            const ct = dataBuf.subarray(0, dataBuf.length - 16);
            const decipher = crypto.createDecipheriv(alg, keyBuf, ivBuf);
            if (aad !== undefined) {
              decipher.setAAD(toBuffer(aad));
            }
            decipher.setAuthTag(tag);
            return toUint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
          }
          const cipher = crypto.createCipheriv(alg, keyBuf, ivBuf);
          if (aad !== undefined) {
            cipher.setAAD(toBuffer(aad));
          }
          const ct = Buffer.concat([cipher.update(dataBuf), cipher.final()]);
          const tag = cipher.getAuthTag();
          return toUint8Array(Buffer.concat([ct, tag]));
        }

        const fn = decrypt ? crypto.createDecipheriv : crypto.createCipheriv;
        const instance = fn(alg, keyBuf, ivBuf);
        if (mode === "ecb" || mode === "cbc") {
          instance.setAutoPadding(padding !== "none");
        }
        return toUint8Array(Buffer.concat([instance.update(dataBuf), instance.final()]));
      },
      rsa({ publicKey, data, padding = "pkcs1" }) {
        const buf = toBuffer(data);
        let padConst = crypto.constants.RSA_PKCS1_PADDING;
        let oaepHash;
        if (padding === "oaep-sha1") {
          padConst = crypto.constants.RSA_PKCS1_OAEP_PADDING;
          oaepHash = "sha1";
        } else if (padding === "oaep-sha256") {
          padConst = crypto.constants.RSA_PKCS1_OAEP_PADDING;
          oaepHash = "sha256";
        }
        const encrypted = crypto.publicEncrypt(
          { key: publicKey, padding: padConst, oaepHash },
          buf
        );
        return toUint8Array(encrypted);
      },
      randomBytes(n) {
        if (!Number.isInteger(n) || n < 0 || n > 1024) {
          throw new RangeError("randomBytes n must be an integer in [0, 1024]");
        }
        return toUint8Array(crypto.randomBytes(n));
      },
      uuid() {
        return crypto.randomUUID();
      },
    },

    encoding: {
      hex(b) {
        return toBuffer(b).toString("hex");
      },
      fromHex(s) {
        const clean = String(s).trim();
        if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
          throw new Error("invalid hex string");
        }
        return toUint8Array(Buffer.from(clean, "hex"));
      },
      base64(b) {
        return toBuffer(b).toString("base64");
      },
      fromBase64(s) {
        let normalized = String(s).trim().replace(/-/g, "+").replace(/_/g, "/");
        while (normalized.length % 4 !== 0) {
          normalized += "=";
        }
        return toUint8Array(Buffer.from(normalized, "base64"));
      },
      utf8(s) {
        return toUint8Array(Buffer.from(String(s), "utf8"));
      },
      fromUtf8(b) {
        return toBuffer(b).toString("utf8");
      },
      gunzip(b) {
        return toUint8Array(
          zlib.gunzipSync(toBuffer(b), { maxOutputLength: MAX_DECOMPRESS_BYTES })
        );
      },
      inflate(b, raw = false) {
        const fn = raw ? zlib.inflateRawSync : zlib.inflateSync;
        return toUint8Array(fn(toBuffer(b), { maxOutputLength: MAX_DECOMPRESS_BYTES }));
      },
    },

    device() {
      return { ...deviceInfo };
    },

    error(code, message, extra) {
      const err = new Error(message || code);
      err.code = code;
      if (extra && typeof extra.retryAfter === "number") {
        err.retryAfter = extra.retryAfter;
      }
      return err;
    },
  };

  return host;
}

export function installHost(options) {
  const host = createHost(options);
  globalThis.host = host;
  return host;
}
