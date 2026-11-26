// Internal SDK errors and mapping to Ichiwa plugin host.error() codes (plugin-design.md §10).
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

export function toHostError(err, context = "") {
  if (err && typeof err.code === "string" && ["unavailable", "rateLimited", "notFound", "network", "plugin"].includes(err.code)) {
    return err;
  }
  if (isErr(err, ErrCode.AuthRequired)) {
    return host.error("unavailable", "该内容需要登录才能观看");
  }
  if (isErr(err, ErrCode.AnonymousLimited)) {
    return host.error("unavailable", "服务端暂时限制了匿名访问，请稍后再试");
  }
  if (isErr(err, ErrCode.RateLimited)) {
    const wait = Math.ceil(retryAfterSeconds(err, 30));
    return host.error("rateLimited", "请求太频繁，请稍后再试", { retryAfter: Math.max(wait, 1) });
  }
  if (isErr(err, ErrCode.ChallengeRequired)) {
    return host.error("rateLimited", "触发平台验证，请稍后再试", { retryAfter: 60 });
  }
  if (isErr(err, ErrCode.ContentUnavailable)) {
    const bizCode = err instanceof HongguoError ? err.bizCode : 0;
    if (context === "media" && (bizCode === 101104 || bizCode === 101145)) {
      return host.error("notFound", "该作品不存在或已下架");
    }
    return host.error("unavailable", "该内容已下架或暂不可用");
  }
  if (isErr(err, ErrCode.Transport)) {
    return host.error("network", "网络连接失败，请检查网络后重试");
  }
  return host.error("plugin", err?.message ? `红果片源出错：${err.message}` : "红果片源出错");
}
