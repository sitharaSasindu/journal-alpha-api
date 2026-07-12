-- User profiles after Google sign-in (Google "sub" is stable per account)
CREATE TABLE IF NOT EXISTS users (
  sub TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  picture TEXT,
  login_count INTEGER NOT NULL DEFAULT 0,
  first_login_at INTEGER,
  last_login_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users (email);
