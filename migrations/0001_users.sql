-- Sign-in records.
--
-- One row per Google account that has ever connected Drive. This is the only
-- table, and it is deliberately the smallest thing that answers the three
-- questions it was created for: how many people use the app, when each of them
-- first appeared, and when they were last seen.
--
-- It holds personal data - an email address and a display name - which is a
-- reversal of an earlier decision to store none. See the README. Nothing about
-- a user's *journal* is here or ever can be: no trades, no accounts, no notes.
-- Those still go browser-to-Drive and never pass through the Worker.
--
-- What is deliberately NOT stored: IP addresses, user agents, referrers,
-- session times, page views, or anything about what a user did after signing
-- in. The Worker sees the IP of every request, as every HTTP server does, but
-- it is never written down.

CREATE TABLE IF NOT EXISTS users (
  -- The `sub` claim from the Google ID token: Google's stable, opaque,
  -- per-application id for the account. Unchanged when somebody renames
  -- themselves or moves to a new address, so neither reads as a new signup.
  --
  -- It comes out of a verified signature rather than out of the request body.
  -- Nothing the browser asserts is stored: the relay checks the token's
  -- signature and audience with Google and reads the identity from the claims.
  id TEXT PRIMARY KEY,

  -- Both read from the verified token. `email` is left empty rather than
  -- recorded when Google reports `email_verified` false, since an unconfirmed
  -- address is not evidence that it belongs to the person holding the account.
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',

  -- Dates, not timestamps. "First registered day" and "last logged in day" are
  -- the questions being asked, and a date cannot be used to reconstruct
  -- somebody's working hours the way a precise timestamp can.
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,

  -- Distinct days this account has been seen, not raw sign-in count. The
  -- client reports at most once a day and the Worker only increments when the
  -- day actually changes, so this cannot be inflated by reloading the page.
  active_days INTEGER NOT NULL DEFAULT 1
);

-- Both indexes exist for the dashboard queries in the README: new users by
-- day, and who has been active recently.
CREATE INDEX IF NOT EXISTS idx_users_first_seen ON users (first_seen);
CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users (last_seen);
