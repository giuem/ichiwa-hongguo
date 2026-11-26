// Ordered query parameter pairs and JSON request body builders
// (ported from openhongguo internal/protocol/request.go, playback_v5.go & danmaku.go).
import { gzipEncode, utf8Bytes } from "../crypto/bytes.js";
import {
  AID,
  APP_NAME,
  DANMAKU_FALLBACK_DURATION,
  DANMAKU_PAGE_SIZE,
  DEVICE_PLATFORM,
  PLAN_FROM_SERIES_SEASONS,
  PLAYBACK_VERSION_CODE,
  PLAYBACK_VERSION_NAME,
  SEARCH_SOURCE_HOME,
  SEARCH_TAB_NAME,
  SEARCH_TAB_SHORT_PLAY,
  SHORT_RANK_ACTORS,
  SHORT_RANK_CELL,
  VERSION_CODE,
  VERSION_NAME,
  deviceOrDefault,
} from "./app.js";

export const SHORT_FILTER_KEYS = [
  "category_dim_epoch",
  "online_time",
  "gender",
  "category_dim_role",
  "genre",
  "creation_status",
  "sort",
  "category_dim_theme",
];

function marshalSorted(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(marshalSorted).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + marshalSorted(value[k])).join(",") + "}";
}

function jsonBytes(obj) {
  return utf8Bytes(marshalSorted(obj));
}

export function readingRequestID(unixMillis, randomInt) {
  const n = Math.abs(Math.trunc(randomInt));
  return `${Math.trunc(unixMillis)}-${n}`;
}

export function deviceQueryPairs(id) {
  const d = deviceOrDefault(id.device);
  const kind = d.pad ? "pad" : "phone";
  const pad = d.pad ? "1" : "0";
  return [
    ["iid", id.installId],
    ["device_id", id.deviceId],
    ["ac", "wifi"],
    ["channel", d.channel],
    ["aid", AID],
    ["app_name", APP_NAME],
    ["cdid", id.cdid],
    ["version_code", VERSION_CODE],
    ["version_name", VERSION_NAME],
    ["device_platform", DEVICE_PLATFORM],
    ["os", "android"],
    ["ssmix", "a"],
    ["device_type", d.model],
    ["device_brand", d.brand],
    ["language", "zh"],
    ["os_api", String(d.os_api)],
    ["os_version", d.os_version],
    ["manifest_version_code", VERSION_CODE],
    ["resolution", d.resolution],
    ["dpi", String(d.dpi)],
    ["update_version_code", VERSION_CODE],
    ["host_abi", "arm64-v8a"],
    ["dragon_device_type", kind],
    ["pv_player", VERSION_CODE],
    ["compliance_status", "0"],
    ["need_personal_recommend", "1"],
    ["player_so_load", "1"],
    ["is_android_pad_screen", pad],
    ["openudid", id.openudid],
  ];
}

export function playbackV5Pairs(id) {
  const d = deviceOrDefault(id.device);
  const kind = d.pad ? "pad" : "phone";
  const pad = d.pad ? "1" : "0";
  const version = String(PLAYBACK_VERSION_CODE);
  return [
    ["device_platform", DEVICE_PLATFORM],
    ["os", "android"],
    ["ssmix", "a"],
    ["_rticket", ""],
    ["cdid", id.cdid],
    ["channel", d.channel],
    ["aid", AID],
    ["app_name", APP_NAME],
    ["version_code", version],
    ["version_name", PLAYBACK_VERSION_NAME],
    ["manifest_version_code", version],
    ["update_version_code", version],
    ["resolution", d.resolution],
    ["dpi", String(d.dpi)],
    ["device_type", d.model],
    ["device_brand", d.brand],
    ["language", "zh"],
    ["os_api", String(d.os_api)],
    ["os_version", d.os_version],
    ["ac", "wifi"],
    ["host_abi", "arm64-v8a"],
    ["dragon_device_type", kind],
    ["pv_player", version],
    ["compliance_status", "0"],
    ["need_personal_recommend", "1"],
    ["player_so_load", "1"],
    ["is_android_pad_screen", pad],
    ["iid", id.installId],
    ["device_id", id.deviceId],
  ];
}

