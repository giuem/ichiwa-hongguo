// Multi-season normalization and 上新 calendar annotation
// (ported from ichiwa internal/catalog/seasons.go).

const CALENDAR_DAYS = 7;
const CALENDAR_PAGES = 3;
const CALENDAR_CACHE_TTL_SEC = 600;
const CALENDAR_CACHE_PREFIX = "hongguo_cal:";
export const CALENDAR_BUDGET_MS = 1000;
export const CALENDAR_PARALLEL = 4;

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

const NO_PACER = { canStart: () => true, timed: (fn) => fn() };

// newPacer keeps calendar reads that cannot finish in time from starting:
// once a deadline is set, a page is only asked for while the time left is
// at least as long as the slowest page so far. The server takes about a
// second a page, so a read started too late would only be cut off.
function newPacer() {
  const pacer = {
    deadlineAt: 0,
    pageMs: 0,
    canStart: () => !pacer.deadlineAt || pacer.deadlineAt - Date.now() >= pacer.pageMs,
    timed: async (fn) => {
      const t = Date.now();
      const out = await fn();
      pacer.pageMs = Math.max(pacer.pageMs, Date.now() - t);
      return out;
    },
  };
  return pacer;
}

// readDay reads one calendar day, up to CALENDAR_PAGES pages, handing each
// page's items to onPage as it arrives so a caller out of time can still use
// the pages already in. Only a day read whole is cached. It never throws.
async function readDay(client, day, signal, onPage, pacer = NO_PACER) {
  const cached = readCachedDay(day);
  if (cached) {
    onPage(cached.items, cached);
    return { result: cached, complete: true };
  }
  if (signal?.aborted || !pacer.canStart()) return { result: null, complete: false };

  let page;
  try {
    page = await pacer.timed(() => client.newReleases({ date: day, signal }));
  } catch {
    return { result: null, complete: false };
  }
  const result = { date: page.date, dates: page.dates, items: [...page.items] };
  onPage(page.items, result);

  let complete = true;
  for (let i = 0; i < CALENDAR_PAGES - 1; i++) {
    if (!page.hasMore || !page.cursor) break;
    if (signal?.aborted || !pacer.canStart()) {
      complete = false;
      break;
    }
    try {
      const cursor = page.cursor;
      page = await pacer.timed(() => client.newReleases({ cursor, signal }));
    } catch {
      complete = false;
      break;
    }
    result.items.push(...page.items);
    onPage(page.items, result);
  }
  if (complete) {
    writeCachedDay(day, result);
  }
  return { result, complete };
}

// startCalendar starts reading today's calendar at once, so that media can
// have it under way while the details and the season list are read. The
// pages land in items as they arrive; first settles with the day's dates
// once its first page is in, or with null.
export function startCalendar(client) {
  const controller = new AbortController();
  const cal = { controller, pacer: newPacer(), items: [], onItems: null, today: null };
  let settleFirst;
  cal.first = new Promise((resolve) => {
    settleFirst = resolve;
  });
  cal.done = readDay(client, "", controller.signal, (items, result) => {
    if (!cal.today) {
      cal.today = result;
      settleFirst(result);
    }
    cal.items.push(...items);
    if (cal.onItems) cal.onItems(items);
  }, cal.pacer).finally(() => settleFirst(cal.today));
  cal.stop = () => controller.abort();
  return cal;
}

// announceSeasons notes on the seasons that are not out yet, and on the
// latest one, when the calendar has them, giving up after budgetMs with the
// notes found so far. options.calendar is a calendar from startCalendar
// already under way; without one, today's calendar is read here.
export async function announceSeasons(client, seasons, options = {}) {
  const out = seasons.map((s) => ({ ...s }));
  let pending = [];
  for (let i = 0; i < out.length; i++) {
    if (!out[i].online || i === out.length - 1) {
      pending.push(i);
    }
  }
  const cal = options.calendar || startCalendar(client);
  if (pending.length === 0) {
    cal.stop();
    return out;
  }

  const budgetMs =
    typeof options.budgetMs === "number" && options.budgetMs > 0
      ? options.budgetMs
      : CALENDAR_BUDGET_MS;
  const { signal } = cal.controller;
  let timedOut = false;
  let timer = null;
  cal.pacer.deadlineAt = Date.now() + budgetMs;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      cal.stop();
      resolve(null);
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
    if (pending.length === 0) cal.stop();
  };
  const waiting = (online) => pending.some((idx) => out[idx].online === online);

  try {
    look(cal.items);
    cal.onItems = look;
    const today = await Promise.race([cal.first, deadline]);
    if (!today || pending.length === 0 || signal.aborted) {
      return out;
    }

    const days = [];
    for (const online of [false, true]) {
      if (!waiting(online)) continue;
      for (const day of calendarDates(today.dates, today.date, online)) {
        if (!days.includes(day)) days.push(day);
      }
    }

    // Read the days in order, at most CALENDAR_PARALLEL at once, matching
    // each page as it arrives.
    let next = 0;
    const worker = async () => {
      while (next < days.length && !signal.aborted && pending.length > 0) {
        const day = days[next++];
        if (!waiting(day < today.date)) continue;
        await readDay(client, day, signal, (items) => look(items), cal.pacer);
      }
    };
    const workers = [cal.done];
    for (let i = 0; i < Math.min(CALENDAR_PARALLEL, days.length); i++) {
      workers.push(worker());
    }
    await Promise.race([Promise.allSettled(workers), deadline]);
    return out;
  } finally {
    clearTimeout(timer);
    if (timedOut && pending.length > 0) {
      console.log(`[hongguo] season calendar: ${budgetMs}ms budget spent with ${pending.length} season(s) unmatched`);
    }
    cal.onItems = null;
    cal.stop();
  }
}
