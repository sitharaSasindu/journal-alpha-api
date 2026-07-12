/**
 * Journal Alpha API: Google sign-in profiles stored in Cloudflare D1.
 * @param {Request} request
 * @param {{ DB?: D1Database; ALLOWED_ORIGINS?: string }} env
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const origin = request.headers.get("Origin") || "";
    const allowed = parseAllowedOrigins(env.ALLOWED_ORIGINS);

    if (request.method === "OPTIONS") {
      return corsPreflight(request, allowed, origin);
    }

    const cors = buildCorsHeaders(allowed, origin);

    if (path === "/health" && request.method === "GET") {
      return json(200, { ok: true, service: "journal-alpha-api", store: "d1" }, cors);
    }

    if (path === "/api/v1/profiles" && request.method === "POST") {
      return handleProfiles(request, env, cors);
    }

    return json(404, { error: "not_found" }, cors);
  },
};

/** @param {string | undefined} raw */
function parseAllowedOrigins(raw) {
  return new Set(
    (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * @param {Set<string>} allowed
 * @param {string} origin
 * @returns {Headers}
 */
function buildCorsHeaders(allowed, origin) {
  const h = new Headers();
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  h.set("Access-Control-Max-Age", "86400");
  if (origin && allowed.has(origin)) {
    h.set("Access-Control-Allow-Origin", origin);
  } else if (!origin) {
    h.set("Access-Control-Allow-Origin", "*");
  }
  return h;
}

/** @param {Set<string>} allowed @param {string} origin */
function corsPreflight(request, allowed, origin) {
  const reqHeaders = request.headers.get("Access-Control-Request-Headers") || "";
  const h = buildCorsHeaders(allowed, origin);
  if (reqHeaders) h.set("Access-Control-Allow-Headers", reqHeaders);
  return new Response(null, { status: 204, headers: h });
}

/**
 * @param {number} status
 * @param {object} body
 * @param {Headers} cors
 */
function json(status, body, cors) {
  const h = new Headers(cors);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}

/**
 * @param {Request} request
 * @param {Record<string, unknown>} body
 */
async function readAccessToken(request, body) {
  const auth = request.headers.get("Authorization") || "";
  const fromBody =
    typeof body?.accessToken === "string" ? String(body.accessToken).trim() : "";
  const fromBearer = auth.replace(/^Bearer\s+/i, "").trim();
  return fromBody || fromBearer;
}

/**
 * @returns {Promise<{ profile: Record<string, unknown>; sub: string } | Response>}
 */
async function verifyGoogleProfile(accessToken, cors) {
  if (!accessToken) {
    return json(400, { error: "missing_access_token" }, cors);
  }

  /** @type {Record<string, unknown>} */
  let profile;
  try {
    const u = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!u.ok) {
      return json(401, { error: "invalid_google_token" }, cors);
    }
    profile = await u.json();
  } catch {
    return json(502, { error: "google_unreachable" }, cors);
  }

  const sub = typeof profile.sub === "string" ? profile.sub.trim() : "";
  if (!sub) {
    return json(400, { error: "incomplete_profile" }, cors);
  }

  return { profile, sub };
}

/** @param {number | null | undefined} unixSec */
function unixSecToIso(unixSec) {
  if (!unixSec) return null;
  return new Date(unixSec * 1000).toISOString();
}

/**
 * POST /api/v1/profiles — upsert user profile and increment login_count.
 * @param {Request} request
 * @param {{ DB?: D1Database }} env
 * @param {Headers} cors
 */
async function handleProfiles(request, env, cors) {
  if (!env.DB) {
    return json(503, { error: "database_not_configured" }, cors);
  }

  /** @type {Record<string, unknown>} */
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" }, cors);
  }

  const accessToken = await readAccessToken(request, body);
  const v = await verifyGoogleProfile(accessToken, cors);
  if (v instanceof Response) return v;
  const { profile, sub } = v;

  const email =
    typeof profile.email === "string" ? String(profile.email).trim() : "";
  if (!email) {
    return json(400, { error: "incomplete_profile" }, cors);
  }

  const name =
    typeof profile.name === "string"
      ? String(profile.name).trim()
      : [profile.given_name, profile.family_name]
          .filter((x) => typeof x === "string" && x)
          .join(" ")
          .trim() || "";

  const picture =
    typeof profile.picture === "string" ? String(profile.picture).trim() : null;

  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(
      `INSERT INTO users (sub, email, name, picture, login_count, first_login_at, last_login_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(sub) DO UPDATE SET
         email = excluded.email,
         name = excluded.name,
         picture = excluded.picture,
         login_count = users.login_count + 1,
         last_login_at = excluded.last_login_at,
         updated_at = excluded.updated_at`,
    )
      .bind(sub, email, name, picture || null, now, now, now)
      .run();

    const row =
      (await env.DB.prepare(
        `SELECT login_count, first_login_at, last_login_at FROM users WHERE sub = ? LIMIT 1`,
      )
        .bind(sub)
        .first()) || {};

    const loginCount =
      typeof row.login_count === "number"
        ? row.login_count
        : Number.parseInt(String(row.login_count ?? "0"), 10) || 0;

    return json(
      200,
      {
        ok: true,
        loginCount,
        firstLoginAt: unixSecToIso(
          typeof row.first_login_at === "number" ? row.first_login_at : null,
        ),
        lastLoginAt: unixSecToIso(
          typeof row.last_login_at === "number" ? row.last_login_at : null,
        ),
      },
      cors,
    );
  } catch (e) {
    console.error("[profiles] D1 error:", e);
    return json(500, { error: "persist_failed" }, cors);
  }
}
