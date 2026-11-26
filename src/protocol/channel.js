// Channel and search tab resolution (ported from openhongguo internal/protocol/channel.go).
import {
  SEARCH_TAB_COMMON,
  SEARCH_TAB_DISCUSSION,
  SEARCH_TAB_HG_USER,
  SEARCH_TAB_PUGC_VIDEO,
  SEARCH_TAB_SERIES_VIDEO,
  SEARCH_TAB_SHORT_PLAY,
  SEARCH_TAB_VOICE,
} from "./app.js";

const DISCOVER_CHANNELS = {
  "": { name: "推荐", requestTab: "-1", responseTab: 16, bottomTab: "7" },
  推荐: { name: "推荐", requestTab: "-1", responseTab: 16, bottomTab: "7" },
  recommend: { name: "推荐", requestTab: "-1", responseTab: 16, bottomTab: "7" },
  漫剧: { name: "漫剧", requestTab: "36", responseTab: 36, bottomTab: "7" },
  motion: { name: "漫剧", requestTab: "36", responseTab: 36, bottomTab: "7" },
  comic: { name: "漫剧", requestTab: "36", responseTab: 36, bottomTab: "7" },
  真人剧: { name: "真人剧", requestTab: "39", responseTab: 39, bottomTab: "7" },
  live: { name: "真人剧", requestTab: "39", responseTab: 39, bottomTab: "7" },
  找剧: { name: "找剧", requestTab: "8", responseTab: 8, bottomTab: "0" },
  首页真人剧: { name: "首页真人剧", requestTab: "38", responseTab: 38, bottomTab: "0" },
  首页漫剧: { name: "首页漫剧", requestTab: "32", responseTab: 32, bottomTab: "0" },
  电影: { name: "电影", requestTab: "14", responseTab: 14, bottomTab: "0" },
  听书: { name: "听书", requestTab: "5", responseTab: 5, bottomTab: "0" },
  小说: { name: "小说", requestTab: "2", responseTab: 2, bottomTab: "0" },
  社区: { name: "社区", requestTab: "33", responseTab: 33, bottomTab: "10" },
  漫画: { name: "漫画", requestTab: "9", responseTab: 9, bottomTab: "0" },
  大视听: { name: "大视听", requestTab: "19", responseTab: 19, bottomTab: "0" },
  经典: { name: "经典", requestTab: "11", responseTab: 11, bottomTab: "0" },
  知识: { name: "知识", requestTab: "12", responseTab: 12, bottomTab: "0" },
};

export function resolveDiscoverChannel(name = "") {
  const key = String(name || "").trim();
  const ch = DISCOVER_CHANNELS[key];
  if (!ch) {
    throw new Error(`unknown discover channel ${JSON.stringify(name)}`);
  }
  return { ...ch };
}

const SEARCH_TABS = {
  "": SEARCH_TAB_SHORT_PLAY,
  短剧: SEARCH_TAB_SHORT_PLAY,
  short: SEARCH_TAB_SHORT_PLAY,
  综合: SEARCH_TAB_SHORT_PLAY,
  剧集: SEARCH_TAB_SERIES_VIDEO,
  视频: SEARCH_TAB_PUGC_VIDEO,
  讨论: SEARCH_TAB_DISCUSSION,
  小说: SEARCH_TAB_COMMON,
  用户: SEARCH_TAB_HG_USER,
  听书: SEARCH_TAB_VOICE,
};

export function resolveSearchTab(name = "") {
  const key = String(name || "").trim();
  const tab = SEARCH_TABS[key];
  if (!tab) {
    throw new Error(`unknown search tab ${JSON.stringify(name)}`);
  }
  return tab;
}

export function searchOffset(cursor = "") {
  const s = String(cursor || "").trim();
  if (!s) return 0;
  if (!/^\d+$/.test(s)) {
    throw new Error("search cursor is not verified");
  }
  return Number.parseInt(s, 10);
}
