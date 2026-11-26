// Response parsers for all Hongguo endpoints
// (ported from openhongguo internal/protocol/parse.go & danmaku.go).
import { SHOW_TYPE_SERIES_SEASONS } from "./app.js";
import { parseJSONSafe } from "./json.js";
import { decodePlaybackURL } from "./playback_url.js";

const PROMOTED_TEXT = "平台推荐";
const WORKS_TAB_NAME = "剧作";

function flexString(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function flexInt(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = flexString(v);
    if (s) return s;
  }
  return "";
}

function firstNonZero(...values) {
  for (const v of values) {
    const n = flexInt(v);
    if (n !== 0) return n;
  }
  return 0;
}

function trimAll(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const s of list) {
    const t = flexString(s);
    if (t) out.push(t);
  }
  return out;
}

function oneLineText(s) {
  let t = flexString(s);
  const nl = t.indexOf("\n");
  if (nl >= 0) t = t.slice(0, nl);
  if (t.length > 120) t = t.slice(0, 120);
  return t.split(/\s+/).filter(Boolean).join(" ");
}

function checkCode(env, label) {
  const code = flexString(env?.code);
  if (code && code !== "0") {
    throw new Error(`${label} code ${code}`);
  }
}

function appendCatalogCell(page, cell) {
  if (!cell || typeof cell !== "object") return;
  for (const v of asArray(cell.video_data)) {
    const vd = v?.video_detail || {};
    const title = vd.series_title || v?.title || "";
    const id = flexString(v?.series_id);
    if (!id || !title) continue;
    let count = flexInt(vd.episode_cnt);
    if (count === 0 && Array.isArray(vd.video_list)) {
      count = vd.video_list.length;
    }
    page.items.push({
      id,
      title,
      description: vd.series_intro || "",
      coverUrl: vd.series_cover || "",
      episodeCount: count,
      category: "",
    });
  }
  if (cell.video_detail && Array.isArray(cell.video_detail.video_detail_list)) {
    for (const card of cell.video_detail.video_detail_list) {
      const id = firstNonEmpty(card?.series_id_str, card?.series_id);
      if (!id || !card?.series_title) continue;
      page.items.push({
        id,
        title: card.series_title,
        description: card.series_intro || "",
        coverUrl: card.series_cover || "",
        episodeCount: flexInt(card.episode_cnt),
        category: "",
      });
    }
  }
  for (const book of asArray(cell.book_data)) {
    const id = flexString(book?.book_id);
    const title = flexString(book?.book_name);
    if (!id || !title) continue;
    page.items.push({
      id,
      title,
      description: flexString(book?.abstract),
      coverUrl: book?.thumb_url || "",
      episodeCount: flexInt(book?.serial_count),
      category: "",
    });
  }
  if (Array.isArray(cell.cell_data)) {
    for (const nested of cell.cell_data) {
      appendCatalogCell(page, nested);
    }
  }
}

export function parseDiscoverTab(env, tabType = 16) {
  checkCode(env, "catalog");
  const page = { items: [], hasMore: false, nextOffset: 0, sessionId: "" };
  for (const tab of env?.data?.tab_item || []) {
    if (tab?.tab_type !== tabType) continue;
    page.hasMore = Boolean(tab.has_more);
    for (const cell of tab.cell_data || []) {
      appendCatalogCell(page, cell);
    }
  }
  return page;
}

export function discoverContinuationTab(env, tabType = 16) {
  let fallback = null;
  for (const tab of env?.data?.tab_item || []) {
    if (tab?.tab_type !== tabType || !tab.session_id) continue;
    for (const cell of tab.cell_data || []) {
      const id = flexString(cell?.cell_id_str);
      if (!id || !cell?.show_type) continue;
      const next = {
        cellId: id,
        sessionId: tab.session_id,
        clientTemplate: tab.client_template > 0 ? String(tab.client_template) : "",
        showType: String(cell.show_type),
        tabType: String(tab.tab_type),
        offset: "0",
      };
      if (Array.isArray(cell.cell_data) && cell.cell_data.length > 0) {
        return next;
      }
      if (!fallback) fallback = next;
    }
  }
  return fallback;
}

