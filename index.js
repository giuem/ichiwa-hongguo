// Ichiwa (一集) source plugin entry point for Hongguo Short Drama (红果短剧).
// Protocol specification: docs/plugin-design.md (apiVersion 1).
import { HongguoClient } from "./src/client.js";
import { emojify } from "./src/emoji.js";
import { ErrCode, isErr, toHostError } from "./src/errors.js";
import { announceSeasons, seasonsOf, startCalendar } from "./src/seasons.js";

const FILTER_PANEL_CACHE_PREFIX = "hongguo_filter_panel:";
const RANK_CONTENTS_CACHE_KEY = "hongguo_rank_contents";
const RANK_CONTENTS_STORAGE_KEY = "hongguo_rank_contents";
const RANK_CELEBRITY = "ranklist_celebrity";
const RANK_CELEBRITY_TITLE = "演员榜";
// The 类别 the server listed when this was written, offered on the actor
// ranking until a ranking of another 类别 has been read once.
const RANK_CONTENTS_FALLBACK = [
  { id: "all", name: "全部" },
  { id: "series_album", name: "系列剧" },
  { id: "comic_series_rank", name: "漫剧" },
  { id: "human", name: "真人剧" },
  { id: "ai_playlet", name: "AI剧" },
];
const META_CACHE_TTL_SEC = 600;
const PROFILE_WAIT_MS = 1000;
// How long media waits for the season list once the details are in, as the
// Go source does.
const SEASON_LIST_WAIT_MS = 1000;

const CHANNEL_MAP = {
  recommend: { channel: "推荐", title: "推荐" },
  live: { channel: "真人剧", title: "真人剧" },
  comic: { channel: "漫剧", title: "漫剧" },
};

function makeClient(options = {}) {
  return new HongguoClient({ retryAttempts: 3, deviceResets: 3, ...options });
}