export function signedDiscoverPairsIn(id, tabType = "-1", bottom = "7") {
  return [
    ...deviceQueryPairs(id),
    ["tab_type", tabType || "-1"],
    ["offset", "0"],
    ["client_req_type", "3"],
    ["bottom_tab_type", bottom || "7"],
    ["bottom_tab_type_list", "7,0,1,2,3,4"],
  ];
}

export function signedCellChangePairs(id, next) {
  const pairs = [
    ...deviceQueryPairs(id),
    ["cell_id", next.cellId],
    ["offset", next.offset || "0"],
    ["limit", "20"],
    ["change_type", "0"],
    ["tab_type", next.tabType],
    ["show_type", next.showType],
    ["client_req_type", "2"],
    ["session_id", next.sessionId],
  ];
  if (next.clientTemplate) {
    pairs.push(["client_template", next.clientTemplate]);
  }
  return pairs;
}

export function signedSearchPairsFor(
  id,
  keyword,
  count = 20,
  offset = 0,
  tab = SEARCH_TAB_SHORT_PLAY
) {
  return [
    ...deviceQueryPairs(id),
    ["query", keyword],
    ["tab_type", tab || SEARCH_TAB_SHORT_PLAY],
    ["count", String(count > 0 ? count : 20)],
    ["offset", String(offset >= 0 ? offset : 0)],
    ["use_correct", "true"],
    ["bookshelf_search_plan", "4"],
    ["search_source", SEARCH_SOURCE_HOME],
    ["tab_name", SEARCH_TAB_NAME],
    ["bookstore_tab", "16"],
    ["user_is_login", "0"],
  ];
}

export function signedSuggestPairs(id, keyword) {
  return [
    ...deviceQueryPairs(id),
    ["q", keyword],
    ["count", "10"],
    ["search_source", SEARCH_SOURCE_HOME],
    ["user_is_login", "0"],
  ];
}

export function signedShortRankPairs(id, content, list, cur) {
  const change = cur.offset > 0 ? "2" : "1";
  const pairs = [
    ...deviceQueryPairs(id),
    ["cell_id", SHORT_RANK_CELL],
    ["tab_type", "26"],
    ["selected_items", content],
  ];
  if (list) {
    pairs.push(["sub_selected_items", list]);
  }
  pairs.push(
    ["offset", String(cur.offset || 0)],
    ["limit", "0"],
    ["client_req_type", "2"],
    ["client_template", "2"],
    ["unlimited_selector_change_type", change]
  );
  if (cur.seen && cur.seen.length > 0 && content !== SHORT_RANK_ACTORS) {
    pairs.push(["filter_ids", cur.seen.join(",")]);
  }
  if (cur.session) {
    pairs.push(["session_id", cur.session]);
  }
  pairs.push(["user_is_login", "0"]);
  return pairs;
}

export function signedPlanPairs(id, bookID, sessionUUID) {
  return signedPlanPairsFrom(id, "select_panel_recommend", bookID, sessionUUID);
}

export function signedPlanPairsFrom(id, from, bookID, sessionUUID) {
  return [
    ...deviceQueryPairs(id),
    ["book_id", bookID],
    ["from", from],
    ["scene", "10"],
    ["session_uuid", sessionUUID],
    ["user_is_login", "0"],
  ];
}

export function signedSeasonPairs(id, seriesID, sessionUUID) {
  return [
    ...signedPlanPairsFrom(id, PLAN_FROM_SERIES_SEASONS, seriesID, sessionUUID),
    ["filter_ids", seriesID],
  ];
}

export function signedHotSearchPairs(id) {
  return [
    ...deviceQueryPairs(id),
    ["user_is_login", "0"],
    ["bookstore_tab", "16"],
    ["bookstore_tab_type", "16"],
    ["scene", "10"],
    ["limit", "0"],
    ["tab_name", SEARCH_TAB_NAME],
    ["from", "search_input_page"],
    ["query_history_removed", "false"],
    ["offset", "0"],
    ["search_middle_page_version", "4"],
    ["search_source", SEARCH_SOURCE_HOME],
    ["new_search_middle_page", "true"],
    ["hot_word_exchange", "false"],
  ];
}

