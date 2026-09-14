/**
 * Journal Alpha API.
 *
 * One rule governs this whole Worker: **it never sees, stores, or relays a
 * user's journal.** It exists only to fetch public reference data that a
 * browser is not allowed to fetch for itself, and to hand it back with a CORS
 * header. There are no cookies and no auth.
 *
 * What it does keep, in KV, is copies of that public file: the current week,
 * and an archive of the weeks before it. That is not user data - it is the
 * same file anyone can download from Forex Factory - and none of it is
 * attributable to a person.
 *
 * That rule is why the previous version of this file is gone. It had one
 * endpoint, `POST /api/v1/profiles`, which upserted each signing-in user's
 * email, name, picture and a login counter into a D1 table. That is a
 * server-side user profile, and the product's central claim is that no such
 * thing exists. The app never called it; it is deleted rather than left
 * dormant, because a dormant endpoint with a database behind it is still a
 * place where user data can end up.
 *
 * What remains:
 *
 *   GET /health                 liveness, the routes on offer, archive depth
 *   GET /calendar?week=this     the public economic calendar for this week
 *   GET /calendar?range=archive every week still held, merged and sorted
 *
 * Why /calendar has to exist at all: Forex Factory's weekly feeds are free and
 * public, but their servers send no `Access-Control-Allow-Origin` header, so a
 * browser refuses to read them from a page. Verified against
 * `nfs.faireconomy.media` and `cdn-nfs.faireconomy.media`, for the XML and the
 * JSON variants, with CORS-open controls passing in the same run. Something
 * server-side has to re-serve that file, and this is it.
 *
 * This Worker does see the IP address of each request, as every HTTP server
 * does. That is the honest cost of the feature and it is stated on the
 * calendar page.
 */

/*
 * Only the current week is published.
 *
 * `ff_calendar_nextweek` and `ff_calendar_lastweek` were tried and both return
 * 404, for the JSON and the XML - so were the month variants. Scraping
 * `forexfactory.com/calendar` instead would gain nothing: that page renders
 * exactly the events this feed carries - checked event for event against a
 * capture of the same week, down to the all-day BRICS Summit row and the three
 * red CAD CPI releases - and an HTML scrape breaks whenever they restyle it.
 *
 * The way to cover more than one week is therefore to accumulate: every fetch
 * is filed under the week it belongs to, and old weeks stay until they age out.
 */
const UPSTREAM = {
  this: "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
};

/** How long a fetched week is served without going back upstream. */
const TTL_SECONDS = 1800;

/**
 * How long a known-good copy is kept as a fallback.
 *
 * Far longer than the TTL on purpose. The upstream rate limits hard - two
 * requests in quick succession from one address already return an HTML
 * "Rate Limited" page, and at least once with a 200 status. A slightly stale
 * calendar beats an error, and a week's events do not change minute to minute.
 */
const STALE_SECONDS = 86_400;

/**
 * How long an archived week lives, and how many are kept.
 *
 * Three months, which is the retention this archive was asked for. Expiry does
 * the deleting: KV drops a key when its TTL runs out, so the oldest week
 * leaves on its own - there is no cleanup job to run and nothing to go wrong
 * if this Worker is idle for a while. `ARCHIVE_WEEKS` then trims whatever
 * survives the arithmetic, so a listing can never grow without bound.
 */
const ARCHIVE_TTL_SECONDS = 100 * 86_400;
const ARCHIVE_WEEKS = 13;

/**
 * Resolves the CORS origin.
 *
 * An allowlist rather than `*`, so this Worker cannot be quietly adopted as a
 * free open proxy by other sites. `ALLOWED_ORIGINS` is set in wrangler.toml.
 */