export function parseCellChange(env) {
  checkCode(env, "catalog");
  const d = env?.data || {};
  const page = {
    items: [],
    hasMore: Boolean(d.has_more),
    nextOffset: flexInt(d.next_offset),
    sessionId: flexString(d.session_id),
  };
  appendCatalogCell(page, d.cell_view);
  return page;
}

export function parseSearchTab(env, tabType = 11) {
  checkCode(env, "search");
  const page = { items: [], hasMore: false, nextOffset: 0 };
  for (const tab of env?.search_tabs || []) {
    if (tab?.tab_type !== tabType) continue;
    page.hasMore = Boolean(tab.has_more);
    page.nextOffset = flexInt(tab.next_offset);
    for (const row of tab.data || []) {
      for (const v of asArray(row?.video_data)) {
        const vd = v?.video_detail || {};
        const title = flexString(vd.series_title);
        const id = flexString(v?.series_id);
        if (id && title) {
          page.items.push({
            id,
            title,
            description: vd.series_intro || "",
            coverUrl: vd.series_cover || "",
            episodeCount: flexInt(vd.episode_cnt),
            category: "",
          });
          continue;
        }
        for (const card of vd.video_detail_list || []) {
          const cid = firstNonEmpty(card?.series_id_str, card?.series_id);
          const ctitle = flexString(card?.series_title);
          if (!cid || !ctitle) continue;
          page.items.push({
            id: cid,
            title: ctitle,
            description: card.series_intro || "",
            coverUrl: card.series_cover || "",
            episodeCount: flexInt(card.episode_cnt),
            category: "",
          });
        }
      }
      for (const book of asArray(row?.book_data)) {
        const id = flexString(book?.book_id);
        const title = flexString(book?.book_name);
        if (!id || !title) continue;
        page.items.push({
          id,
          title,
          description: flexString(book?.abstract),
          coverUrl: book?.thumb_url || "",
          episodeCount: flexInt(book?.serial_count),
          category: "",
        });
      }
      for (const user of row?.celebrity_user_list || []) {
        const id = flexString(user?.user_id);
        const name = flexString(user?.base_info?.user_name);
        if (id && name) {
          page.items.push({ id, title: name, description: "", coverUrl: "", episodeCount: 0, category: "" });
        }
      }
      for (const post of asArray(row?.post_data)) {
        const id = flexString(post?.post_id);
        const title = flexString(post?.title);
        if (id && title) {
          page.items.push({ id, title, description: "", coverUrl: "", episodeCount: 0, category: "" });
        }
      }
    }
  }
  return page;
}

function parseSeriesPayload(payload) {
  const v = payload?.video_data;
  if (!v || typeof v !== "object") {
    throw new Error("series response missing video_data");
  }
  const id = firstNonEmpty(v.series_id_str, v.series_id);
  if (!id || !v.series_title) {
    throw new Error("series response missing id or title");
  }
  const list = Array.isArray(v.video_list) ? v.video_list : [];
  const series = {
    id,
    title: v.series_title,
    description: v.series_intro || "",
    coverUrl: v.series_cover || "",
    episodeCount: flexInt(v.episode_cnt) || list.length,
    status: flexInt(v.series_status),
    payType: flexInt(v.pay_info?.pay_type),
    contentType: flexInt(v.content_type),
    platform: flexInt(v.video_platform),
    heat: flexInt(v.hot_score),
    playCount: flexInt(v.series_play_cnt),
    followCount: flexInt(v.followed_cnt),
    diggCount: flexInt(v.digg_cnt),
    rightText: flexString(v.episode_right_text),
    subtitles: trimAll(v.series_sub_title_list),
    ageGate: flexInt(v.age_gate_info?.age_gate),
    isMultiSeason: Boolean(v.is_multi_season),
    seasonIndex: flexInt(v.season_index),
    relatedAlbumId: flexString(v.related_album_id),
    relatedNovelBookId: flexString(v.related_novel_book_id),
    createdAt: flexInt(v.create_time),
  };

  let shift = 0;
  if (list.length > 0) {
    let minNum = flexInt(list[0].vid_index);
    for (let i = 1; i < list.length; i++) {
      const n = flexInt(list[i].vid_index);
      if (n < minNum) minNum = n;
    }
    if (minNum === 0) shift = 1;
  }

  let shared = "";
  let sharedTitle = list.length > 1;
  for (let i = 0; i < list.length; i++) {
    const t = flexString(list[i].title);
    if (i === 0) {
      shared = t;
      continue;
    }
    if (t !== shared) {
      sharedTitle = false;
      break;
    }
  }

  const introTrim = flexString(v.series_intro);
  const episodes = [];
  for (const e of list) {
    const eid = flexString(e?.vid);
    if (!eid) {
      throw new Error(`malformed episode in series ${id}`);
    }
    const number = flexInt(e.vid_index) + shift;
    if (number < 1) {
      throw new Error("episode number is not 1-based");
    }
    const epSeriesId = flexString(e.series_id) || id;
    let title = flexString(e.title);
    if (!title || title === introTrim || (sharedTitle && title === shared)) {
      title = `第${number}集`;
    }
    const cover = firstNonEmpty(e.episode_cover, e.cover);
    episodes.push({
      id: eid,
      seriesId: epSeriesId,
      number,
      title,
      durationSeconds: flexInt(e.duration),
      playable: !e.disable_play,
      vertical: Boolean(e.vertical),
      isNew: Boolean(e.is_newly_update),
      coverUrl: cover,
      contentType: flexInt(e.content_type),
      commentCount: flexInt(e.comment_count),
      diggCount: flexInt(e.digged_count),
    });
  }
  return { series, episodes };
}

