// Application constants and device defaults (ported from openhongguo internal/protocol/app.go, device.go & sdk/model/device.go).

export const PACKAGE = "com.phoenix.read";
export const VERSION_NAME = "7.3.9.32";
export const VERSION_CODE = "73932";
export const AID = "8662";
export const APP_NAME = "novelread";
export const DEVICE_PLATFORM = "android";

export const PLAYBACK_VERSION_CODE = 74332;
export const PLAYBACK_VERSION_NAME = "7.4.3.32";

export const API_HOST = "api5-normal-sinfonlinea.fqnovel.com";
export const REGISTER_HOST = "log5-applog-lq.fqnovel.com";
export const DISTRIBUTION_HOST = API_HOST;

export const DEFAULT_API_ORIGIN = `https://${API_HOST}`;
export const DEFAULT_REGISTER_ORIGIN = `https://${REGISTER_HOST}`;
export const DEFAULT_DISTRIBUTION_ORIGIN = `https://${DISTRIBUTION_HOST}`;

export const PATH_DISCOVER = "/reading/bookapi/bookmall/tab/v";
export const PATH_CELL_CHANGE = "/reading/bookapi/bookmall/cell/change/v";
export const PATH_SEARCH = "/reading/bookapi/search/tab/v";
export const PATH_SERIES = "/novel/player/video_detail/v1/";
export const PATH_SERIES_BATCH = "/novel/player/multi_video_detail/player/v1";
export const PATH_PLAYBACK = "/novel/player/video_model/v1/";
export const PATH_PLAYBACK_V5 = "/novel/player/multi_video_model/player/v1";
export const PATH_ALBUM = "/novel/player/album_detail/v1/";
export const PATH_SUGGEST = "/reading/bookapi/search/suggest/v1/";
export const PATH_CUE = "/reading/bookapi/search/cue/v1/";
export const PATH_PLAN = "/reading/bookapi/plan/v1/";
export const PATH_RANK_CELLS = "/reading/bookapi/bookmall/cell/change/v1/";
export const PATH_SUBSCRIBE_LIST = "/reading/user/subscribe/list/v1/";
export const PATH_PROFILE = "/reading/user/profile/get/v1/";
export const PATH_USER_WORKS = (userID) => `/novel/commentapi/user/profile/${userID}/v1`;
export const PATH_DANMAKU = (episodeID) => `/novel/commentapi/comment/list/${episodeID}/v1/`;
export const PATH_SHORT_FILTER = "/reading/distribution/category/landpage/v1/";
export const PATH_REGISTER = "/service/2/device_register/";

export const SHORT_RANK_CELL = "7470092475068071998";
export const SHORT_RANK_ACTORS = "ranklist_celebrity";
export const PLAN_FROM_SERIES_SEASONS = "single_col_same_ip_series";
export const SHOW_TYPE_DETAIL_RELATED_VIDEO = 160;
export const SHOW_TYPE_SERIES_SEASONS = 547;

export const SEARCH_TAB_SHORT_PLAY = "11";
export const SEARCH_TAB_SERIES_VIDEO = "29";
export const SEARCH_TAB_PUGC_VIDEO = "30";
export const SEARCH_TAB_DISCUSSION = "31";
export const SEARCH_TAB_COMMON = "1";
export const SEARCH_TAB_HG_USER = "27";
export const SEARCH_TAB_VOICE = "2";
export const SEARCH_SOURCE_HOME = "1";
export const SEARCH_TAB_NAME = "feed";

export const DANMAKU_PAGE_SIZE = 90;
export const DANMAKU_FALLBACK_DURATION = 60 * 60 * 1000;

export const DEFAULT_DEVICE = Object.freeze({
  brand: "Xiaomi",
  model: "23127PN0CC",
  os_version: "14",
  os_api: 34,
  build: "UKQ1.230804.001",
  resolution: "1200*2670",
  dpi: 460,
  pad: false,
  channel: "xiaomi_8662_64",
});

export function deviceOrDefault(d) {
  const src = d || {};
  return {
    brand: src.brand || DEFAULT_DEVICE.brand,
    model: src.model || DEFAULT_DEVICE.model,
    os_version: src.os_version || DEFAULT_DEVICE.os_version,
    os_api: src.os_api || DEFAULT_DEVICE.os_api,
    build: src.build || DEFAULT_DEVICE.build,
    resolution: src.resolution || DEFAULT_DEVICE.resolution,
    dpi: src.dpi || DEFAULT_DEVICE.dpi,
    pad: Boolean(src.pad),
    channel: src.channel || DEFAULT_DEVICE.channel,
  };
}

export function userAgent(device) {
  const d = deviceOrDefault(device);
  return `${PACKAGE}/${VERSION_CODE} (Linux; U; Android ${d.os_version}; zh_CN; ${d.model}; Build/${d.build}; Cronet/TTNetVersion:8d40f833 2026-03-03 QuicVersion:21ac1950 2025-11-18)`;
}

export function playbackUserAgent(device) {
  const d = deviceOrDefault(device);
  return `${PACKAGE}/${PLAYBACK_VERSION_CODE} (Linux; U; Android ${d.os_version}; zh_CN; ${d.model}; Build/${d.build}; Cronet/TTNetVersion:8d40f833 2026-03-03 QuicVersion:21ac1950 2025-11-18)`;
}

export const CREDENTIAL_HEADER_NAMES = ["authorization", "x-tt-token", "openid"];