function allowOrigin(request, env) {
  const origin = request.headers.get("origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  if (!allowed.length) return origin || "*";
  return allowed.includes(origin) ? origin : allowed[0];
}

const corsHeaders = (origin) => ({
  "access-control-allow-origin": origin,
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-max-age": "86400",
  vary: "origin",
});

const json = (body, status, origin, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": status === 200 ? `public, max-age=${TTL_SECONDS}` : "no-store",
      ...corsHeaders(origin),
      ...extra,
    },
  });

export default {
  /**
   * @param {Request} request
   * @param {{ ALLOWED_ORIGINS?: string; CALENDAR_CACHE?: KVNamespace }} env
   * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
   */
  async fetch(request, env, ctx) {
    const origin = allowOrigin(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET") {
      return json({ error: "Only GET is supported." }, 405, origin);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" || path === "/") {
      return health(env, origin);
    }

    if (path === "/calendar" || path === "/api/v1/calendar") {
      return url.searchParams.get("range") === "archive"
        ? archive(env, origin, ctx)
        : calendar(url, env, origin, ctx);
    }

    return json({ error: `No route for ${path}.` }, 404, origin);
  },

  /**
   * Keeps the archive filling itself.
   *
   * Without this, a week is archived only if somebody happens to open the page
   * during it - so a quiet week leaves a hole that can never be filled, because
   * the upstream publishes no past weeks at all. The schedule is in
   * wrangler.toml and costs one upstream fetch a day.
   */
  async scheduled(_event, env, ctx) {
    if (!env.CALENDAR_CACHE) return;
    const result = await fetchEventsWithReason(UPSTREAM.this);
    if (!Array.isArray(result.events)) return;
    await fileWeeks(env.CALENDAR_CACHE, result.events);
    ctx.waitUntil(prune(env.CALENDAR_CACHE));
  },
};

async function health(env, origin) {
  let weeks = [];
  if (env.CALENDAR_CACHE) {
    try {
      const listed = await env.CALENDAR_CACHE.list({ prefix: "week:" });
      weeks = listed.keys.map((k) => k.name.slice(5)).sort();
    } catch {
      /* liveness must not depend on KV */
    }
  }
  return json(
    {
      ok: true,
      stores: "public calendar data only, never user data",
      retention: `${ARCHIVE_WEEKS} weeks`,
      archivedWeeks: weeks,
      routes: ["/health", "/calendar?week=this", "/calendar?range=archive"],
    },
    200,
    origin,
  );
}

/**
 * Serves the current week, cached in KV.
 *
 * KV rather than the Cache API, for a measured reason: `caches.default` in
 * Workers is per-colocation. Requests land in whichever colo is nearest, each
 * with its own cold cache, so most calls fell through to the upstream and were
 * throttled - eight consecutive calls succeeded twice, and no colo ever held a
 * stale copy to fall back on. KV is account-global, so one upstream fetch
 * every 30 minutes serves every visitor from every location.
 *
 * Three kinds of entry are kept:
 *   fresh:<week>   what to serve, expiring after TTL_SECONDS
 *   last:<week>    the last good copy, kept for STALE_SECONDS
 *   week:<sunday>  the archive, kept for ARCHIVE_TTL_SECONDS
 *
 * The second is what makes this reliable. The upstream throttles
 * intermittently, so any given fetch can fail; with a day-long spare copy that
 * becomes invisible instead of an error.
 */
