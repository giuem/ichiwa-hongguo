// Multi-season normalization and 上新 calendar annotation
// (ported from ichiwa internal/catalog/seasons.go).

const CALENDAR_DAYS = 7;
const CALENDAR_PAGES = 3;
const CALENDAR_CACHE_TTL_SEC = 600;
const CALENDAR_CACHE_PREFIX = "hongguo_cal:";
export const CALENDAR_BUDGET_MS = 1000;

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

function readCachedDay(day) {
  const cacheKey = CALENDAR_CACHE_PREFIX + (day || "today");
  try {
    const cached = host.cache.get(cacheKey);
    if (cached) return JSON.parse(cached);
  } catch {
    // Ignore cache parse error.
  }
  return null;
}

function writeCachedDay(day, result) {
  const cacheKey = CALENDAR_CACHE_PREFIX + (day || "today");
  try {
    host.cache.set(cacheKey, JSON.stringify(result), CALENDAR_CACHE_TTL_SEC);
  } catch {
    // Ignore cache quota error.
  }
}

async function fetchCalendarDay(client, day, signal) {
  const cached = readCachedDay(day);
  if (cached) {
    return { result: cached, complete: true, fromCache: true };
  }
  if (signal?.aborted) {
    return { result: null, complete: false, fromCache: false };
  }

  let page;
  try {
    page = await client.newReleases({ date: day, signal });
  } catch {
    return { result: null, complete: false, fromCache: false };
  }

  const result = {
    date: page.date,
    dates: page.dates,
    items: [...page.items],
  };

  let complete = true;
  for (let i = 0; i < CALENDAR_PAGES - 1; i++) {
    if (!page.hasMore || !page.cursor) break;
    if (signal?.aborted) {
      complete = false;
      break;
    }
    try {
      page = await client.newReleases({ cursor: page.cursor, signal });
      result.items.push(...page.items);
    } catch {
      complete = false;
      break;
    }
  }

  // Only cache a day when all pages (up to CALENDAR_PAGES) completed cleanly.
  if (complete && !signal?.aborted) {
    writeCachedDay(day, result);
  }
  return { result, complete, fromCache: false };
}

export async function announceSeasons(client, seasons, options = {}) {
  const out = seasons.map((s) => ({ ...s }));
  let pending = [];
  for (let i = 0; i < out.length; i++) {
    if (!out[i].online || i === out.length - 1) {
      pending.push(i);
    }
  }
  if (pending.length === 0) return out;

  const budgetMs =
    typeof options.budgetMs === "number" && options.budgetMs > 0
      ? options.budgetMs
      : CALENDAR_BUDGET_MS;

  const controller = new AbortController();
  const { signal } = controller;
  let timedOut = false;
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve("timeout");
    }, budgetMs);
  });

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

  try {
    const todayRes = await Promise.race([
      fetchCalendarDay(client, "", signal),
      deadline.then(() => null),
    ]);
    if (!todayRes || !todayRes.result) {
      if (timedOut) {
        console.log(`[hongguo] season calendar timed out after ${budgetMs}ms`);
      }
      return out;
    }
    const today = todayRes.result;
    look(today.items);
    if (pending.length === 0 || signal.aborted) {
      return out;
    }

    const days = [];
    const seenDays = new Set();
    for (const online of [false, true]) {
      if (!waiting(online)) continue;
      for (const day of calendarDates(today.dates, today.date, online)) {
        if (!seenDays.has(day)) {
          seenDays.add(day);
          days.push(day);
        }
      }
    }

    const uncached = [];
    for (const day of days) {
      const cached = readCachedDay(day);
      if (cached) {
        look(cached.items);
        if (pending.length === 0) return out;
      } else {
        uncached.push(day);
      }
    }

    const toFetch = uncached.filter((day) => waiting(day < today.date));
    if (toFetch.length === 0 || signal.aborted) {
      return out;
    }

    const tasks = toFetch.map((day) =>
      fetchCalendarDay(client, day, signal).then((res) => {
        if (res?.result?.items?.length) {
          look(res.result.items);
          if (pending.length === 0 && !signal.aborted) {
            controller.abort();
          }
        }
      })
    );
    await Promise.race([Promise.allSettled(tasks), deadline]);
    if (timedOut) {
      console.log(`[hongguo] season calendar budget (${budgetMs}ms) reached with ${pending.length} pending`);
    }
    return out;
  } finally {
    if (timer !== null && typeof clearTimeout === "function") {
      clearTimeout(timer);
    }
  }
}
