# Journal Alpha API

A single Cloudflare Worker that relays public reference data a browser is not
allowed to fetch for itself. **It never sees, stores or relays a user's
journal.** No database, no cookies, no auth.

It does have one KV namespace, holding copies of the public Forex Factory
calendar feed. See [What it stores](#what-it-stores) - that is a deliberate
reversal of an earlier "no storage bindings at all" rule, for a measured
reason, and it changes nothing about the boundary below.

## What changed, and why

This Worker previously existed to serve `POST /api/v1/profiles`, which upserted
each signing-in user's **email, name, picture and a login counter** into a D1
table. That is a server-side user profile, and the product's central claim is
that no such thing exists. The app never called it.

Both the endpoint and the `[[d1_databases]]` binding are gone, and the
migration that created the table has been deleted. A dormant endpoint with a
database behind it is still a place user data can end up, so it was removed
rather than left switched off.

**If that database was ever deployed, delete it too** - removing the binding
does not remove the data:

```bash
npx wrangler d1 list
npx wrangler d1 delete journal-alpha-db
```

## Routes

| Route | Purpose |
| --- | --- |
| `GET /health` | Liveness, the routes on offer, and which weeks are archived |
| `GET /calendar?week=this` | The current week, refetched upstream every 30 minutes |
| `GET /calendar?range=archive` | Every week still held, merged and sorted. No upstream call |

`/api/v1/calendar` is accepted as an alias, for anyone already pointing at a
versioned path.

Only the current week is *published* upstream: `ff_calendar_nextweek` and
`ff_calendar_lastweek` both return 404, for JSON and XML alike, as do the month
variants. History therefore cannot be requested, only accumulated - which is
what the archive does.

### Why not scrape forexfactory.com/calendar instead?

Because it returns the same events. The rendered page was compared against the
feed for the same week, event for event - the all-day BRICS Summit row, the
three red CAD CPI releases, all 103 entries - and they match. An HTML scrape
would add a parser that breaks whenever the site is restyled, in exchange for
nothing. The only thing that page shows and the feed does not is *more weeks*,
and the archive covers that without scraping anything.

## What it stores

| Key | Holds | Lifetime |
| --- | --- | --- |
| `fresh:this` | The week being served | 30 minutes |
| `last:this` | The last known-good copy, for when the upstream throttles | 24 hours |
| `week:<sunday>` | One archived week, keyed by its Sunday | 100 days |

Retention is three months - thirteen weeks. **Expiry does the deleting**: KV
drops a key when its TTL runs out, so the oldest week leaves on its own with no
cleanup job to run and nothing to go wrong if the Worker is idle for a while.
`ARCHIVE_WEEKS` then trims whatever survives, so a listing cannot grow without
bound.

Weeks are keyed by the Sunday they start on, because that is the week the feed
publishes - one file covers "Sep 13 - Sep 19". Keying on Monday split every
fetch across two entries and filed the Sunday under the previous week.

A daily cron (`17 6 * * *`) files the current week even if nobody opens the
page. Without it a quiet week leaves a permanent hole, since the upstream has
no past weeks to backfill from.

None of this is user data. It is the same public file anyone can download, and
nothing in it is attributable to a person.

## Why /calendar needs to exist

Forex Factory's weekly feeds are free and public, but their servers send no
`Access-Control-Allow-Origin` header, so a browser refuses to read them from a
page. Verified:

| URL | From a browser | With curl |
| --- | --- | --- |
| `nfs.faireconomy.media/ff_calendar_thisweek.json` | blocked | 200, ~14 KB |
| `nfs.faireconomy.media/ff_calendar_thisweek.xml` | blocked | 200 |
| `cdn-nfs.faireconomy.media/...` | blocked | 200 |

CORS-open controls (`api.github.com`, `cloudflare.com/cdn-cgi/trace`) passed in
the same run, so this is the host's policy and not a network problem. There is
no way around it from a static site: something server-side has to re-serve the
file.

## Caching is a requirement, not an optimisation

The upstream rate limits hard. Two requests in quick succession from one
address already return an HTML "Rate Limited" page - observed at least once
carrying a **200** status. So the relay:

- trusts the response **body**, not the status, and treats anything that is not
  a non-empty array of events as a failure;
- retries three times with a short backoff;
- serves a known-good copy, labelled `stale`, when the upstream refuses;
- revalidates *after* responding when only the stale copy is to hand.

**KV rather than the Cache API, measured rather than assumed.**
`caches.default` in Workers is per-colocation: requests land in whichever colo
is nearest, each with its own cold cache, so most calls fell through to the
upstream and were throttled. Measured over consecutive calls:

| Approach | Succeeded |
| --- | --- |
| `caches.default` | 2 of 8 |
| KV | 10 of 12 |
| KV + stale-while-revalidate | 15 of 15 |

KV is account-global, so one upstream fetch every 30 minutes serves every
visitor from every location.

## Deploy

```bash
npm install
npx wrangler login
npm run deploy
```

Then point the app at it, in `journal-alpha/.env`:

```
VITE_CALENDAR_PROXY=https://journal-alpha-api.<subdomain>.workers.dev/calendar
```

To review relay changes before deploying them, run `npx wrangler dev` and put
the local address in `journal-alpha/.env.local`, which is gitignored:

```
VITE_CALENDAR_PROXY=http://127.0.0.1:8788/calendar
```

Leave that variable empty and the app makes **no** third-party request at all;
the calendar page says so plainly instead of showing anything. That is the
default, so a fresh clone is honest about the privacy claim without any
configuration.

## The one boundary

This Worker must never gain an endpoint that accepts journal data, and its
storage must never hold anything but public reference data. Sync goes
browser-to-Drive directly and must stay that way - that is the entire product.

The KV namespace is the single, argued exception: it holds a public file that
anyone can download, keyed by week, with no request metadata and nothing
per-user. If something here ever needs to remember something *about a user*,
that is a sign the design has gone wrong.

## Terms

The calendar data belongs to Forex Factory. Relaying their public file to your
own users with a short cache is the mild end of their restrictions on
redistribution, but read their terms before running this publicly at scale.
Keeping three months of it is a step further than a cache, so that goes double.

## Cost

Cloudflare's free tier is 100,000 requests a day and 1,000 KV writes a day.
This relay writes a handful of keys per upstream fetch - at most a few dozen a
day - and serves everything else from reads.