export function parseSeries(env) {
  checkCode(env, "series");
  return parseSeriesPayload(env?.data);
}

export function parseSeriesBatch(env) {
  checkCode(env, "series");
  const out = {};
  const data = env?.data || {};
  for (const [key, payload] of Object.entries(data)) {
    const detail = parseSeriesPayload(payload);
    out[detail.series.id || key] = detail;
  }
  return out;
}

function jsonTruthy(v) {
  if (v === null || v === undefined || v === false || v === 0) return false;
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s || s === "false" || s === "0") return false;
    return true;
  }
  if (typeof v === "object") {
    if (Array.isArray(v)) return v.length > 0;
    return Object.keys(v).length > 0;
  }
  return Boolean(v);
}

function itemWrappedKey(it) {
  if (it?.encrypt_info && typeof it.encrypt_info === "object" && !Array.isArray(it.encrypt_info)) {
    const k = flexString(it.encrypt_info.spade_a);
    if (k) return k;
  }
  return flexString(it?.spade_a);
}

function itemProtection(it) {
  let method = flexString(it?.encryption_method);
  const info = it?.encrypt_info;
  if (info && typeof info === "object" && !Array.isArray(info) && Object.keys(info).length > 0) {
    if (!method) method = flexString(info.encryption_method);
    if (info.encrypt || method || info.kid || info.spade_a) {
      return { protected: true, method };
    }
  } else if (jsonTruthy(info)) {
    return { protected: true, method };
  }
  if (it?.gear_des_key || it?.spade_a || it?.kid || method) {
    return { protected: true, method };
  }
  if (jsonTruthy(it?.encrypt)) {
    return { protected: true, method };
  }
  if (jsonTruthy(it?.check_info)) {
    return { protected: true, method };
  }
  return { protected: false, method };
}

function parsePlaybackItem(it, seed) {
  const meta = it?.video_meta || {};
  const urls = [];
  for (const raw of [it?.main_url, it?.backup_url, it?.backup_url_1, it?.backup_url_2]) {
    if (!raw) continue;
    try {
      const decoded = decodePlaybackURL(raw, seed);
      if (decoded && !urls.includes(decoded)) {
        urls.push(decoded);
      }
    } catch {
      // Skip invalid URL candidates.
    }
  }
  const prot = itemProtection(it);
  const vtype = firstNonEmpty(meta.vtype, it?.vtype).toLowerCase();
  const definition = firstNonEmpty(meta.definition, it?.definition);
  let hls = jsonTruthy(it?.hls) || flexString(it?.m3u8) !== "";
  if (!definition && vtype === "m3u8") hls = true;
  return {
    url: urls[0] || "",
    backupUrl: urls[1] || "",
    backupUrls: urls.slice(1),
    definition,
    quality: firstNonEmpty(meta.quality, it?.quality, it?.quality_desc),
    codec: firstNonEmpty(meta.codec_type, it?.codec_type),
    width: firstNonZero(meta.vwidth, it?.vwidth),
    height: firstNonZero(meta.vheight, it?.vheight),
    bitrate: firstNonZero(meta.bitrate, it?.bitrate),
    size: firstNonZero(meta.size, it?.size),
    hls,
    dash: vtype === "dash",
    protected: prot.protected,
    encryption: prot.method,
    wrappedKey: itemWrappedKey(it),
  };
}

