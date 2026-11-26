// Opaque pagination cursor encoders/decoders (ported from openhongguo internal/protocol/cursor.go & danmaku.go).
import { base64UrlDecode, base64UrlEncode, fromUtf8, utf8Bytes } from "../crypto/bytes.js";

export function isDigits(s) {
  return typeof s === "string" && s.length > 0 && s.length <= 25 && /^[0-9]+$/.test(s);
}

export function validDate(s) {
  if (typeof s !== "string" || s.length !== 8 || !/^[0-9]{8}$/.test(s)) {
    return false;
  }
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function encodeFeedCursor(next) {
  const offset = Number.parseInt(String(next.offset || ""), 10);
  if (
    !Number.isInteger(offset) ||
    offset <= 0 ||
    !next.cellId ||
    !next.sessionId ||
    !next.tabType ||
    !next.showType
  ) {
    throw new Error("discover cursor is not verified");
  }
  const obj = {
    cell: next.cellId,
    session: next.sessionId,
    show: next.showType,
    tab: next.tabType,
    offset,
  };
  if (next.clientTemplate) {
    obj.template = next.clientTemplate;
  }
  return "d1." + base64UrlEncode(utf8Bytes(JSON.stringify(obj)));
}

export function decodeFeedCursor(token) {
  if (typeof token !== "string" || !token.startsWith("d1.") || token.length <= 3) {
    throw new Error("discover cursor is not verified");
  }
  let cur;
  try {
    cur = JSON.parse(fromUtf8(base64UrlDecode(token.slice(3))));
  } catch {
    throw new Error("discover cursor is not verified");
  }
  if (
    !cur ||
    !Number.isInteger(cur.offset) ||
    cur.offset <= 0 ||
    !isDigits(cur.cell) ||
    !isDigits(cur.tab) ||
    !isDigits(cur.show) ||
    !cur.session ||
    /[\r\n]/.test(cur.session)
  ) {
    throw new Error("discover cursor is not verified");
  }
  return {
    cellId: cur.cell,
    sessionId: cur.session,
    clientTemplate: cur.template || "",
    showType: cur.show,
    tabType: cur.tab,
    offset: String(cur.offset),
  };
}

export function encodeShortCursor(c) {
  const obj = { o: c.offset || 0 };
  if (c.seen && c.seen.length > 0) obj.s = c.seen;
  if (c.session) obj.x = c.session;
  if (c.selections && Object.keys(c.selections).length > 0) obj.q = c.selections;
  if (c.content) obj.c = c.content;
  if (c.board) obj.b = c.board;
  if (c.date) obj.d = c.date;
  return "s1." + base64UrlEncode(utf8Bytes(JSON.stringify(obj)));
}

export function decodeShortCursor(token) {
  if (!token) {
    return { offset: 0, seen: [], session: "", selections: null, content: "", board: "", date: "" };
  }
  if (typeof token !== "string" || !token.startsWith("s1.")) {
    throw new Error("short-drama cursor is not valid");
  }
  let c;
  try {
    c = JSON.parse(fromUtf8(base64UrlDecode(token.slice(3))));
  } catch {
    throw new Error("short-drama cursor is not valid");
  }
  if (
    !c ||
    typeof c.o !== "number" ||
    c.o < 0 ||
    (c.x && /[\r\n]/.test(c.x)) ||
    (c.d && !validDate(c.d))
  ) {
    throw new Error("short-drama cursor is not valid");
  }
  const seen = Array.isArray(c.s) ? c.s : [];
  for (const id of seen) {
    if (!isDigits(id)) {
      throw new Error("short-drama cursor is not valid");
    }
  }
  return {
    offset: Math.trunc(c.o),
    seen,
    session: c.x || "",
    selections: c.q || null,
    content: c.c || "",
    board: c.b || "",
    date: c.d || "",
  };
}

export function encodeWorksCursor(c) {
  const obj = { u: c.userId, n: c.next };
  if (c.tab) obj.w = { t: c.tab.tab, s: c.tab.sub };
  return "w1." + base64UrlEncode(utf8Bytes(JSON.stringify(obj)));
}

export function decodeWorksCursor(token) {
  if (!token) {
    return { userId: "", next: "", tab: null };
  }
  if (typeof token !== "string" || !token.startsWith("w1.")) {
    throw new Error("works cursor is not valid");
  }
  let c;
  try {
    c = JSON.parse(fromUtf8(base64UrlDecode(token.slice(3))));
  } catch {
    throw new Error("works cursor is not valid");
  }
  if (!c || !isDigits(c.u) || !c.n) {
    throw new Error("works cursor is not valid");
  }
  return {
    userId: c.u,
    next: c.n,
    tab: c.w ? { tab: c.w.t, sub: c.w.s } : null,
  };
}

export function encodeDanmakuCursor(c) {
  const obj = { e: c.episodeId, d: c.duration, t: c.start };
  if (c.next) obj.n = c.next;
  return "m1." + base64UrlEncode(utf8Bytes(JSON.stringify(obj)));
}

export function decodeDanmakuCursor(token) {
  if (!token) {
    return { episodeId: "", duration: 0, start: 0, next: "" };
  }
  if (typeof token !== "string" || !token.startsWith("m1.")) {
    throw new Error("danmaku cursor is not valid");
  }
  let c;
  try {
    c = JSON.parse(fromUtf8(base64UrlDecode(token.slice(3))));
  } catch {
    throw new Error("danmaku cursor is not valid");
  }
  if (!c || !isDigits(c.e) || !(c.t > 0) || !(c.d > 0)) {
    throw new Error("danmaku cursor is not valid");
  }
  return {
    episodeId: c.e,
    duration: Math.trunc(c.d),
    start: Math.trunc(c.t),
    next: c.n || "",
  };
}
