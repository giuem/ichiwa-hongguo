// Multi-season normalization and 上新 calendar annotation
// (ported from ichiwa internal/catalog/seasons.go).

const CALENDAR_DAYS = 7;
const CALENDAR_PAGES = 3;
const CALENDAR_CACHE_TTL_SEC = 600;
const CALENDAR_CACHE_PREFIX = "hongguo_cal:";

export function seasonsOf(rawSeasons) {
  const seen = new Set();
  const out = [];
  for (const s of rawSeasons || []) {
    const id = s.seriesId || s.id || "";
    if (!id || id === "0" || seen.has(id)) continue;
    seen.add(id);
    const episodes = Number(s.episodeCount) || 0;
    out.push({
      id,
      title: s.title || "",
      coverUrl: s.coverUrl || "",
      description: s.description || "",
      episodeCount: episodes,
      index: Number(s.index) || 0,
      online: episodes > 0,
      isNew: false,
      note: "",
      heat: "",
    });
  }
  out.sort((a, b) => {
    if (a.index === 0 || b.index === 0) {
      if (a.index === b.index) return 0;
      return a.index !== 0 ? -1 : 1; // unnumbered last
    }
    return a.index - b.index;
  });
  let prev = 0;
  for (const s of out) {
    if (s.index <= prev) {
      s.index = prev + 1;
    }
    prev = s.index;
  }
  return out;
}

export function normTitle(t) {
  return String(t || "").replace(/[ 　·・：:（）()《》]/g, "");
}

export function matchRelease(items, season) {
  for (const r of items || []) {
    if (r.seriesId === season.id) return r;
  }
  const title = normTitle(season.title);
  if (!title) return null;
  for (const r of items || []) {
    if (normTitle(r.title) === title) return r;
  }
  return null;
}

// Format a Unix-second timestamp in Asia/Shanghai (UTC+8) without relying on ICU tz tables.
function formatShanghaiDate(unixSec, includeTime = false) {
  const d = new Date((unixSec + 8 * 3600) * 1000);
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (!includeTime) {
    return `${month}月${day}日`;
  }
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hh}:${mm}`;
}

export function annotateSeason(season, release) {
  season.heat = release.heat || "";
  if (!season.coverUrl && release.coverUrl) {
    season.coverUrl = release.coverUrl;
  }
  if (!season.description && release.description) {
    season.description = release.description;
  }
  if (release.online) {
    season.isNew = true;
    if (release.publishAt > 0) {
      season.note = `${formatShanghaiDate(release.publishAt, false)}上新`;
    }
    return;
  }
  if (release.note) {
    season.note = release.note;
  } else if (release.publishAt > 0) {
    season.note = `预计${formatShanghaiDate(release.publishAt, true)}上线`;
  }
}

export function calendarDates(dates, today, online) {
  const out = [];
  for (const d of dates || []) {
    if (d === today || d.length !== 8) continue;
    if (online === (d < today)) {
      out.push(d);
    }
  }
  out.sort();
  if (online) out.reverse(); // yesterday first
  return out.slice(0, CALENDAR_DAYS);
}

async function fetchCalendarDay(client, day) {
  const cacheKey = CALENDAR_CACHE_PREFIX + (day || "today");
  try {
    const cached = host.cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Ignore cache parse error.
  }

  let page = await client.newReleases({ date: day });
  const result = {
    date: page.date,
    dates: page.dates,
    items: [...page.items],
  };
  for (let i = 0; i < CALENDAR_PAGES - 1; i++) {
    if (!page.hasMore || !page.cursor) break;
    try {
      page = await client.newReleases({ cursor: page.cursor });
      result.items.push(...page.items);
    } catch {
      break;
    }
  }
  try {
    host.cache.set(cacheKey, JSON.stringify(result), CALENDAR_CACHE_TTL_SEC);
  } catch {
    // Ignore cache quota error.
  }
  return result;
}

export async function announceSeasons(client, seasons) {
  const out = seasons.map((s) => ({ ...s }));
  let pending = [];
  for (let i = 0; i < out.length; i++) {
    if (!out[i].online || i === out.length - 1) {
      pending.push(i);
    }
  }
  if (pending.length === 0) return out;

  let today;
  try {
    today = await fetchCalendarDay(client, "");
  } catch {
    return out;
  }

  const look = (items) => {
    pending = pending.filter((idx) => {
      const r = matchRelease(items, out[idx]);
      if (r) {
        annotateSeason(out[idx], r);
        return false;
      }
      return true;
    });
  };
  const waiting = (online) => pending.some((idx) => out[idx].online === online);

  look(today.items);
  for (const online of [false, true]) {
    for (const day of calendarDates(today.dates, today.date, online)) {
      if (!waiting(online)) break;
      try {
        const d = await fetchCalendarDay(client, day);
        look(d.items);
      } catch {
        // Skip failed calendar day.
      }
    }
  }
  return out;
}