function extractPlaybackItems(videoList) {
  if (!videoList) return [];
  if (Array.isArray(videoList)) return videoList;
  if (typeof videoList === "object") {
    const keys = Object.keys(videoList).sort();
    return keys.map((k) => {
      const item = { ...videoList[k] };
      if (!item.definition && !item.video_meta?.definition) {
        item.definition = k;
      }
      return item;
    });
  }
  return [];
}

export function parsePlayback(env, episodeID) {
  checkCode(env, "playback");
  const rootData = env?.data;
  if (!rootData || typeof rootData !== "object") {
    throw new Error("playback model missing");
  }
  let entry = rootData;
  if (entry["1004"] && typeof entry["1004"] === "object") {
    entry = entry["1004"];
  }
  if (!("video_model" in entry)) {
    if (!(episodeID in entry) || !entry[episodeID] || typeof entry[episodeID] !== "object") {
      throw new Error("playback model missing for requested episode");
    }
    entry = entry[episodeID];
  }
  const envelopeExpiry = firstNonZero(
    entry.url_expire,
    entry.expire_time,
    rootData.url_expire,
    rootData.expire_time
  );
  let video = entry.video_model;
  if (typeof video === "string") {
    video = parseJSONSafe(video);
  }
  if (!video || typeof video !== "object") {
    throw new Error("playback model is not an object");
  }

  let rawItems = extractPlaybackItems(video.video_list);
  let audioUrl = "";
  if (rawItems.length === 0 && video.dynamic_video) {
    rawItems = Array.isArray(video.dynamic_video.dynamic_video_list)
      ? video.dynamic_video.dynamic_video_list
      : [];
    const audioList = video.dynamic_video.dynamic_audio_list;
    if (Array.isArray(audioList) && audioList.length > 0) {
      try {
        audioUrl = decodePlaybackURL(audioList[0]?.main_url, video.key_seed);
      } catch {
        audioUrl = "";
      }
    }
  }

  const seed = video.key_seed || "";
  const streams = [];
  let protectedCount = 0;
  let keyMaterial = "";
  for (const raw of rawItems) {
    const s = parsePlaybackItem(raw, seed);
    if (!s.url) continue;
    if (s.protected) protectedCount++;
    if (!keyMaterial && s.wrappedKey) keyMaterial = s.wrappedKey;
    streams.push(s);
  }
  if (streams.length === 0) {
    throw new Error("playback model unavailable");
  }
  return {
    episodeId: episodeID,
    videoId: flexString(video.video_id),
    mediaType: flexString(video.media_type),
    durationSeconds: Math.round(Number(video.video_duration) || 0),
    expiresAt: firstNonZero(video.url_expire, video.expire_time, envelopeExpiry),
    streams,
    audioUrl,
    protected: protectedCount === streams.length,
    keyMaterial,
  };
}

export function parseAlbum(env, albumID) {
  checkCode(env, "album");
  let album = env?.data?.album_data;
  if (typeof album === "string") album = parseJSONSafe(album);
  if (!album || typeof album !== "object") {
    throw new Error("album model missing");
  }
  const id = firstNonEmpty(album.album_id_str, album.album_id, albumID);
  const rows = Array.isArray(album.series_list)
    ? album.series_list
    : Array.isArray(album.video_list)
      ? album.video_list
      : [];
  const seasons = rows.map((r) => ({
    seriesId: firstNonEmpty(r?.series_id_str, r?.series_id),
    title: r?.series_title || "",
    index: flexInt(r?.season_index),
    coverUrl: r?.series_cover || "",
    episodeCount: flexInt(r?.episode_cnt),
    status: flexInt(r?.series_status),
  }));
  return {
    id,
    title: album.album_title || "",
    description: album.album_intro || "",
    coverUrl: album.album_cover || "",
    seasonCount: flexInt(album.season_cnt) || seasons.length,
    seasons,
  };
}

