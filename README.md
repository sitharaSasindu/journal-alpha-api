# Journal Alpha API

A single Cloudflare Worker behind Journal Alpha. **It never sees, stores or
relays a user's journal** - no trades, notes, screenshots or balances. Those go
browser-to-Drive directly. No cookies, no session auth.

It stores two things, and both are exceptions worth naming up front:

- **KV**: copies of the public Forex Factory calendar feed, current week plus a
  three-month archive. Not user data. See [What it stores](#what-it-stores).
- **D1**: one row per Google account that has connected Drive - email, display
  name, first and last seen day. **That is personal data**, and a deliberate
  reversal of an earlier decision to keep none. See
  [Sign-in records](#sign-in-records).

## What changed, and why

Worth reading before adding anything here, because this Worker has already
argued both sides of the same question.

It originally served `POST /api/v1/profiles`, which upserted each signing-in
user's **email, name, picture and a login counter** into a D1 table called
`journal-alpha-db`. That endpoint, its binding and its migration were all
deleted: a server-side user profile contradicted the product's central claim,
the app never called it anyway, and a dormant endpoint with a database behind
it is still a place user data can end up.

It was then asked for again - knowingly, with the privacy trade-off on the
table - because there was no way to answer *how many people use this*. So
`POST /session` exists now, writing to a **new and separate** database,
`journal-alpha-users`, rather than reviving the old one. It is narrower than
what was removed: no picture, dates instead of timestamps, and a counter that
moves once a day. The difference that matters is not the schema, though - it is
that the privacy page now *states* what is kept instead of denying anything is.

**If the old `journal-alpha-db` still exists, delete it** - dropping a binding
never drops the data, and it may still hold profiles from the original version:

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
| `POST /session` | Records that an account signed in. The one route that stores personal data |

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

## Sign-in records

`POST /session` takes **one field, a Google ID token**, and writes one row per
account:

```json
{ "credential": "<Google ID token JWT>" }
```

| Column | Holds | Source |
| --- | --- | --- |
| `id` | Google's stable `sub` for the account | verified token |
| `email` | Lower-cased address; empty if `email_verified` is false | verified token |
| `name` | Google display name | verified token |
| `first_seen` | The day it first connected. Written once, never updated | server clock |
| `last_seen` | The most recent day it was seen | server clock |
| `active_days` | Distinct days seen - not raw sign-ins | counter |

**Every stored value comes from Google, not from the caller.** The relay posts
the token to `https://oauth2.googleapis.com/tokeninfo`, which checks the
signature, and then requires:

- `aud` equal to `GOOGLE_CLIENT_ID` - **the check that makes this table ours.**
  A valid signature only proves Google issued the token to *somebody*; without
  this, any site with a Google login could forward its users' tokens here.
- `iss` of `accounts.google.com`
- `exp` in the future, and a present `sub`

Signature checking is delegated rather than done against Google's JWKS here.
Both are correct; at one request per user per day the network call costs
nothing, while hand-rolled RS256 is somewhere for a subtle verification bug to
live. To switch later, cache `https://www.googleapis.com/oauth2/v3/certs` and
verify locally - the claim checks above do not change.

The Drive **access** token is never accepted and there is no endpoint that
would take it. It carries `drive.appdata`, so a server holding it could read
the caller's journal; an ID token grants no API access at all, which is exactly
why it is the thing to send.

Dates, not timestamps, and no IP address, user agent, referrer or page view.
The client reports at most once a day, and the Worker only increments
`active_days` when the day actually changes, so reloading the page twenty times
counts once.

**This is personal data, and it reverses the decision documented above.** The
endpoint that was deleted stored email, name, *picture* and a raw login counter;
this one is narrower, its figures are verified rather than asserted, and its
existence is stated on the app's privacy page rather than denied. What has not
changed is the part that matters: no trade, note, screenshot or balance ever
reaches this Worker.

### Reading the numbers

Cloudflare dashboard → **Workers & Pages → D1 → journal-alpha-users →
Console**. Every query below was run against a seeded copy of this schema.

```sql
-- How many people have ever signed in.
SELECT COUNT(*) AS total_users FROM users;

-- Signups per day, newest first.
SELECT first_seen AS day, COUNT(*) AS new_users
FROM users GROUP BY day ORDER BY day DESC LIMIT 30;

-- Signups per month.
SELECT substr(first_seen, 1, 7) AS month, COUNT(*) AS signups
FROM users GROUP BY month ORDER BY month;

-- Active recently.
SELECT COUNT(*) AS active_7d  FROM users WHERE last_seen >= date('now', '-7 day');
SELECT COUNT(*) AS active_30d FROM users WHERE last_seen >= date('now', '-30 day');

-- Everyone, most recently seen first.
SELECT email, name, first_seen, last_seen, active_days
FROM users ORDER BY last_seen DESC;

-- Signed up but stopped coming back.
SELECT email, first_seen, last_seen, active_days
FROM users WHERE last_seen < date('now', '-30 day') ORDER BY last_seen;

-- One account.
SELECT * FROM users WHERE email = 'someone@example.com';
```

### Deleting someone's record

Somebody asking to be forgotten is asking about this table - erasing their
device and their Drive folder does not touch it. The app's Settings page tells
them to email you, so this is the query behind that promise:

```sql
DELETE FROM users WHERE email = 'someone@example.com';
```

They will reappear as a new signup the next time they connect, with today's
date as `first_seen`.

### Turning it off

Clear `VITE_USAGE_ENDPOINT` in `journal-alpha/.env` and redeploy the frontend.
The app then makes no request that identifies anybody. The endpoint here keeps
working but nothing calls it; drop the `[[d1_databases]]` binding and delete the
database to remove the data as well.

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

**This Worker must never gain an endpoint that accepts journal data.** Trades,
notes, screenshots, balances, reviews: none of it may pass through here, ever.
Sync goes browser-to-Drive directly and must stay that way, because that is the
entire product and the only claim that cannot be walked back.

Two things are stored, and the difference between them and the line above is
the difference between knowing *that* somebody uses the app and knowing *what
they trade*:

- The calendar in KV is a public file anyone can download, keyed by week, with
  no request metadata and nothing per-user.
- The sign-in table in D1 identifies people by email. It was added knowingly,
  after the opposite decision had been made and documented here, because
  counting users turned out to be worth it. It holds identity and dates and
  nothing else - and any proposal to add "just one more column" about what a
  user *did* is the thing this section exists to refuse.

## Terms

The calendar data belongs to Forex Factory. Relaying their public file to your
own users with a short cache is the mild end of their restrictions on
redistribution, but read their terms before running this publicly at scale.
Keeping three months of it is a step further than a cache, so that goes double.

## Cost

Cloudflare's free tier is 100,000 requests a day and 1,000 KV writes a day.
This relay writes a handful of keys per upstream fetch - at most a few dozen a
day - and serves everything else from reads.
