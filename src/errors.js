// Internal SDK errors and mapping to Ichiwa plugin host.error() codes
// (ported from openhongguo sdk/errors.go; protocol: plugin-design.md §10).
import { ErrorKind, banWindow } from "./protocol/codes.js";

export const ErrCode = Object.freeze({
  InvalidOptions: "invalid_options",
  AuthRequired: "auth_required",
  DRMProtected: "drm_protected",
  NotProtected: "not_protected",
  AnonymousLimited: "anonymous_limited",
  RateLimited: "rate_limited",
  Transport: "transport",
  SignatureRejected: "signature_rejected",
  ContentUnavailable: "content_unavailable",
  ParamInvalid: "param_invalid",
  ChallengeRequired: "challenge_required",
  DeviceRejected: "device_rejected",
  EndOfList: "end_of_list",
  APIError: "api_error",
  CodeError: "code_error",
});

export class HongguoError extends Error {
  constructor(kind, message, extra = {}) {
    super(message || kind);
    this.name = "HongguoError";
    this.kind = kind;
    this.httpStatus = extra.httpStatus || 0;
    this.bizCode = extra.bizCode || 0;
    this.bizName = extra.bizName || "";
    this.bizKind = extra.bizKind || "";
    this.bizMessage = extra.bizMessage || "";
    this.retryAfter = extra.retryAfter || 0;
    this.invalidId = !!extra.invalidId;
  }
}

export function isErr(err, kind) {
  if (!err) return false;
  if (err instanceof HongguoError) {
    if (err.kind === kind) return true;
    if (err.kind === ErrCode.APIError) {
      if (kind === ErrCode.RateLimited) return err.httpStatus === 429;
      if (kind === ErrCode.AuthRequired) return err.httpStatus === 401 || err.httpStatus === 403;
    }
    if (err.kind === ErrCode.CodeError) {
      if (kind === ErrCode.AuthRequired) return err.bizKind === ErrorKind.Auth;
      if (kind === ErrCode.RateLimited) return err.bizKind === ErrorKind.RateLimited;
      if (kind === ErrCode.ContentUnavailable) return err.bizKind === ErrorKind.ContentGone;
      if (kind === ErrCode.ParamInvalid) return err.bizKind === ErrorKind.Param;
      if (kind === ErrCode.ChallengeRequired) return err.bizKind === ErrorKind.Challenge;
      if (kind === ErrCode.DeviceRejected) return err.bizKind === ErrorKind.DeviceRejected;
      if (kind === ErrCode.EndOfList) return err.bizKind === ErrorKind.EndOfList;
    }
  }
  return false;
}

export function isRetryable(err) {
  if (!err) return false;
  if (isErr(err, ErrCode.RateLimited) || isErr(err, ErrCode.Transport)) return true;
  if (err instanceof HongguoError && err.kind === ErrCode.APIError) {
    return err.httpStatus === 0 || err.httpStatus >= 500;
  }
  return false;
}

export function retryAfterSeconds(err, fallbackSec) {
  if (err instanceof HongguoError && err.bizMessage) {
    const bw = banWindow(err.bizMessage);
    if (bw) {
      if (bw.maxWaitSec > bw.minWaitSec && bw.minWaitSec > 0) {
        return bw.minWaitSec + (bw.maxWaitSec - bw.minWaitSec) / 2;
      }
      return bw.maxWaitSec;
    }
  }
  if (err instanceof HongguoError && err.retryAfter > 0) {
    return err.retryAfter;
  }
  return fallbackSec;
}

function logInternalError(err, context) {
  const parts = [];
  if (context) parts.push(`op=${context}`);
  if (err instanceof HongguoError) {
    parts.push(`kind=${err.kind}`);
    if (err.httpStatus) parts.push(`http=${err.httpStatus}`);
    if (err.bizCode) parts.push(`bizCode=${err.bizCode}`);
    if (err.bizName) parts.push(`bizName=${err.bizName}`);
    if (err.bizKind) parts.push(`bizKind=${err.bizKind}`);
    if (err.bizMessage) parts.push(`bizMsg=${err.bizMessage}`);
  }
  if (err?.message) parts.push(`msg=${err.message}`);
  console.log(`[hongguo] error: ${parts.join(" ") || String(err)}`);
}

const NOT_FOUND_MESSAGES = {
  media: "找不到这部剧",
  play: "找不到这一集",
  danmaku: "找不到这一集",
  collection: "找不到这个页面",
};

export function toHostError(err, context = "") {
  if (
    err &&
    typeof err.code === "string" &&
    ["unavailable", "rateLimited", "notFound", "network", "plugin"].includes(err.code)
  ) {
    return err;
  }
  logInternalError(err, context);

  if (isErr(err, ErrCode.AuthRequired)) {
    return host.error("unavailable", "该内容需要登录才能观看");
  }
  if (isErr(err, ErrCode.AnonymousLimited)) {
    return host.error("unavailable", "服务端暂时限制了匿名访问，请稍后再试", { retryAfter: 30 });
  }
  if (isErr(err, ErrCode.RateLimited)) {
    const wait = Math.ceil(retryAfterSeconds(err, 30));
    return host.error("rateLimited", "请求太频繁，请稍后再试", { retryAfter: Math.max(wait, 1) });
  }
  if (isErr(err, ErrCode.ChallengeRequired)) {
    return host.error("rateLimited", "触发平台验证，请稍后再试", { retryAfter: 60 });
  }
  // notFound only on evidence that the ID itself does not exist: an ID that
  // is not a Hongguo ID at all, or BOOK_NOT_EXIST_ERROR (101104) on a media
  // lookup. The server answers most unknown IDs with the broad 101000, which
  // also covers takedowns and temporary failures, so that stays unavailable.
  if (isErr(err, ErrCode.InvalidOptions) && err.invalidId && NOT_FOUND_MESSAGES[context]) {
    return host.error("notFound", NOT_FOUND_MESSAGES[context]);
  }
  if (isErr(err, ErrCode.ContentUnavailable)) {
    const bizCode = err instanceof HongguoError ? err.bizCode : 0;
    if (context === "media" && bizCode === 101104) {
      return host.error("notFound", "这部剧不存在或已下架");
    }
    return host.error("unavailable", "该内容已下架或暂不可用");
  }
  if (isErr(err, ErrCode.Transport)) {
    return host.error("network", "网络连接失败，请检查网络后重试");
  }
  return host.error("plugin", "红果片源暂时出错，请稍后重试");
}