function decodeSeriesList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const id = firstNonEmpty(r?.series_id_str, r?.series_id, r?.vid);
    const title = firstNonEmpty(r?.series_title, r?.title);
    if (!id || !title) continue;
    const cover = firstNonEmpty(r?.series_cover, r?.cover);
    out.push({
      id,
      title,
      description: oneLineText(r?.series_intro),
      coverUrl: cover,
      episodeCount: flexInt(r?.episode_cnt),
      category: "",
    });
  }
  return out;
}

export function parsePlanCells(env) {
  checkCode(env, "plan");
  const out = [];
  for (const c of env?.data || []) {
    let items = decodeSeriesList(c?.video_data);
    if (items.length === 0) items = decodeSeriesList(c?.cell_data);
    out.push({
      showType: flexInt(c?.show_type),
      cellId: flexString(c?.cell_id),
      cellName: c?.cell_name || "",
      sessionId: firstNonEmpty(c?.session_id, env?.session_id),
      items,
    });
  }
  return out;
}

export function parseSeasons(env) {
  checkCode(env, "plan");
  const out = [];
  for (const c of env?.data || []) {
    if (flexInt(c?.show_type) !== SHOW_TYPE_SERIES_SEASONS) continue;
    for (const r of c?.video_data || []) {
      const id = flexString(r?.series_id);
      if (!id) continue;
      out.push({
        seriesId: id,
        title: r?.title || "",
        index: flexInt(r?.season_index),
        coverUrl: r?.cover || "",
        episodeCount: flexInt(r?.episode_cnt),
        status: 0,
      });
    }
  }
  return out;
}

function topicQuery(link) {
  if (!link) return "";
  try {
    return new URL(link).searchParams.get("directQueryWord") || "";
  } catch {
    return "";
  }
}

export function parseHotSearch(env) {
  checkCode(env, "plan");
  const parseHotRows = (rows) => {
    const out = [];
    for (const r of rows || []) {
      const id = flexString(r?.series_id);
      if (!id) continue;
      out.push({
        position: out.length + 1,
        seriesId: id,
        title: r?.title || "",
        coverUrl: r?.cover || "",
        episodeCount: flexInt(r?.episode_cnt),
        contentType: flexInt(r?.content_type),
        searchScore: r?.card_tips || "",
        heat: r?.rec_text || "",
        tag: r?.tag_info?.text || "",
      });
    }
    return out;
  };

  const out = { guesses: [], boards: [] };
  for (const c of env?.data || []) {
    let data = c?.lynx_data;
    if (!data) continue;
    if (typeof data === "string") {
      data = parseJSONSafe(data);
    }
    if (!Array.isArray(data)) continue;
    for (const cell of data) {
      if (Array.isArray(cell?.video_data) && cell.video_data.length > 0) {
        out.guesses.push(...parseHotRows(cell.video_data));
      }
      for (const b of cell?.cell_data || []) {
        const board = {
          name: b?.cell_name || "",
          items: parseHotRows(b?.video_data),
          topics: [],
        };
        for (const t of b?.video_topic || []) {
          board.topics.push({
            id: flexString(t?.topic_id),
            title: t?.title || "",
            query: topicQuery(t?.url),
            heat: t?.secondary_info_list?.[0]?.content || "",
          });
        }
        if (board.items.length > 0 || board.topics.length > 0) {
          out.boards.push(board);
        }
      }
    }
  }
  return out;
}

export function parseNewReleases(env) {
  checkCode(env, "subscribe list");
  const d = env?.data || {};
  const out = {
    date: d.calendar_schema?.default_date || "",
    dates: Array.isArray(d.calendar_schema?.date_list) ? d.calendar_schema.date_list : [],
    hasMore: Boolean(d.has_more),
    nextOffset: flexInt(d.next_offset),
    sessionId: flexString(d.session_id),
    items: [],
  };
  for (const it of d.subscribe_items || []) {
    const online = Boolean(it?.is_online);
    const when = firstNonZero(it?.schedule_publish_time, it?.expected_publish_time);
    const row = it?.subscribe_data;
    const seriesId = row ? flexString(row.series_id) : flexString(it?.item_id);
    const title = row ? row.title || "" : it?.name || "";
    if (!seriesId || seriesId === "0" || !title.trim()) continue;
    const description = row ? row.video_desc || "" : it?.item_desc || "";
    const coverUrl = row ? row.cover || "" : it?.cover || "";
    const episodeCount = row ? flexInt(row.episode_cnt) : 0;
    let heat = "";
    if (online && Array.isArray(it?.rec_tags) && it.rec_tags.length > 0) {
      heat = it.rec_tags[0]?.content || "";
    } else if (!online) {
      heat = it?.expected_rec_text || "";
    }
    out.items.push({
      online,
      seriesId,
      title,
      description,
      coverUrl,
      episodeCount,
      publishAt: when > 0 ? when : 0,
      note: it?.sub_info || "",
      heat,
      categories: Array.isArray(it?.categories) ? it.categories : [],
    });
  }
  return out;
}

