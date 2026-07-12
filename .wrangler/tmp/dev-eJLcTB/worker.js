var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-gh7sO7/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/worker.js
var worker_default = {
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
  }
};
function parseAllowedOrigins(raw) {
  return new Set(
    (raw || "").split(",").map((s) => s.trim()).filter(Boolean)
  );
}
__name(parseAllowedOrigins, "parseAllowedOrigins");
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
__name(buildCorsHeaders, "buildCorsHeaders");
function corsPreflight(request, allowed, origin) {
  const reqHeaders = request.headers.get("Access-Control-Request-Headers") || "";
  const h = buildCorsHeaders(allowed, origin);
  if (reqHeaders)
    h.set("Access-Control-Allow-Headers", reqHeaders);
  return new Response(null, { status: 204, headers: h });
}
__name(corsPreflight, "corsPreflight");
function json(status, body, cors) {
  const h = new Headers(cors);
  h.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers: h });
}
__name(json, "json");
async function readAccessToken(request, body) {
  const auth = request.headers.get("Authorization") || "";
  const fromBody = typeof body?.accessToken === "string" ? String(body.accessToken).trim() : "";
  const fromBearer = auth.replace(/^Bearer\s+/i, "").trim();
  return fromBody || fromBearer;
}
__name(readAccessToken, "readAccessToken");
async function verifyGoogleProfile(accessToken, cors) {
  if (!accessToken) {
    return json(400, { error: "missing_access_token" }, cors);
  }
  let profile;
  try {
    const u = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
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
__name(verifyGoogleProfile, "verifyGoogleProfile");
function unixSecToIso(unixSec) {
  if (!unixSec)
    return null;
  return new Date(unixSec * 1e3).toISOString();
}
__name(unixSecToIso, "unixSecToIso");
async function handleProfiles(request, env, cors) {
  if (!env.DB) {
    return json(503, { error: "database_not_configured" }, cors);
  }
  let body = {};
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_json" }, cors);
  }
  const accessToken = await readAccessToken(request, body);
  const v = await verifyGoogleProfile(accessToken, cors);
  if (v instanceof Response)
    return v;
  const { profile, sub } = v;
  const email = typeof profile.email === "string" ? String(profile.email).trim() : "";
  if (!email) {
    return json(400, { error: "incomplete_profile" }, cors);
  }
  const name = typeof profile.name === "string" ? String(profile.name).trim() : [profile.given_name, profile.family_name].filter((x) => typeof x === "string" && x).join(" ").trim() || "";
  const picture = typeof profile.picture === "string" ? String(profile.picture).trim() : null;
  const now = Math.floor(Date.now() / 1e3);
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
         updated_at = excluded.updated_at`
    ).bind(sub, email, name, picture || null, now, now, now).run();
    const row = await env.DB.prepare(
      `SELECT login_count, first_login_at, last_login_at FROM users WHERE sub = ? LIMIT 1`
    ).bind(sub).first() || {};
    const loginCount = typeof row.login_count === "number" ? row.login_count : Number.parseInt(String(row.login_count ?? "0"), 10) || 0;
    return json(
      200,
      {
        ok: true,
        loginCount,
        firstLoginAt: unixSecToIso(
          typeof row.first_login_at === "number" ? row.first_login_at : null
        ),
        lastLoginAt: unixSecToIso(
          typeof row.last_login_at === "number" ? row.last_login_at : null
        )
      },
      cors
    );
  } catch (e) {
    console.error("[profiles] D1 error:", e);
    return json(500, { error: "persist_failed" }, cors);
  }
}
__name(handleProfiles, "handleProfiles");

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-gh7sO7/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-gh7sO7/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
