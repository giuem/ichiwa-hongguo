// Anonymous device registration request/response (ported from openhongguo internal/protocol/register.go).
import { gzipEncode, utf8Bytes } from "../crypto/bytes.js";
import { ttEncrypt } from "../crypto/tt_encrypt.js";
import { DEVICE_PLATFORM, PACKAGE, VERSION_NAME, deviceOrDefault } from "./app.js";

const BOOTSTRAP_HEADER_ORDER = [
  "display_name", "update_version_code", "manifest_version_code", "app_version_minor",
  "aid", "channel", "package", "app_version", "version_code", "os", "os_version", "os_api",
  "device_model", "device_brand", "device_manufacturer", "cpu_abi", "language", "timezone",
  "access", "region", "tz_name", "tz_offset", "cdid", "openudid", "clientudid", "ipv6_list",
  "sim_serial_number", "oaid", "oaid_may_support", "req_id", "device_platform", "guest_mode",
  "is_system_app", "sdk_flavor", "device_id", "install_id",
];

// Go's json.Marshal sorts map keys alphabetically.
function marshalSortedJSON(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(marshalSortedJSON).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + marshalSortedJSON(value[k])).join(",") + "}";
}

function marshalOrdered(values, preferred) {
  const keys = [];
  const seen = new Set();
  for (const k of preferred) {
    if (Object.prototype.hasOwnProperty.call(values, k)) {
      keys.push(k);
      seen.add(k);
    }
  }
  const rest = Object.keys(values).filter((k) => !seen.has(k)).sort();
  keys.push(...rest);
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + marshalSortedJSON(values[k])).join(",") + "}";
}

export function buildBootstrapOAID(id, issuedAtMs) {
  return {
    hw_id_version_code: "0",
    id,
    is_track_limited: "false",
    query_times: "1",
    req_id: id,
    take_ms: "6",
    time: String(Math.trunc(issuedAtMs)),
  };
}

export function registerHeader(profile, nowMs) {
  const d = deviceOrDefault(profile.device);
  return {
    display_name: "红果免费短剧",
    update_version_code: 73932,
    manifest_version_code: 73932,
    app_version_minor: VERSION_NAME,
    aid: 8662,
    channel: d.channel,
    package: PACKAGE,
    app_version: VERSION_NAME,
    version_code: 73932,
    os: "Android",
    os_version: d.os_version,
    os_api: d.os_api,
    device_model: d.model,
    device_brand: d.brand,
    device_manufacturer: d.brand,
    cpu_abi: "arm64-v8a",
    language: "zh",
    timezone: 8,
    access: "wifi",
    region: "CN",
    tz_name: "Asia/Shanghai",
    tz_offset: 28800,
    cdid: profile.cdid,
    openudid: profile.openudid,
    clientudid: profile.clientudid,
    ipv6_list: [],
    sim_serial_number: [],
    oaid: buildBootstrapOAID(profile.oaid, nowMs - 200),
    oaid_may_support: true,
    req_id: profile.req_id,
    device_platform: DEVICE_PLATFORM,
    guest_mode: 0,
    is_system_app: 0,
    sdk_flavor: "china",
    device_id: "0",
    install_id: "0",
  };
}

export function buildBootstrapPlaintext(header, generatedAtMs) {
  const copy = { ...header };
  if (copy.ipv6_list == null) copy.ipv6_list = [];
  if (copy.sim_serial_number == null) copy.sim_serial_number = [];
  const headerJSON = marshalOrdered(copy, BOOTSTRAP_HEADER_ORDER);
  return utf8Bytes(
    `{"magic_tag":"ss_app_log","header":${headerJSON},"_gen_time":${Math.trunc(generatedAtMs)}}`
  );
}

export function buildRegisterBody(profile, generatedAtMs) {
  const plain = buildBootstrapPlaintext(registerHeader(profile, generatedAtMs), generatedAtMs);
  const gz = gzipEncode(plain, Math.trunc(generatedAtMs / 1000));
  return ttEncrypt(gz);
}

export function contentMD5(body) {
  return host.crypto.md5(body).toUpperCase();
}

export function parseRegister(obj) {
  const deviceId = String(obj?.device_id_str ?? "").trim();
  const installId = String(obj?.install_id_str ?? "").trim();
  if (!deviceId || deviceId === "0" || !installId || installId === "0") {
    throw new Error("anonymous registration returned no guest identity");
  }
  return {
    deviceId,
    installId,
    newUser: Number(obj?.new_user) || 0,
  };
}
