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

function byId(items, season) {
  return (items || []).find((r) => r.seriesId === season.id) || null;
}

function byTitle(items, season) {
  const title = normTitle(season.title);
  if (!title) return null;
  return (items || []).find((r) => normTitle(r.title) === title) || null;
}

// matchRelease finds a season in one day's releases: by ID, then by title.
export function matchRelease(items, season) {
  return byId(items, season) || byTitle(items, season);
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
  if (!season.title && release.title) {
    season.title = release.title;
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

// The calendar is cached page by page, in host.cache, shared by every call:
//
//   hongguo_cal:today          {date, dates}: which day is today
//   hongguo_cal:<YYYYMMDD>     the pages of one day read so far (DayRecord)
//   hongguo_cal_cursor:<md5>   claims a cursor, so it is sent once only
//   hongguo_cal_page_ms        how long a page takes, smoothed
//
// The server keeps a session per day: a cursor sent twice, or sent and cut
// off, loses a page for good. So before a call sends a cursor it claims it
// and takes it out of the record, marking the record pending; the answer
// puts the next cursor back. A pending mark older than
// CALENDAR_PENDING_FRESH_MS is a call that was cut off: that session is
// dropped and the day read again from its first page, keeping the items
// already in. A day is complete once a page says there is no more or
// CALENDAR_PAGES pages are in. A record lives CALENDAR_CACHE_TTL_SEC from the
// first page of its session and is never extended.
//
// DayRecord: {date, dates, items, pages, next, deviceId, startedAt,
// complete, pending: {at, token} | null}
const TODAY_KEY = `${CALENDAR_CACHE_PREFIX}today`;
const CURSOR_CLAIM_PREFIX = "hongguo_cal_cursor:";
const PAGE_MS_KEY = "hongguo_cal_page_ms";
const CALENDAR_PENDING_FRESH_MS = 10_000;
// Without host.cache.add a claim is written, read back after this long, and
// held only by the last writer.
const CLAIM_SETTLE_MS = 30;

function cacheGetJSON(key) {
  try {
    const raw = host.cache.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function loadDay(date) {
  const rec = cacheGetJSON(CALENDAR_CACHE_PREFIX + date);
  return rec && Array.isArray(rec.items) ? rec : null;
}

function saveDay(rec) {
  const ttl = Math.floor(CALENDAR_CACHE_TTL_SEC - (Date.now() - rec.startedAt) / 1000);
  try {
    if (ttl <= 0) host.cache.delete(CALENDAR_CACHE_PREFIX + rec.date);
    else host.cache.set(CALENDAR_CACHE_PREFIX + rec.date, JSON.stringify(rec), ttl);
  } catch {
    // Ignore cache quota errors.
  }
}

function freshPending(rec) {
  return Boolean(rec?.pending && Date.now() - (Number(rec.pending.at) || 0) < CALENDAR_PENDING_FRESH_MS);
}

function mergeItems(a, b) {
  const out = [...a];
  const seen = new Set(a.map((r) => r.seriesId || `t:${r.title}`));
  for (const r of b) {
    const k = r.seriesId || `t:${r.title}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomToken() {
  return host.encoding.hex(host.crypto.randomBytes(8));
}

// claimCursor makes sure a cursor is sent by one call only, ever.
async function claimCursor(cursor) {
  const key = CURSOR_CLAIM_PREFIX + host.crypto.md5(cursor);
  const token = randomToken();
  try {
    if (typeof host.cache.add === "function") {
      return host.cache.add(key, token, CALENDAR_CACHE_TTL_SEC);
    }
    if (host.cache.get(key)) return false;
    host.cache.set(key, token, CALENDAR_CACHE_TTL_SEC);
    await sleep(CLAIM_SETTLE_MS);
    return host.cache.get(key) === token;
  } catch {
    return false;
  }
}

// dropPending gives up the session of a day whose cursor page this call
// sent and lost: the next read starts the day over.
function dropPending(date, token) {
  const rec = loadDay(date);
  if (rec?.pending?.token !== token) return;
  rec.pending = null;
  rec.next = "";
  saveDay(rec);
}

class Calendar {
  constructor(client) {
    this.client = client;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    // How long a page takes: the slowest page of this call, or the
    // estimate cached by earlier calls.
    this.pageMs = 0;
    this.cachedPageMs = Number(cacheGetJSON(PAGE_MS_KEY)) || 0;
    this.deadlineAt = 0;
    this.days = new Map(); // date -> {items, settled}
    this.today = null; // {date, dates}
    this.onChange = null;
    this.sending = new Map(); // token -> date of the cursor pages in flight
    this.first = new Promise((resolve) => {
      this.settleFirst = resolve;
    });
  }

  estimate() {
    return this.pageMs || this.cachedPageMs;
  }

  // canStart says whether a page can come back in time. Before the deadline
  // is set (the season list is not in yet), a cursor page is sent only when
  // a page fits in the calendar budget; a first page has no cursor to lose.
  canStart(withCursor) {
    if (this.signal.aborted) return false;
    if (!this.deadlineAt) return !withCursor || this.estimate() <= CALENDAR_BUDGET_MS;
    return this.deadlineAt - Date.now() >= this.estimate();
  }

  async timed(fn) {
    const t = Date.now();
    const out = await fn();
    const ms = Date.now() - t;
    this.pageMs = Math.max(this.pageMs, ms);
    const smoothed = this.cachedPageMs ? Math.round(this.cachedPageMs * 0.7 + ms * 0.3) : ms;
    this.cachedPageMs = smoothed;
    try {
      host.cache.set(PAGE_MS_KEY, String(smoothed), CALENDAR_CACHE_TTL_SEC);
    } catch {
      // Ignore cache errors.
    }
    return out;
  }

  day(date) {
    let d = this.days.get(date);
    if (!d) {
      d = { items: [], settled: false };
      this.days.set(date, d);
    }
    return d;
  }

  absorb(date, items) {
    const d = this.day(date);
    d.items = mergeItems(d.items, items || []);
    this.onChange?.();
  }

  settle(date) {
    if (!date) return;
    this.day(date).settled = true;
    this.onChange?.();
  }

  setToday(date, dates) {
    if (this.today || !date) return;
    this.today = { date, dates: dates || [] };
    this.settleFirst(this.today);
  }

  // readDay reads one day, today when date is "", from the cache and then
  // page by page as long as there is time. It never throws.
  async readDay(date) {
    let known = date;
    try {
      if (!known) {
        const ptr = cacheGetJSON(TODAY_KEY);
        if (ptr?.date) {
          known = ptr.date;
          this.setToday(ptr.date, ptr.dates);
        }
      }
      let rec = known ? loadDay(known) : null;
      if (rec) this.absorb(known, rec.items);
      let firstPages = 0;
      for (;;) {
        if (rec?.complete || freshPending(rec)) break; // whole, or another call reads on
        if (rec?.next && !rec.pending && rec.deviceId === this.currentDevice()) {
          if (!this.canStart(true)) break;
          const next = await this.cursorPage(known, rec.next);
          if (!next) break;
          rec = next;
          continue;
        }
        // A new session from the first page: none yet, or the last one was
        // cut off, or its cursor belongs to another device.
        if (firstPages++ > 0 || !this.canStart(false)) break;
        let page;
        try {
          page = await this.timed(() => this.client.newReleases({ date: date || "", signal: this.signal }));
        } catch {
          break;
        }
        known = page.date || known;
        if (!known) break;
        if (!date) {
          this.setToday(known, page.dates);
          try {
            host.cache.set(TODAY_KEY, JSON.stringify({ date: known, dates: page.dates }), CALENDAR_CACHE_TTL_SEC);
          } catch {
            // Ignore cache errors.
          }
        }
        this.absorb(known, page.items);
        const latest = loadDay(known);
        if (latest && (latest.complete || freshPending(latest) || (latest.next && latest.deviceId === this.currentDevice()))) {
          // Another call has a usable session for the day: keep it.
          latest.items = mergeItems(latest.items, page.items);
          saveDay(latest);
          rec = latest;
          continue;
        }
        const more = Boolean(page.hasMore && page.cursor);
        rec = {
          date: known,
          dates: page.dates || [],
          items: mergeItems(latest?.items || [], page.items),
          pages: 1,
          next: more ? page.cursor : "",
          deviceId: page.deviceId || "",
          startedAt: Date.now(),
          complete: !more,
          pending: null,
        };
        saveDay(rec);
      }
    } finally {
      if (!date && !this.today) this.settleFirst(null);
      this.settle(known);
    }
  }

  currentDevice() {
    return typeof this.client.currentDeviceId === "function" ? this.client.currentDeviceId() : "";
  }

  // cursorPage sends the cursor of a day once, and returns the day's record
  // with the page in, or null when the page cannot be had.
  async cursorPage(date, cursor) {
    if (!(await claimCursor(cursor))) return null;
    const rec = loadDay(date);
    if (!rec || rec.next !== cursor || rec.pending) return null;
    const token = randomToken();
    rec.next = "";
    rec.pending = { at: Date.now(), token };
    saveDay(rec);
    this.sending.set(token, date);
    let page;
    try {
      page = await this.timed(() =>
        this.client.newReleases({ cursor, deviceId: rec.deviceId, signal: this.signal })
      );
    } catch {
      dropPending(date, token);
      return null;
    } finally {
      this.sending.delete(token);
    }
    this.absorb(date, page.items);
    const latest = loadDay(date) || rec;
    latest.items = mergeItems(latest.items, page.items);
    if (latest.pending?.token === token) {
      latest.pending = null;
      latest.pages = (latest.pages || 1) + 1;
      const more = Boolean(page.hasMore && page.cursor) && latest.pages < CALENDAR_PAGES;
      latest.next = more ? page.cursor : "";
      latest.complete = !more;
    }
    saveDay(latest);
    return latest;
  }

  // stop cuts off every request. A cursor page cut off is lost, so its day
  // is marked to start over at once rather than look pending.
  stop() {
    this.controller.abort();
    for (const [token, date] of this.sending) dropPending(date, token);
    this.sending.clear();
  }
}

// startCalendar starts reading today's calendar at once, so that media can
// have it under way while the details and the season list are read: today's
// first page, or the next page of a day read in part by an earlier call.
// cal.first settles with today's {date, dates}, or null.
export function startCalendar(client) {
  const cal = new Calendar(client);
  cal.done = cal.readDay("");
  return cal;
}

// announceSeasons notes on the seasons that are not out yet, and on the
// latest one, when the calendar has them, giving up after budgetMs with the
// notes found so far. options.calendar is a calendar from startCalendar
// already under way; without one, today's calendar is read here.
//
// As in the Go source, the days are searched in order, today first, and a
// season is matched by ID before title within a day. A match counts for
// sure once every day before it is read whole (or will not be read in this
// call), and, for a match by title, its own day too.
export async function announceSeasons(client, seasons, options = {}) {
  const out = seasons.map((s) => ({ ...s }));
  const wanted = [];
  for (let i = 0; i < out.length; i++) {
    if (!out[i].online || i === out.length - 1) {
      wanted.push(i);
    }
  }
  const cal = options.calendar || startCalendar(client);
  if (wanted.length === 0) {
    cal.stop();
    return out;
  }

  const budgetMs =
    typeof options.budgetMs === "number" && options.budgetMs > 0
      ? options.budgetMs
      : CALENDAR_BUDGET_MS;
  let order = [];
  // match finds each wanted season's release and whether it is final.
  const match = () =>
    wanted.map((idx) => {
      let final = true;
      for (const date of order.length > 0 ? order : [...cal.days.keys()]) {
        const d = cal.days.get(date);
        const items = d?.items || [];
        const settled = Boolean(d?.settled);
        const id = byId(items, out[idx]);
        if (id) return { idx, release: id, final };
        const title = byTitle(items, out[idx]);
        if (title) return { idx, release: title, final: final && settled };
        if (!settled) final = false;
      }
      return { idx, release: null, final: final && order.length > 0 };
    });
  const unsure = (online) => match().some((m) => !m.final && out[m.idx].online === online);

  let timedOut = false;
  let timer = null;
  cal.deadlineAt = Date.now() + budgetMs;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, budgetMs);
  });

  try {
    const today = await Promise.race([cal.first, deadline]);
    if (!today || cal.signal.aborted) return out;

    order = [today.date];
    for (const online of [false, true]) {
      if (!wanted.some((idx) => out[idx].online === online)) continue;
      for (const day of calendarDates(today.dates, today.date, online)) {
        if (!order.includes(day)) order.push(day);
      }
    }
    cal.onChange = () => {
      if (match().every((m) => m.final)) cal.stop();
    };
    cal.onChange();

    // Today's pages go on in cal.done; the other days are read in order, at
    // most CALENDAR_PARALLEL of them at once, so at most CALENDAR_PARALLEL + 1
    // requests are in flight.
    const days = order.slice(1);
    let next = 0;
    const worker = async () => {
      while (next < days.length && !cal.signal.aborted) {
        const day = days[next++];
        if (!unsure(day < today.date)) {
          cal.settle(day);
          continue;
        }
        await cal.readDay(day);
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
    cal.onChange = null;
    cal.stop();
    let unmatched = 0;
    for (const m of match()) {
      if (m.release) annotateSeason(out[m.idx], m.release);
      else unmatched++;
    }
    if (timedOut && unmatched > 0) {
      console.log(`[hongguo] season calendar: ${budgetMs}ms budget spent with ${unmatched} season(s) unmatched`);
    }
  }
}