export function parseProfile(env) {
  checkCode(env, "profile");
  const u = env?.data?.ugc_user || {};
  const tags = [];
  for (const t of u.user_tag?.sub_title_list || []) {
    if (t?.text) tags.push(t.text);
  }
  const labels = [];
  for (const t of u.user_expand?.sub_title_list || []) {
    if (t?.text) labels.push(t.text);
  }
  return {
    userId: flexString(u.user_id),
    name: flexString(u.base_info?.user_name),
    description: u.base_info?.description || "",
    avatarUrl: u.base_info?.user_avatar || "",
    followers: flexInt(u.user_relation?.fans_num),
    likes: flexInt(u.user_relation?.recv_digged_count),
    tags,
    labels,
  };
}

export function parseWorksTab(env) {
  checkCode(env, "works tabs");
  let tabs = Array.isArray(env?.data?.tabs) ? env.data.tabs : [];
  if (tabs.length === 0 && env?.data?.hightlight) {
    tabs = [env.data.hightlight];
  }
  for (const t of tabs) {
    for (const s of t?.sub_tabs || []) {
      if (s?.name === WORKS_TAB_NAME) {
        return { tab: flexInt(t.tab_type), sub: flexInt(s.tab_type) };
      }
    }
  }
  for (const t of tabs) {
    if (t?.name !== WORKS_TAB_NAME || !Array.isArray(t.sub_tabs) || t.sub_tabs.length === 0) {
      continue;
    }
    let sub = t.sub_tabs[0];
    for (const s of t.sub_tabs) {
      if (s?.name === "全部") {
        sub = s;
        break;
      }
    }
    return { tab: flexInt(t.tab_type), sub: flexInt(sub.tab_type) };
  }
  return null;
}

export function parseUserWorks(env) {
  checkCode(env, "works");
  const info = env?.data?.common_list_info || {};
  const out = {
    items: [],
    hasMore: Boolean(info.has_more),
    cursor: info.cursor || "",
  };
  for (const row of env?.data?.data_list || []) {
    const v = row?.video;
    const id = flexString(v?.video_id);
    const title = flexString(v?.common?.title);
    if (!id || !title) continue;
    const tags = [];
    for (const t of v?.expand?.sub_title_list || []) {
      if (t?.text) tags.push(t.text);
    }
    out.items.push({
      seriesId: id,
      title: v.common.title,
      description: v.common.intro || "",
      coverUrl: v.common.cover || "",
      episodeCount: flexInt(v.expand?.episode_cnt),
      heat: flexInt(v.stat?.hot),
      plays: flexInt(v.stat?.play_cnt),
      tags,
    });
  }
  return out;
}

export function parseShortFilter(env) {
  checkCode(env, "short filter");
  const d = env?.data || {};
  const rows = [];
  for (const r of d.selector_rows || []) {
    if (!r?.type) continue;
    const options = [];
    for (const it of r.items || []) {
      const val = flexString(it?.selector_item_id);
      if (val) options.push({ name: it.show_name || "", value: val });
    }
    rows.push({ key: r.type, name: r.row_name || "", options });
  }
  return {
    rows,
    items: decodeSeriesList(d.video_data),
    nextOffset: flexInt(d.next_offset),
    hasMore: Boolean(d.has_more),
    sessionId: flexString(d.session_id),
  };
}

function recommendRank(raw) {
  if (!raw) return 0;
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = parseJSONSafe(obj);
    } catch {
      return 0;
    }
  }
  return flexInt(obj?.rank);
}

