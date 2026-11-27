// Business error code classification (ported from openhongguo internal/protocol/codes.go & parse.go).
import { parseJSONSafe } from "./json.js";

export const ErrorKind = Object.freeze({
  Unknown: "unknown",
  Auth: "auth",
  RateLimited: "rate_limited",
  ContentGone: "content_gone",
  Param: "param",
  Challenge: "challenge",
  ClientRejected: "client_rejected",
  DeviceRejected: "device_rejected",
  EndOfList: "end_of_list",
});

const CODE_NAMES = {
  0: "SUCCESS",
  100: "FAST_REJECT",
  101: "ALL_CONTENT_SHOWN",
  110: "ILLEGAL_ACCESS",
  111: "HIT_VERIFY_CODE",
  112: "APP_REJECT",
  4000: "PARAM_INVALID",
  4001: "USER_NOT_LOGIN",
  7001: "MAKE_ORDER_NO_ERROR",
  100103: "PARAM_INVALID",
  101009: "USER_NO_PERMISSION",
  101101: "REQ_ID_GET_ERROR",
  101102: "OUT_OF_MAX_LIMIT_ERROR",
  101103: "DIRECTORY_GET_ERROR",
  101104: "BOOK_NOT_EXIST_ERROR",
  101105: "BOOKSHELF_ADD_ERROR",
  101106: "BOOKSHELF_CHECK_ERROR",
  101107: "BOOKSHELF_DELETE_ERROR",
  101108: "USER_NOT_LOGIN",
  101109: "BOOK_REMOVE",
  101110: "READ_HISTORY_UPLOAD_ERROR",
  101111: "READ_HISTORY_DELETE_ERROR",
  101112: "READ_HISTORY_GET_ERROR",
  101113: "CHAPTER_INFO_GET_ERROR",
  101114: "PACK_SERVICE_ERROR",
  101115: "PERMISSION_NOT_SATISFIED",
  101116: "SERVICE_ERROR",
  101117: "ERR_ARTICLE_SERVICE_ERROR",
  101118: "BOOKSHELF_ADD_TOO_MUCH",
  101119: "BOOKSHELF_GET_ERROR",
  101120: "BOOKLIST_NAME_DUPLICATE",
  101121: "BOOK_FULLLY_REMOVE",
  101122: "SHARE_CODE_NOT_VALID",
  101123: "NOT_AUTHORIZED",
  101124: "SSTIMOR_EMPTY_ERROR",
  101130: "BOOKSHELF_TOPPING_DATA_EXPIRE",
  101131: "TRANSFER_LINE_POSITION_ERROR",
  101132: "PANIC",
  101133: "ITEM_UNLOCK_SET_ERROR",
  101134: "BOOKSHELF_ASTERISK_ERROR",
  101135: "SMART_PLAYER_SERVICE_ERROR",
  101136: "PLAY_URL_OUTTIME",
  101137: "CONTENT_VERIFYING",
  101138: "TOO_MANY_STREAM_TASK",
  101139: "NO_THIS_TONE",
  101140: "QUERY_CHAPTER_LOCK_ERROR",
  101141: "VIDEO_NO_PERMISSION",
  101142: "USER_INPUT_INVALID",
  101143: "FREQUENCY_BLOCK",
  101144: "HIT_SHARK_RULE",
  101145: "BOOK_NOT_EXIST_OVERSEA",
  101146: "ABASE_READ_FAIL",
  101147: "ABASE_WRITE_FAIL",
  101148: "UPLOAD_EMPTY_FILE",
  101149: "PARSE_FILE_ERROR",
};

const CONTENT_GONE_CODES = new Set([
  101101, 101102, 101103, 101104, 101105, 101106, 101107, 101109, 101110, 101111, 101112,
  101113, 101114, 101115, 101116, 101117, 101118, 101119, 101120, 101121, 101122, 101124,
  101130, 101131, 101132, 101133, 101134, 101135, 101136, 101137, 101138, 101139, 101140,
  101141, 101145, 101146, 101147, 101148, 101149,
]);

export function codeName(code) {
  return CODE_NAMES[code] || "";
}

export function classifyCode(code, message = "") {
  if (code === 0) return ErrorKind.Unknown;
  if (code === 101) return ErrorKind.EndOfList;
  if (code === 100 || code === 101143 || code === 101144 || code === 1000003) {
    return ErrorKind.RateLimited;
  }
  if (code === 101108 || code === 101123 || code === 4001 || code === 101009) {
    return ErrorKind.Auth;
  }
  if (code === 100103 || code === 4000 || code === 101142 || code === 110) {
    return ErrorKind.Param;
  }
  if (code === 111) return ErrorKind.Challenge;
  if (code === 112) return ErrorKind.ClientRejected;
  if (CONTENT_GONE_CODES.has(code) || (code >= 101000 && code < 101200)) {
    return ErrorKind.ContentGone;
  }
  const trimmed = String(message || "").trim().toLowerCase();
  if (!trimmed || trimmed === "success") return ErrorKind.Unknown;
  for (const kw of ["登录", "login", "sign in"]) {
    if (trimmed.includes(kw)) return ErrorKind.Auth;
  }
  for (const kw of ["频繁", "限流", "too many", "frequent", "rate limit"]) {
    if (trimmed.includes(kw)) return ErrorKind.RateLimited;
  }
  for (const kw of ["下架", "不存在", "已删除", "removed", "not exist", "unavailable"]) {
    if (trimmed.includes(kw)) return ErrorKind.ContentGone;
  }
  return ErrorKind.Unknown;
}

export function banWindow(message) {
  const s = String(message || "").trim();
  if (!s.startsWith("{")) return null;
  try {
    const parsed = parseJSONSafe(s);
    const minWait = Number(parsed.minBanTime) || 0;
    const maxWait = Number(parsed.maxBanTime) || 0;
    if (minWait <= 0 && maxWait <= 0) return null;
    return { minWaitSec: minWait, maxWaitSec: maxWait };
  } catch {
    return null;
  }
}

export function businessCode(obj) {
  if (!obj || typeof obj !== "object" || !("code" in obj) || obj.code === undefined) {
    return null;
  }
  const code = obj.code === null ? "" : String(obj.code).trim();
  const message = typeof obj.message === "string" ? obj.message : "";
  return { code, message };
}

export function authCode(code, message = "") {
  if (code === "auth_required" || code === "401" || code === "403") return true;
  const n = Number(code);
  if (Number.isInteger(n) && (n === 401 || n === 403)) return true;
  const lower = String(message || "").toLowerCase();
  return (
    String(message || "").includes("登录") ||
    lower.includes("login required") ||
    lower.includes("authentication required")
  );
}

export function baseStatus(obj) {
  const status = obj?.BaseResp?.StatusCode;
  if (status === undefined || status === null) return 0;
  const n = Number(status);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function deviceRejected(status) {
  return status === 263175 || status === 263176;
}
