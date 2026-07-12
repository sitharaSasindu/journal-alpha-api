# journal-alpha-api

Cloudflare Worker + D1 API for Journal Alpha. Persists Google user profiles on sign-in and tracks login count. No billing or premium features.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/api/v1/profiles` | Verify Google access token, upsert user, increment `login_count` |

**Request body:** `{ "accessToken": "<google-oauth-access-token>" }`  
Or header: `Authorization: Bearer <token>`

**Response:** `{ "ok": true, "loginCount": 3, "firstLoginAt": "...", "lastLoginAt": "..." }`

## Setup

```bash
npm install
npm run db:create
```

Copy the `database_id` from the create output into `wrangler.toml`, then:

```bash
npm run db:migrate:local   # local dev
npm run db:migrate:remote  # production D1
npm run dev                # http://127.0.0.1:8787
npm run deploy
```

## Frontend

In Journal Alpha `index.html`, set the API base before the app loads:

```html
<script>
  window.__TJ_API_BASE__ = "https://api.journalalpha.com"; // or http://127.0.0.1:8787 for local dev
</script>
```

The SPA calls `POST /api/v1/profiles` after Google sign-in (non-blocking; app works if API is down).

## CORS

Edit `ALLOWED_ORIGINS` in `wrangler.toml` to include your Pages/production URLs.

## Deploy to another Cloudflare account

Each account has its own D1 database and Worker. The `database_id` in `wrangler.toml` is tied to one account only.

1. **Switch Wrangler login**

   ```bash
   npx wrangler logout
   npx wrangler login
   npx wrangler whoami
   ```

   Confirm the email and Account ID match the target account.

2. **Pin the account (recommended)**

   Uncomment and set `account_id` in `wrangler.toml` using the ID from `whoami`. This avoids accidental deploys to the wrong account if you switch logins later.

3. **Create D1 in the new account**

   ```bash
   npm run db:create
   ```

   Copy the new `database_id` into `wrangler.toml` (replace the old one).

4. **Migrate and deploy**

   ```bash
   npm run db:migrate:remote
   npm run deploy
   ```

   Note the Worker URL from the deploy output (e.g. `https://journal-alpha-api.<subdomain>.workers.dev`).

5. **Point the frontend at the new API**

   In Journal Alpha `index.html`, set:

   ```html
   window.__TJ_API_BASE__ = "https://journal-alpha-api.<subdomain>.workers.dev";
   ```

   Then run `node materialize-spa-routes.mjs` in the journal-alpha repo.

6. **Custom domain (optional)**

   In the new Cloudflare account: Workers → journal-alpha-api → Settings → Domains & Routes → add e.g. `api.journalalpha.com`, then use that URL for `__TJ_API_BASE__`.

**Current account (for reference):** logged in as `sitharabc@gmail.com`, D1 id `ba5b125d-1377-48b6-8a2c-1c33052adc2f`. Leave that id in place only if you keep using that account; use a fresh id after switching accounts.