export function signedNewReleasePairs(id, date, cur) {
  const pairs = [
    ...deviceQueryPairs(id),
    ["order_experiment", "descend"],
    ["offset", String(cur.offset || 0)],
  ];
  if (date) {
    pairs.push(["target_date", date]);
  }
  pairs.push(
    ["active_panel", "5"],
    ["session_id", cur.session || ""],
    ["version", "0"],
    ["gender_type", "2"],
    ["tab_type", "5"],
    ["filter_type", "gender"],
    ["subscribe_list_opt", "0"],
    ["tab_style", "2"],
    ["need_calendar_schema", "true"],
    ["user_is_login", "0"]
  );
  return pairs;
}

export function signedProfilePairs(id, userID) {
  return [...deviceQueryPairs(id), ["user_id", userID], ["user_is_login", "0"]];
}

export function seriesBody(seriesID) {
  return jsonBytes({
    biz_param: {
      caller_scene: "single_col",
      detail_page_version: 0,
      from_video_id: "",
      need_all_video_definition: false,
      need_mp4_align: false,
      source: 4,
      video_id_type: 1,
    },
    series_id: seriesID,
  });
}

export function seriesBatchBody(seriesIDs) {
  return jsonBytes({
    biz_param: {
      detail_page_version: 0,
      need_all_video_definition: false,
      need_mp4_align: false,
      source: 7,
      use_os_player: false,
      use_server_dns: false,
    },
    dr_scene: "player",
    series_id: seriesIDs.join(","),
  });
}

export function albumBody(albumID) {
  return jsonBytes({
    album_id: albumID,
    biz_param: { video_platform: 3 },
    need_video_detail_info: true,
    series_ids: [],
  });
}

export function playbackBody(episodeID) {
  return jsonBytes({
    biz_param: {
      need_all_video_definition: true,
      video_id_type: 0,
      video_platform: 3,
    },
    video_id: episodeID,
  });
}

export function playbackV5PlainBody(episodeID) {
  return jsonBytes({
    biz_param: {
      detail_page_version: 0,
      device_level: 1,
      disable_digg_stat: false,
      disable_video_relate_book: false,
      need_all_video_definition: true,
      need_mp4_align: false,
      use_os_player: false,
      use_server_dns: false,
      video_platform: 1024,
    },
    dr_scene: "player",
    mixed_video_id_map: { 1004: [episodeID] },
  });
}

export function playbackV5Body(episodeID) {
  return gzipEncode(playbackV5PlainBody(episodeID), 0);
}

export function shortFilterBody(scene, selections, panel, cur) {
  if (panel) {
    return jsonBytes({
      need_selector_panel: false,
      req_scene: scene,
      req_type: "only_panel",
    });
  }
  const items = {};
  for (const k of SHORT_FILTER_KEYS) {
    const vals = selections && Array.isArray(selections[k]) ? [...selections[k]] : [];
    items[k] = vals;
  }
  return jsonBytes({
    filter_ids: (cur.seen || []).join(","),
    limit: 18,
    need_selector_panel: false,
    offset: cur.offset || 0,
    req_scene: scene,
    req_type: "only_content",
    select_items: items,
    session_id: cur.session || "",
  });
}

export function userWorksTabsBody(userID) {
  return jsonBytes({
    aid: 8662,
    comment_source: 1506,
    extra_param: { enter_source: "12" },
    locate_album_id: "",
    sort: "time_desc",
    target_user_id: userID,
  });
}

export function userWorksBody(userID, cursor, tab) {
  return jsonBytes({
    comment_source: 1506,
    count: 18,
    cursor: cursor || "",
    extra_param: { is_video_tab_comment: "1" },
    locate_post_id: "",
    profile_user_type: 0,
    sort: "time_desc",
    sub_tab_type: tab.sub,
    tab_type: tab.tab,
    target_user_id: userID,
  });
}

export function danmakuBody(seriesID, episodeID, startMS, durationMS, count, cursor) {
  const c = count > 0 ? count : DANMAKU_PAGE_SIZE;
  const dur = durationMS > 0 ? durationMS : DANMAKU_FALLBACK_DURATION;
  return jsonBytes({
    aid: Number(AID),
    business_param: {
      book_id: seriesID,
      need_danmaku_guide_type: [1, 3, 4, 2],
      playlet_item_duration: dur,
      start_offset_time: startMS,
    },
    comment_source: 601,
    comment_type: 20,
    compliance_status: 0,
    count: c,
    cursor: cursor || "",
    group_id: episodeID,
    group_type: 30,
    server_channel: 1000,
    sort: 1,
  });
}