async function calendar(url, env, origin, ctx) {
  const week = url.searchParams.get("week") || "this";
  const upstream = UPSTREAM[week];
  if (!upstream) {
    return json(
      { error: `Unknown week "${week}". Only "this" is published upstream.` },
      400,
      origin,
    );
  }

  const kv = env.CALENDAR_CACHE;
  const freshKey = `fresh:${week}`;
  const lastKey = `last:${week}`;

  if (kv) {
    const cached = await kv.get(freshKey, "json");
    if (cached) return json(cached, 200, origin, { "x-cache": "hit" });

    /*
     * Stale while revalidating.
     *
     * KV is eventually consistent, so a colo can miss `fresh` for up to a
     * minute after a write, and its own fetch may then hit the throttle. With
     * this, a visitor in that position gets last night's copy instantly and
     * the refresh happens after the response is sent - which turns the last
     * remaining failure mode into a slightly older calendar. Measured before
     * this: 10 of 12 calls succeeded; the two that failed had no fresh key and
     * a throttled upstream at the same moment.
     */
    const last = await kv.get(lastKey, "json");
    if (last) {
      ctx.waitUntil(revalidate(kv, upstream, week, freshKey, lastKey));
      return json(last, 200, origin, { "x-cache": "stale-revalidating" });
    }
  }

  const result = await fetchEventsWithReason(upstream);
  const events = result.events;
  const lastWhy = result.why;

  if (!Array.isArray(events)) {
    if (kv) {
      const stale = await kv.get(lastKey, "json");
      if (stale) {
        return json({ ...stale, stale: true, note: lastWhy }, 200, origin, {
          "x-cache": "stale",
        });
      }
    }
    return json({ error: lastWhy }, 502, origin);
  }

  const payload = { week, fetchedAt: new Date().toISOString(), events };

  if (kv) {
    ctx.waitUntil(
      Promise.all([
        kv.put(freshKey, JSON.stringify(payload), { expirationTtl: TTL_SECONDS }),
        kv.put(lastKey, JSON.stringify(payload), { expirationTtl: STALE_SECONDS }),
        fileWeeks(kv, events).then(() => prune(kv)),
      ]),
    );
  }

  return json(payload, 200, origin, { "x-cache": "miss" });
}

/**
 * Serves every week still held, merged into one list.
 *
 * Read straight out of the archive with no upstream call: everything in it was
 * fetched while it was current, and a past week does not change. The current
 * week is in there too - refiled on every fetch - so this single response
 * covers the whole retained range.
 */
async function archive(env, origin, ctx) {
  const kv = env.CALENDAR_CACHE;
  if (!kv) {
    return json({ error: "No archive is configured on this relay." }, 503, origin);
  }

  const listed = await kv.list({ prefix: "week:" });
  const keys = listed.keys
    .map((k) => k.name)
    .sort()
    .slice(-ARCHIVE_WEEKS);

  const stored = await Promise.all(keys.map((k) => kv.get(k, "json")));

  /*
   * De-duplicated on the way out.
   *
   * A week is refiled every time it is fetched, so the same release can sit in
   * more than one archived copy. The later one wins, because it is the one
   * with the actual figure filled in rather than just a forecast.
   */
  const byId = new Map();
  for (const held of stored) {
    for (const e of held?.events || []) {
      byId.set(`${e.country}|${e.date}|${e.title}`, e);
    }
  }

  const events = [...byId.values()].sort((a, b) =>
    String(a.date).localeCompare(String(b.date)),
  );

  /*
   * A cold archive still has to answer with something. The first visitor after
   * a deploy would otherwise get an empty calendar purely because nothing has
   * been filed yet, so fetch the current week and file it on the way out.
   */
  if (!events.length) {
    const result = await fetchEventsWithReason(UPSTREAM.this);
    if (!Array.isArray(result.events)) return json({ error: result.why }, 502, origin);
    ctx.waitUntil(fileWeeks(kv, result.events));
    return json(
      {
        range: "archive",
        weeks: [],
        fetchedAt: new Date().toISOString(),
        events: result.events,
      },
      200,
      origin,
      { "x-cache": "cold" },
    );
  }

  return json(
    {
      range: "archive",
      weeks: keys.map((k) => k.slice(5)),
      fetchedAt: new Date().toISOString(),
      events,
    },
    200,
    origin,
    { "x-cache": "archive" },
  );
}

/**
 * Files a batch of events under the week each one belongs to.
 *
 * Keyed off the event's own date rather than the time of the fetch, so a
 * Sunday and Saturday edges of a feed land in the right week and a refetch
 * overwrites the same key instead of creating a near-duplicate beside it.
 */