export function parseShortRank(env) {
  checkCode(env, "short rank");
  const d = env?.data || {};
  const contents = [];
  for (const c of d.cell_view?.cell_selector?.outer_row?.items || []) {
    const id = flexString(c?.selector_item_id);
    if (!id) continue;
    const boards = [];
    for (const l of c.sub_cell_selector?.outer_row?.items || []) {
      boards.push({
        id: flexString(l?.selector_item_id),
        name: l?.show_name || "",
        selected: Boolean(l?.is_selected),
      });
    }
    contents.push({ id, name: c.show_name || "", selected: Boolean(c.is_selected), boards });
  }
  const items = [];
  for (const cell of d.cell_view?.cell_data || []) {
    for (const v of cell?.video_data || []) {
      const id = flexString(v?.series_id);
      const title = flexString(v?.title);
      if (!id || !title) continue;
      const score = v?.rec_text_item?.RecommendText || "";
      items.push({
        position: items.length + 1,
        rank: recommendRank(v.recommend_info),
        seriesId: id,
        title,
        coverUrl: v.cover || "",
        score,
        episodeCount: flexInt(v.episode_cnt),
        promoted: score === PROMOTED_TEXT,
        votes: 0,
        actorId: "",
        userId: "",
        actor: "",
        avatarUrl: "",
        details: [],
        intro: "",
      });
    }
    for (const u of cell?.ugc_user_data || []) {
      const b = u?.user_info?.base_info || {};
      const actorId = firstNonEmpty(b.actor_id_str, b.user_id);
      const name = flexString(b.user_name);
      if (!actorId || !name) continue;
      const details = [];
      for (const s of u.sub_title_list || []) {
        if (s?.content) details.push(s.content);
      }
      items.push({
        position: items.length + 1,
        rank: 0,
        seriesId: "",
        title: "",
        coverUrl: "",
        score: u?.rec_text_item?.RecommendText || "",
        episodeCount: 0,
        promoted: false,
        votes: 0,
        actorId,
        userId: flexString(b.user_id),
        actor: name,
        avatarUrl: b.user_avatar || "",
        details,
        intro: u.intro || "",
      });
    }
  }
  return {
    contents,
    items,
    nextOffset: flexInt(d.next_offset),
    hasMore: Boolean(d.has_more),
    sessionId: flexString(d.session_id),
    version: flexString(d.rank_version),
  };
}

export function parseSuggest(env) {
  checkCode(env, "suggest");
  const d = env?.data || {};
  for (const list of [d.query_result_v2, d.suggest_result]) {
    if (!Array.isArray(list)) continue;
    const out = [];
    for (const r of list) {
      const text = flexString(r?.name);
      if (!text) continue;
      let keyword = flexString(r?.keyword);
      if (!keyword || keyword.length > 40 || !/^[0-9]+$/.test(keyword)) {
        keyword = text;
      }
      out.push({ text, keyword, kind: flexInt(r?.word_type) });
    }
    if (out.length > 0) return out;
  }
  const out = [];
  for (const w of d.query_result || []) {
    const text = flexString(w);
    if (text) out.push({ text, keyword: text, kind: 0 });
  }
  return out;
}

export function parseDanmaku(env) {
  checkCode(env, "danmaku");
  const d = env?.data || {};
  const cursor = d.common_list_info?.cursor || "";
  let start = 0;
  let end = 0;
  let total = 0;
  if (cursor) {
    try {
      const win = parseJSONSafe(cursor);
      start = flexInt(win?.start_offset_time);
      end = flexInt(win?.end_offset_time);
      total = flexInt(win?.danmaku_count);
    } catch {
      // Non-JSON cursor.
    }
  }
  const items = [];
  for (const row of d.data_list || []) {
    const c = row?.comment;
    if (!c || c.expand?.offset_time === undefined || c.expand?.offset_time === null) continue;
    const offsetMs = flexInt(c.expand.offset_time);
    if (offsetMs < 0) continue;
    const text = flexString(c.common?.content?.text);
    if (!text) continue;
    items.push({
      id: flexString(c.comment_id),
      text,
      offsetMs,
      likes: flexInt(c.stat?.digg_count),
      plusOnes: flexInt(c.stat?.add_one_count),
      createdAt: flexInt(c.common?.create_timestamp),
    });
  }
  items.sort((a, b) => a.offsetMs - b.offsetMs);
  return {
    items,
    start,
    end,
    total,
    hasMore: Boolean(d.common_list_info?.has_more),
    next: flexInt(d.extra?.next_query_danmaku_list_time),
    cursor,
  };
}