function formatHeat(n) {
  if (n >= 100_000_000) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 1e4).toFixed(1)}万`;
  return String(n);
}

function httpUrl(u) {
  const s = String(u || "").trim();
  return s.startsWith("https://") || s.startsWith("http://") ? s : undefined;
}

function truncate(s, maxChars) {
  const t = String(s || "").trim();
  if (!t) return undefined;
  const chars = Array.from(t);
  return chars.length <= maxChars ? t : chars.slice(0, maxChars).join("");
}

function showToCard(s, noteOverride = undefined) {
  const card = {
    kind: "media",
    id: s.id,
    title: String(s.title || "").trim(),
    shape: "portrait",
  };
  const subtitle = String(s.description || "").trim();
  if (subtitle) card.subtitle = subtitle;
  const img = httpUrl(s.coverUrl);
  if (img) card.image = img;
  if (s.episodeCount > 0) {
    card.badges = [`全${s.episodeCount}集`];
  }
  const note = truncate(noteOverride !== undefined ? noteOverride : s.category, 24);
  if (note) card.note = note;
  return card;
}

function actorToCard(a) {
  const card = {
    kind: "collection",
    id: `person:${a.userId}`,
    title: String(a.actor || "").trim(),
    shape: "circle",
  };
  const subtitle = (a.details && a.details.length > 0 ? a.details.join(" · ") : a.intro || "").trim();
  if (subtitle) card.subtitle = subtitle;
  const img = httpUrl(a.avatarUrl);
  if (img) card.image = img;
  const note = truncate(a.score, 24);
  if (note) card.note = note;
  return card;
}

function workToCard(w) {
  let tag = "";
  for (const t of w.tags || []) {
    if (!t.endsWith("集")) {
      tag = t;
      break;
    }
  }
  if (!tag && w.plays > 0) {
    tag = `${formatHeat(w.plays)}播放`;
  }
  return showToCard(
    {
      id: w.seriesId,
      title: w.title,
      description: w.description,
      coverUrl: w.coverUrl,
      episodeCount: w.episodeCount,
    },
    tag
  );
}

async function fillMissingCovers(client, shows) {
  const ids = [];
  for (const s of shows) {
    if (!s.coverUrl || !s.episodeCount) {
      ids.push(s.id);
    }
  }
  if (ids.length === 0) return shows;
  try {
    const details = await client.getSeriesBatch(ids);
    const byId = new Map();
    for (const d of details) {
      if (d?.series) byId.set(d.series.id, d.series);
    }
    return shows.map((s) => {
      const d = byId.get(s.id);
      if (!d) return s;
      return {
        ...s,
        coverUrl: s.coverUrl || d.coverUrl,
        episodeCount: s.episodeCount || d.episodeCount,
        description: s.description || d.description,
      };
    });
  } catch {
    return shows;
  }
}

function stripAllPrefix(name) {
  const s = String(name || "").trim();
  if (s.startsWith("全部") && s.length > 2) {
    return s.slice(2);
  }
  return s || "筛选";
}

async function getFilterPanelCached(client, genre) {
  const key = FILTER_PANEL_CACHE_PREFIX + (genre || "default");
  try {
    const cached = host.cache.get(key);
    if (cached) return JSON.parse(cached);
  } catch {
    // Ignore cache errors.
  }
  const rows = await client.shortFilterPanel(genre);
  try {
    host.cache.set(key, JSON.stringify(rows), META_CACHE_TTL_SEC);
  } catch {
    // Ignore cache errors.
  }
  return rows;
}

function normalizeCodec(raw) {
  const lower = String(raw || "").trim().toLowerCase();
  if (!lower) return undefined;
  if (
    lower.includes("h265") ||
    lower.includes("h.265") ||
    lower.includes("hevc") ||
    lower.includes("hvc1") ||
    lower.includes("hev1") ||
    lower.includes("bytevc1")
  ) {
    return "hevc";
  }
  if (lower.includes("h264") || lower.includes("h.264") || lower.includes("avc")) {
    return "h264";
  }
  if (lower.includes("av1") || lower.includes("av01")) {
    return "av1";
  }
  return lower;
}

function rankStreamScore(s, prefer) {
  const maxHeight = prefer?.maxHeight > 0 ? prefer.maxHeight : 1080;
  const allowHevc = prefer?.hevc !== false;
  const short = Math.min(s.width || 0, s.height || 0) || 480;
  let score =
    short > maxHeight
      ? maxHeight - short
      : short * 10 + Math.min(Math.floor((s.bitrate || 0) / 100000), 9);
  if (!allowHevc && s.codec === "hevc") {
    score -= 1 << 20;
  }
  return score;
}

const SEASONS_CACHE_PREFIX = "hongguo_seasons:";
const SEASONS_CACHE_TTL_SEC = 600;

// seasonList returns the normalized seasons of id, or [] for a show of a
// single season, from host.cache when it was read in the last ten minutes.
function cachedSeasonList(id) {
  try {
    const cached = host.cache.get(SEASONS_CACHE_PREFIX + id);
    if (cached) return JSON.parse(cached);
  } catch {
    // Ignore cache errors.
  }
  return null;
}

async function seasonList(client, id, detailP) {
  const cached = cachedSeasonList(id);
  if (cached) return cached;
  const album = await client.seasons(
    id,
    detailP.then((d) => d.series)
  );
  let entries = seasonsOf(album.seasons);
  if (entries.length < 2) entries = [];
  const raw = JSON.stringify(entries);
  for (const key of new Set([id, ...entries.map((e) => e.id)])) {
    try {
      host.cache.set(SEASONS_CACHE_PREFIX + key, raw, SEASONS_CACHE_TTL_SEC);
    } catch {
      // Ignore cache errors.
    }
  }
  return entries;
}

function toProtocolSeason(s, current) {
  const parts = [];
  if (!s.online || s.isNew) {
    if (s.note) parts.push(s.note);
    else if (s.online) parts.push("新上线");
    if (s.heat) parts.push(s.heat);
  }
  const item = {
    id: s.id,
    title: `第${s.index}季`,
    current,
    available: s.online,
  };
  const name = String(s.title || "").trim();
  if (name) item.name = name;
  const img = httpUrl(s.coverUrl);
  if (img) item.image = img;
  if (parts.length > 0) item.note = parts.join(" · ");
  return item;
}

export async function navigation() {
  return {
    items: [
      { id: "channel:recommend", title: "推荐", icon: "home" },
      { id: "channel:live", title: "真人剧", icon: "film" },
      { id: "channel:comic", title: "漫剧", icon: "sparkles" },
      { id: "rank", title: "排行榜", icon: "trophy" },
      { id: "filter", title: "筛选", icon: "filter" },
    ],
  };
}

// rankContentsCacheKey keeps the actor ranking's 类别 list, which lists
// only itself, apart from the others' list.
function rankContentsCacheKey(content) {
  return content === RANK_CELEBRITY ? `${RANK_CONTENTS_CACHE_KEY}:${RANK_CELEBRITY}` : RANK_CONTENTS_CACHE_KEY;
}

async function handleRankCollection(client, req) {
  const reqFilters = req.filters || {};
  let content = String(reqFilters.content || "").trim();
  let board = String(reqFilters.board || "").trim();

  // If the user switched content, clear a stale board ID from the previous content.
  if (!req.cursor && content && board) {
    try {
      const cached = host.cache.get(rankContentsCacheKey(content));
      if (cached) {
        const contents = JSON.parse(cached);
        const match = contents.find((c) => c.id === content);
        if (match && !match.boards.some((b) => b.id === board)) {
          board = "";
        }
      }
    } catch {
      // Ignore cache error.
    }
  }

  let r;
  try {
    r = await client.shortRank({
      content: req.cursor ? "" : content,
      board: req.cursor ? "" : board,
      cursor: req.cursor || "",
    });
  } catch (err) {
    if (!req.cursor && board && isErr(err, ErrCode.ContentUnavailable)) {
      r = await client.shortRank({ content, board: "", cursor: "" });
    } else {
      throw err;
    }
  }

  if (r.contents.length > 0) {
    try {
      host.cache.set(rankContentsCacheKey(r.content), JSON.stringify(r.contents), META_CACHE_TTL_SEC);
    } catch {
      // Ignore cache error.
    }
    if (r.content !== RANK_CELEBRITY) saveRankContents(r.contents);
  }

  const items = [];
  for (const it of r.items) {
    if (it.promoted) continue;
    if (it.seriesId) {
      let tag = it.score;
      if (!tag && it.votes > 0) tag = formatHeat(it.votes);
      items.push(
        showToCard(
          {
            id: it.seriesId,
            title: it.title,
            coverUrl: it.coverUrl,
            episodeCount: it.episodeCount,
          },
          tag
        )
      );
    } else if (it.userId) {
      items.push(actorToCard(it));
    }
  }

  const page = {
    title: "排行榜",
    layout: "ranked",
    items,
  };
  if (r.hasMore && r.cursor) {
    page.cursor = r.cursor;
  }
  if (!req.cursor) {
    page.filters = rankFilters(r);
  }
  return page;
}

// savedRankContents is the 类别 list (id and name only) last seen on a
// ranking other than the actor ranking, kept in host.storage so it outlives
// the cache and restarts, or the fallback list.
function savedRankContents() {
  try {
    const list = JSON.parse(host.storage.get(RANK_CONTENTS_STORAGE_KEY) || "null");
    if (Array.isArray(list) && list.some((c) => c?.id && c.id !== RANK_CELEBRITY)) return list;
  } catch {
    // Ignore storage errors.
  }
  return RANK_CONTENTS_FALLBACK;
}

function saveRankContents(contents) {
  const list = contents
    .filter((c) => c?.id && c.id !== RANK_CELEBRITY)
    .map((c) => ({ id: String(c.id), name: String(c.name || "") }));
  if (list.length === 0) return;
  const raw = JSON.stringify(list);
  try {
    if (host.storage.get(RANK_CONTENTS_STORAGE_KEY) !== raw) host.storage.set(RANK_CONTENTS_STORAGE_KEY, raw);
  } catch {
    // Ignore storage quota errors.
  }
}

// rankFilters is the 类别 row, which always offers the actor ranking even
// though the server no longer lists it, and the 榜单 row of the chosen 类别.
// The actor ranking's own answer lists only itself, so there the other 类别
// come from the last list seen, or the fallback list.
function rankFilters(r) {
  const contents = [];
  const add = (c) => {
    if (c?.id && !contents.some((x) => x.id === c.id)) contents.push(c);
  };
  if (r.content === RANK_CELEBRITY || r.contents.every((c) => c.id === RANK_CELEBRITY)) {
    savedRankContents().forEach(add);
  }
  r.contents.forEach(add);
  const options = contents
    .filter((c) => c.id !== RANK_CELEBRITY)
    .map((c) => ({ value: c.id, title: c.name }));
  options.push({ value: RANK_CELEBRITY, title: RANK_CELEBRITY_TITLE });
  const rows = [{ key: "content", title: "类别", options, value: r.content }];
  const active = r.contents.find((c) => c.id === r.content);
  if (active && active.boards?.length > 0) {
    rows.push({
      key: "board",
      title: "榜单",
      options: active.boards.map((b) => ({ value: b.id, title: b.name })),
      value: r.board || active.boards[0].id,
    });
  }
  return rows;
}

const FILTER_GENRE_KEY = "genre";
const FILTER_GENRES = new Set(["short_play", "comic_series", "ai_series"]);

// buildFilterRows turns the panel's rows into FilterRows. The values of the
// rows other than the genre carry a "<genre>:" prefix, so a choice made
// under one genre is dropped, statelessly, once the genre changes. It
// returns the rows and the selections that still apply, unprefixed.
export function buildFilterRows(panelRows, chosen) {
  let genre = "";
  const genreRow = panelRows.find((r) => r.key === FILTER_GENRE_KEY);
  const wanted = String(chosen?.[FILTER_GENRE_KEY] || "").trim();
  if (genreRow && wanted && genreRow.options.some((o) => o.value === wanted)) {
    genre = wanted;
  }
  const prefix = `${genre}:`;
  const selections = {};
  const rows = [];
  for (const row of panelRows) {
    const options = [{ value: "", title: "全部" }];
    if (row.key === FILTER_GENRE_KEY) {
      for (const o of row.options) options.push({ value: o.value, title: o.name });
      if (genre) selections[row.key] = [genre];
      rows.push({ key: row.key, title: stripAllPrefix(row.name), options, value: genre });
      continue;
    }
    const val = String(chosen?.[row.key] || "").trim();
    const raw = val.startsWith(prefix) ? val.slice(prefix.length) : "";
    let selected = "";
    for (const o of row.options) {
      const encoded = prefix + o.value;
      options.push({ value: encoded, title: o.name });
      if (raw && o.value === raw) {
        selections[row.key] = [raw];
        selected = encoded;
      }
    }
    rows.push({ key: row.key, title: stripAllPrefix(row.name), options, value: selected });
  }
  return { rows, selections };
}

// pageError describes a failed list for CollectionPage.error.
function pageError(err, context) {
  const he = toHostError(err, context);
  const out = { code: he.code || "plugin" };
  if (he.message) out.message = he.message;
  if (he.retryAfter > 0) out.retryAfter = he.retryAfter;
  return out;
}

async function handleFilterCollection(client, req) {
  if (req.cursor) {
    // The cursor carries the selections; send nothing else with it.
    const res = await client.shortFilter({ cursor: req.cursor });
    const page = {
      title: "筛选",
      layout: "grid",
      items: res.items.map((s) => showToCard(s)),
    };
    if (res.hasMore && res.cursor) page.cursor = res.cursor;
    return page;
  }

  const reqFilters = req.filters || {};
  const wanted = String(reqFilters[FILTER_GENRE_KEY] || "").trim();
  const panelRows = await getFilterPanelCached(client, FILTER_GENRES.has(wanted) ? wanted : "");
  const { rows, selections } = buildFilterRows(panelRows, reqFilters);
  const page = { title: "筛选", filters: rows, layout: "grid", items: [] };
  try {
    const res = await client.shortFilter({ selections, cursor: "" });
    page.items = res.items.map((s) => showToCard(s));
    if (res.hasMore && res.cursor) page.cursor = res.cursor;
  } catch (err) {
    if (isErr(err, ErrCode.ContentUnavailable)) {
      // Nothing matches these selections.
      return page;
    }
    if (isAbort(err)) throw err;
    // The rows are in: show them with the error so the user can change the
    // selections or retry.
    page.error = pageError(err, "collection");
  }
  return page;
}

function isAbort(err) {
  return err?.name === "AbortError";
}

async function handlePersonCollection(client, userID, req) {
  if (req.cursor) {
    const works = await client.personWorks(userID, req.cursor);
    const page = {
      layout: "grid",
      items: works.items.filter((w) => w.seriesId).map(workToCard),
    };
    if (works.hasMore && works.cursor) page.cursor = works.cursor;
    return page;
  }

  // The profile and the works are read at once. Without the works the page
  // has nothing to show, so their failure fails the page; once they are in,
  // the profile gets at most PROFILE_WAIT_MS more, and a profile that fails
  // or is late only leaves the header out.
  const profile = client.person(userID).then(
    (info) => ({ info }),
    (err) => {
      console.log(`[hongguo] profile of person ${userID} failed: ${err?.message || err}`);
      return { info: null };
    }
  );
  const works = await client.personWorks(userID, "");
  const items = works.items.filter((w) => w.seriesId).map(workToCard);
  let timer = null;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ info: null, late: true }), PROFILE_WAIT_MS);
  });
  const got = await Promise.race([profile, late]);
  clearTimeout(timer);
  if (got.late) {
    console.log(`[hongguo] profile of person ${userID} is late; showing the works without it`);
  }
  if (!got.info) {
    const page = { layout: "grid", items };
    if (works.hasMore && works.cursor) page.cursor = works.cursor;
    return page;
  }

  const info = got.info;
  const meta = [];
  for (const tag of [...(info.tags || []), ...(info.labels || [])]) {
    if (tag) meta.push({ value: tag });
  }
  if (info.followers > 0) {
    meta.push({ label: "粉丝", value: formatHeat(info.followers) });
  }
  if (info.likes > 0) {
    meta.push({ label: "获赞", value: formatHeat(info.likes) });
  }

  const header = {
    title: info.name,
    shape: "circle",
  };
  const avatar = httpUrl(info.avatarUrl);
  if (avatar) header.image = avatar;
  if (info.description && info.description.trim()) {
    header.description = info.description.trim();
  }
  if (meta.length > 0) header.meta = meta;

  const page = {
    title: info.name,
    header,
    layout: "grid",
    items,
  };
  if (works.hasMore && works.cursor) page.cursor = works.cursor;
  return page;
}

async function handleRelatedCollection(client, seriesID) {
  const rec = await client.seriesRecommend(seriesID);
  const filtered = rec.items.filter((s) => s.id !== seriesID);
  const filled = await fillMissingCovers(client, filtered);
  return {
    title: rec.cellTitle || "相关推荐",
    layout: "grid",
    items: filled.map((s) => showToCard(s)),
  };
}

export async function collection(req) {
  const id = String(req?.id || "").trim();
  const client = makeClient();
  try {
    if (id.startsWith("channel:")) {
      const slug = id.slice("channel:".length);
      const entry = CHANNEL_MAP[slug] || { channel: slug, title: slug };
      const res = await client.discover({ channel: entry.channel, cursor: req?.cursor || "" });
      const page = {
        title: entry.title,
        layout: "grid",
        items: res.items.map((s) => showToCard(s)),
      };
      if (res.hasMore && res.cursor) page.cursor = res.cursor;
      return page;
    }
    if (id === "rank") {
      return await handleRankCollection(client, req || {});
    }
    if (id === "filter") {
      return await handleFilterCollection(client, req || {});
    }
    if (id.startsWith("person:")) {
      return await handlePersonCollection(client, id.slice("person:".length), req || {});
    }
    if (id.startsWith("related:")) {
      return await handleRelatedCollection(client, id.slice("related:".length));
    }
    throw host.error("notFound", "未知的合集标识");
  } catch (err) {
    throw toHostError(err, "collection");
  }
}

export async function media(req) {
  const id = String(req?.id || "").trim();
  const client = makeClient();
  try {
    // The details and the season list are read at once; the list is part of
    // the answer. Once the details are in, the list gets at most
    // SEASON_LIST_WAIT_MS more: a list that is late, along with whatever
    // fallback it is trying, is cut off and the page goes without seasons.
    // The calendar notes on the seasons then get at most CALENDAR_BUDGET_MS
    // and are not cached themselves: the calendar keeps its pages in
    // host.cache, so they are put together again on every open.
    // Each calendar page takes the server about a second, so today's
    // calendar is asked for at once, unless the show is known to have a
    // single season.
    const knownList = cachedSeasonList(id);
    const calendar = knownList && knownList.length < 2 ? null : startCalendar(client);
    const detailP = client.getSeriesDetail(id);
    const listAbort = new AbortController();
    const listP = seasonList(makeClient({ signal: listAbort.signal }), id, detailP).catch((err) => {
      if (!listAbort.signal.aborted) console.log(`[hongguo] seasons of ${id} failed: ${err?.message || err}`);
      return null;
    });
    let detail;
    try {
      detail = await detailP;
    } catch (err) {
      listAbort.abort();
      calendar?.stop();
      throw err;
    }
    const { series, episodes } = detail;
    if (episodes.length === 0) {
      listAbort.abort();
      calendar?.stop();
      throw host.error("unavailable", "这部剧暂时没有可看的剧集");
    }

    let seasons;
    let timer = null;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve("late"), SEASON_LIST_WAIT_MS);
    });
    const entries = await Promise.race([listP, late]);
    clearTimeout(timer);
    if (entries === "late") {
      listAbort.abort();
      console.log(`[hongguo] seasons of ${id} are late; showing the details without them`);
    }
    if (Array.isArray(entries) && entries.length >= 2) {
      let annotated = entries;
      try {
        annotated = await announceSeasons(client, entries, {
          calendar: calendar || startCalendar(client),
        });
      } catch (err) {
        console.log(`[hongguo] season calendar of ${id} failed: ${err?.message || err}`);
      }
      seasons = annotated.map((s) => toProtocolSeason(s, s.id === series.id));
    } else {
      calendar?.stop();
    }

    const meta = [];
    if (series.playCount > 0) {
      meta.push({ label: "播放", value: formatHeat(series.playCount) });
    } else if (series.heat > 0) {
      meta.push({ label: "热度", value: formatHeat(series.heat) });
    }
    meta.push({ value: `全${episodes.length}集` });

    const badges = [];
    if (series.rightText) {
      const b = truncate(series.rightText, 8);
      if (b) badges.push(b);
    }

    const verticalCount = episodes.filter((e) => e.vertical).length;
    const aspect = verticalCount * 2 >= episodes.length ? "portrait" : "landscape";

    const out = {
      id: series.id,
      title: series.title,
      aspect,
      episodes: episodes.map((ep) => {
        const e = {
          id: ep.id,
          title: ep.title,
          aspect: ep.vertical ? "portrait" : "landscape",
        };
        if (ep.durationSeconds > 0) e.duration = ep.durationSeconds;
        const epImg = httpUrl(ep.coverUrl);
        if (epImg) e.image = epImg;
        if (ep.isNew) e.badges = ["新"];
        if (!ep.playable) e.lock = "unavailable";
        return e;
      }),
      sections: [
        {
          title: "相关推荐",
          layout: "row",
          collection: `related:${series.id}`,
        },
      ],
    };
    const img = httpUrl(series.coverUrl);
    if (img) out.image = img;
    if (series.description && series.description.trim()) {
      out.description = series.description.trim();
    }
    if (badges.length > 0) out.badges = badges;
    if (meta.length > 0) out.meta = meta;
    if (series.subtitles && series.subtitles.length > 0) out.tags = series.subtitles;
    if (seasons && seasons.length >= 2) out.seasons = seasons;
    return out;
  } catch (err) {
    throw toHostError(err, "media");
  }
}

export async function play(req) {
  const episodeId = String(req?.episodeId || "").trim();
  const client = makeClient();
  try {
    const pb = await client.resolvePlayback(episodeId);
    if (pb.audioUrl) {
      console.log(`[hongguo] play rejected for episode=${episodeId}: separate audio stream unsupported`);
      throw host.error("unavailable", "暂不支持音视频分离的作品");
    }
    let keyHex = "";
    if (pb.protected || pb.streams.some((s) => s.protected)) {
      if (!pb.keyMaterial) {
        console.log(`[hongguo] play failed for episode=${episodeId}: protected stream missing spade_a key material`);
        throw host.error("unavailable", "该集已加密，但未获取到解密密钥");
      }
      try {
        keyHex = client.contentKey({ protected: true, keyMaterial: pb.keyMaterial }).hex;
      } catch (keyErr) {
        console.log(
          `[hongguo] play failed for episode=${episodeId}: content key derivation error: ${keyErr?.message || keyErr}`
        );
        throw host.error("unavailable", "无法解密该集视频");
      }
    }

    const streams = pb.streams
      .filter((s) => httpUrl(s.url))
      .map((s) => {
        const codec = normalizeCodec(s.codec);
        const item = {
          url: s.url,
          container: s.hls ? "hls" : "mp4",
        };
        const backups = (s.backupUrls || []).filter((u) => httpUrl(u));
        if (backups.length > 0) item.backupUrls = backups;
        if (codec) item.codec = codec;
        if (s.width > 0) item.width = s.width;
        if (s.height > 0) item.height = s.height;
        if (s.bitrate > 0) item.bitrate = s.bitrate;
        if (s.protected && keyHex) {
          item.encryption = { scheme: "cenc", key: keyHex };
        }
        return item;
      });

    if (streams.length === 0) {
      console.log(`[hongguo] play failed for episode=${episodeId}: no valid http/https stream URLs`);
      throw host.error("unavailable", "没有可用的视频流");
    }

    const prefer = req?.prefer || {};
    streams.sort((a, b) => rankStreamScore(b, prefer) - rankStreamScore(a, prefer));

    // The hosts the streams come from, so a CDN outside permissions.network
    // shows up in the plugin's log.
    const hosts = new Set();
    for (const s of streams) {
      for (const u of [s.url, ...(s.backupUrls || [])]) {
        try {
          hosts.add(new URL(u).hostname);
        } catch {
          // Ignore a malformed URL.
        }
      }
    }
    console.log(`[hongguo] play episode=${episodeId}: ${streams.length} stream(s) from ${[...hosts].join(", ")}`);

    const out = { streams };
    if (pb.expiresAt > 0) out.expiresAt = pb.expiresAt;
    return out;
  } catch (err) {
    throw toHostError(err, "play");
  }
}

export async function search(req) {
  const query = String(req?.query || "").trim();
  if (!query) return { layout: "grid", items: [] };
  const client = makeClient();
  try {
    let page;
    try {
      page = await client.search(query, { cursor: req?.cursor || "" });
    } catch (err) {
      if (isErr(err, ErrCode.AnonymousLimited) || isErr(err, ErrCode.EndOfList)) {
        return { layout: "grid", items: [] };
      }
      throw err;
    }
    const out = {
      layout: "grid",
      items: page.items.map((s) => showToCard(s)),
    };
    if (page.hasMore && page.cursor) out.cursor = page.cursor;
    return out;
  } catch (err) {
    throw toHostError(err, "search");
  }
}

export async function searchHome() {
  const client = makeClient();
  try {
    const hs = await client.hotSearch();
    const sections = [];
    for (const board of hs.boards) {
      const shows = board.items
        .filter((it) => it.seriesId)
        .map((it) => ({
          id: it.seriesId,
          title: it.title,
          coverUrl: it.coverUrl,
          episodeCount: it.episodeCount,
          category: it.heat,
        }));
      if (shows.length === 0) continue;
      const filled = await fillMissingCovers(client, shows);
      sections.push({
        title: board.name || "热搜榜",
        layout: "ranked",
        items: filled.map((s) => showToCard(s)),
      });
    }
    return { sections };
  } catch (err) {
    throw toHostError(err, "searchHome");
  }
}

export async function suggest(req) {
  const query = String(req?.query || "").trim();
  if (!query) return { items: [] };
  const client = makeClient();
  try {
    const rows = await client.suggest(query);
    return { items: rows.map((r) => r.text).filter(Boolean).slice(0, 10) };
  } catch (err) {
    throw toHostError(err, "suggest");
  }
}

export async function danmaku(req) {
  const mediaId = String(req?.mediaId || "").trim();
  const episodeId = String(req?.episodeId || "").trim();
  const cursor = String(req?.cursor || "").trim();
  const client = makeClient();
  try {
    const page = await client.listDanmaku(mediaId, episodeId, { cursor });
    const items = [];
    for (const d of page.items) {
      const normalized = String(d.text || "")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .join(" ");
      const text = emojify(normalized);
      if (!text || d.offsetMs < 0) continue;
      const item = { text, time: d.offsetMs / 1000 };
      if (d.id) item.id = d.id;
      items.push(item);
    }
    const out = { items };
    if (page.hasMore && page.cursor && page.cursor !== cursor) {
      out.cursor = page.cursor;
    }
    return out;
  } catch (err) {
    throw toHostError(err, "danmaku");
  }
}

export async function refresh(req) {
  const rawIds = Array.isArray(req?.ids) ? req.ids.slice(0, 50) : [];
  if (rawIds.length === 0) return { items: [] };
  const client = makeClient();
  try {
    const details = await client.getSeriesBatch(rawIds);
    const items = details
      .filter((d) => d?.series)
      .map((d) =>
        showToCard({
          id: d.series.id,
          title: d.series.title,
          description: d.series.description,
          coverUrl: d.series.coverUrl,
          episodeCount: d.series.episodeCount || d.episodes.length,
        })
      );
    return { items };
  } catch (err) {
    throw toHostError(err, "refresh");
  }
}