async function fileWeeks(kv, events) {
  const weeks = new Map();
  for (const e of events) {
    const start = weekStart(e.date);
    if (!start) continue;
    const list = weeks.get(start);
    if (list) list.push(e);
    else weeks.set(start, [e]);
  }

  await Promise.all(
    [...weeks.entries()].map(([start, list]) =>
      kv.put(
        `week:${start}`,
        JSON.stringify({ week: start, fetchedAt: new Date().toISOString(), events: list }),
        { expirationTtl: ARCHIVE_TTL_SECONDS },
      ),
    ),
  );
}

/**
 * Drops archived weeks beyond the retention window, oldest first.
 *
 * Expiry already removes them unattended; this is here so a listing stays
 * bounded if the TTL is ever raised, and so the retention rule is visible in
 * the code that enforces it rather than only in a constant.
 */
async function prune(kv) {
  const listed = await kv.list({ prefix: "week:" });
  const keys = listed.keys.map((k) => k.name).sort();
  const excess = keys.slice(0, Math.max(0, keys.length - ARCHIVE_WEEKS));
  await Promise.all(excess.map((k) => kv.delete(k)));
}

/**
 * The start of the week a feed date falls in, as `YYYY-MM-DD`.
 *
 * Sunday, because that is the week the feed publishes: one file covers
 * "Sep 13 - Sep 19", a Sunday to a Saturday. Keying on Monday instead split
 * every fetch across two archive entries and left the Sunday filed under the
 * previous week, which made a single week's file look like two partial ones.
 */
function weekStart(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  // Worked in UTC so the key does not depend on where this ran.
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  utc.setUTCDate(utc.getUTCDate() - utc.getUTCDay()); // getUTCDay() is 0 on Sunday
  return utc.toISOString().slice(0, 10);
}

/**
 * Refetches a week after the response has already been sent.
 *
 * Failure here is silent on purpose: the visitor already has a usable
 * calendar, and the next request will try again.
 */
async function revalidate(kv, upstream, week, freshKey, lastKey) {
  const events = await fetchEvents(upstream);
  if (!events) return;
  const payload = { week, fetchedAt: new Date().toISOString(), events };
  await Promise.all([
    kv.put(freshKey, JSON.stringify(payload), { expirationTtl: TTL_SECONDS }),
    kv.put(lastKey, JSON.stringify(payload), { expirationTtl: STALE_SECONDS }),
    fileWeeks(kv, events),
  ]);
}

/**
 * Fetches and validates one week, with a short retry.
 *
 * The throttling is intermittent rather than sustained: measured against the
 * live endpoint, two consecutive calls were refused and the third returned all
 * 103 events seconds later. Three attempts with a short backoff turns a
 * visible error into a slightly slower load.
 *
 * Trusts the body, not the status - a rate-limited request comes back as an
 * HTML page and has been observed carrying a 200, so anything that is not a
 * non-empty array of events counts as a failure.
 */
async function fetchEventsWithReason(upstream) {
  let why = "Upstream did not answer.";

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 700 * attempt));

    let res;
    try {
      res = await fetch(upstream, {
        headers: {
          // A request with no user agent is what the upstream throttles hardest.
          "user-agent": "Mozilla/5.0 (compatible; JournalAlpha; +https://journalalpha.com)",
          accept: "application/json,text/plain,*/*",
        },
      });
    } catch (err) {
      why = `Upstream unreachable: ${err}`;
      continue;
    }

    const text = await res.text();
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed?.events;
      if (Array.isArray(list) && list.length) return { events: list, why: "" };
    } catch {
      /* falls through */
    }

    why = /rate limited/i.test(text)
      ? "Upstream rate limited this relay."
      : `Upstream returned ${res.status} and no event array.`;
  }

  return { events: null, why };
}

const fetchEvents = async (upstream) => (await fetchEventsWithReason(upstream)).events;
