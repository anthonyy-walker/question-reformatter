// index.js — Dyslexia Reading Aid server.
//   /api/reformat         the extension sends text here (needs a connection code)
//   /                     the dashboard (needs DASHBOARD_PASSWORD)
//   /v/<link>             read-only view for a professor or the disability office
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const db = require("./db");
const { reformat } = require("./reformat");
const P = require("../prompt.js");

const PORT = Number(process.env.PORT) || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || "";
const SECRET = process.env.SESSION_SECRET || crypto.createHash("sha256").update("dra-session:" + PASSWORD + ":" + (process.env.DATABASE_URL || "")).digest("hex");
const PRICES = { "claude-haiku-4-5-20251001": [1, 5] }; // $ per million tokens: [input, output]

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const rand = (n) => crypto.randomBytes(n).toString("base64url");
const safeEq = (a, b) => { const x = Buffer.from(sha(a)), y = Buffer.from(sha(b)); return crypto.timingSafeEqual(x, y); };

// ---------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
const fail = (res, status, msg) => send(res, status, { error: msg });

function readBody(req, limit = 300000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error("Too much text."), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (_) { reject(Object.assign(new Error("Bad JSON."), { status: 400 })); } });
    req.on("error", reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join("="))]));
}
function signSession() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 30 * 864e5 })).toString("base64url");
  return payload + "." + crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
}
function loggedIn(req) {
  const c = cookies(req).dra_s; if (!c) return false;
  const [payload, sig] = c.split(".");
  if (!payload || !sig) return false;
  const good = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  try { return JSON.parse(Buffer.from(payload, "base64url").toString()).exp > Date.now(); } catch (_) { return false; }
}
const secureCookie = (req) => (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "");

// Slow down password guessing: 8 tries per 15 minutes per address.
const attempts = new Map();
function tooMany(ip) {
  const now = Date.now(); const a = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, a); return a.length >= 8;
}
const ipOf = (req) => String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();

async function connectionFor(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "");
  if (!m) return null;
  const { rows } = await db.q("UPDATE connections SET last_used = now() WHERE token_hash = $1 AND NOT revoked RETURNING id, name", [sha(m[1])]);
  return rows[0] || null;
}
async function viewerFor(token) {
  if (!token) return null;
  const { rows } = await db.q("UPDATE viewers SET last_viewed = now() WHERE token_hash = $1 AND NOT revoked RETURNING id, name", [sha(token)]);
  return rows[0] || null;
}

const cost = (model, i, o) => { const p = PRICES[model]; return p ? (i * p[0] + o * p[1]) / 1e6 : null; };

// ---------------------------------------------------------------- data for the dashboard

async function stats(days) {
  days = Math.min(Math.max(Number(days) || 30, 1), 365);
  const since = `now() - interval '${days} days'`;
  const [tot, byDay, bySite, models] = await Promise.all([
    db.q(`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='ok')::int AS ok,
            count(*) FILTER (WHERE status='error')::int AS errors,
            count(*) FILTER (WHERE cached)::int AS cached,
            count(*) FILTER (WHERE status='ok' AND NOT cached AND jsonb_array_length(first_problems)=0)::int AS clean,
            count(*) FILTER (WHERE status='ok' AND NOT cached)::int AS fresh,
            count(*) FILTER (WHERE repaired AND NOT cached)::int AS repaired,
            count(*) FILTER (WHERE kind='question')::int AS questions,
            count(*) FILTER (WHERE kind='reading')::int AS reading,
            coalesce(sum(input_tokens),0)::bigint AS in_tok, coalesce(sum(output_tokens),0)::bigint AS out_tok,
            coalesce(avg(ms) FILTER (WHERE status='ok' AND NOT cached),0)::int AS avg_ms
          FROM rewrites WHERE created_at > ${since}`),
    db.q(`SELECT to_char(d, 'YYYY-MM-DD') AS day, coalesce(c.n,0)::int AS n FROM generate_series((now() - interval '${days - 1} days')::date, now()::date, interval '1 day') d
          LEFT JOIN (SELECT created_at::date AS day, count(*) AS n FROM rewrites WHERE created_at > ${since} GROUP BY 1) c ON c.day = d::date ORDER BY d`),
    db.q(`SELECT coalesce(site,'(unknown)') AS site, count(*)::int AS n FROM rewrites WHERE created_at > ${since} GROUP BY 1 ORDER BY 2 DESC LIMIT 8`),
    db.q(`SELECT model, sum(input_tokens)::bigint AS i, sum(output_tokens)::bigint AS o FROM rewrites WHERE created_at > ${since} GROUP BY 1`),
  ]);
  let dollars = 0, priced = true;
  for (const m of models.rows) { const c = cost(m.model, Number(m.i), Number(m.o)); if (c == null) { if (Number(m.i) + Number(m.o)) priced = false; } else dollars += c; }
  const t = tot.rows[0];
  return { days, ...t, in_tok: Number(t.in_tok), out_tok: Number(t.out_tok), cost: priced ? dollars : null, byDay: byDay.rows, bySite: bySite.rows };
}

async function listRewrites(u) {
  const limit = Math.min(Number(u.searchParams.get("limit")) || 30, 100);
  const offset = Math.max(Number(u.searchParams.get("offset")) || 0, 0);
  const kind = u.searchParams.get("kind");
  const search = (u.searchParams.get("q") || "").trim();
  const where = []; const params = [];
  if (kind === "question" || kind === "reading") { params.push(kind); where.push(`kind = $${params.length}`); }
  if (search) { params.push("%" + search + "%"); where.push(`(original->>'text' ILIKE $${params.length} OR site ILIKE $${params.length} OR page_title ILIKE $${params.length})`); }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  params.push(limit, offset);
  const { rows } = await db.q(`SELECT id, created_at, kind, site, page_title, model, status, cached, repaired, self_fixed,
      jsonb_array_length(first_problems) AS problems, left(original->>'text', 220) AS preview, result->>'summary' AS summary, ms, input_tokens, output_tokens
    FROM rewrites ${w} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
  const { rows: [{ n }] } = await db.q(`SELECT count(*)::int AS n FROM rewrites ${w}`, params.slice(0, -2));
  return { total: n, rows: rows.map((r) => ({ ...r, cost: cost(r.model, r.input_tokens, r.output_tokens) })) };
}
async function oneRewrite(id) {
  const { rows } = await db.q("SELECT r.*, c.name AS connection FROM rewrites r LEFT JOIN connections c ON c.id = r.connection_id WHERE r.id = $1", [Number(id) || 0]);
  if (!rows[0]) return null;
  return { ...rows[0], cost: cost(rows[0].model, rows[0].input_tokens, rows[0].output_tokens) };
}
const prompts = () => ({ question: { version: P.PROMPT_VERSION, text: P.SYSTEM_PROMPT }, reading: { version: P.READING_PROMPT_VERSION, text: P.READING_PROMPT } });

// ---------------------------------------------------------------- static files

const FONT_DIR = path.join(__dirname, "..", "fonts");

function serveFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) return fail(res, 404, "Not found");
    res.writeHead(200, {
      "content-type": type, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "cache-control": type.startsWith("font") ? "public, max-age=604800" : "no-cache",
      ...(type.startsWith("text/html") ? {
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        "x-frame-options": "DENY",
      } : {}),
    });
    res.end(buf);
  });
}

// ---------------------------------------------------------------- routes

async function handle(req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;
  const m = req.method;

  // The extension calls from its own background page; allow it (and only JSON).
  if (p.startsWith("/api/ext/")) {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    if (m === "OPTIONS") return send(res, 204, "");
  }

  if (p === "/health") return send(res, 200, { ok: true });

  // ---- extension
  if (p === "/api/ext/ping" && m === "POST") {
    const c = await connectionFor(req);
    if (!c) return fail(res, 401, "That connection code isn't valid. Make a new one in the dashboard → Connections.");
    const s = await db.getSettings();
    return send(res, 200, { ok: true, name: c.name, model: s.model, paused: s.paused, hasKey: !!process.env.ANTHROPIC_API_KEY });
  }
  if (p === "/api/ext/reformat" && m === "POST") {
    const c = await connectionFor(req);
    if (!c) return fail(res, 401, "That connection code isn't valid. Make a new one in the dashboard → Connections.");
    return send(res, 200, await reformat(await readBody(req), c.id));
  }

  // ---- static
  if (m === "GET" && (p === "/" || p.startsWith("/v/"))) return serveFile(res, path.join(__dirname, "dashboard.html"), "text/html; charset=utf-8");
  if (m === "GET" && /^\/fonts\/[\w.-]+\.woff2$/.test(p)) return serveFile(res, path.join(FONT_DIR, path.basename(p)), "font/woff2");

  // ---- read-only viewer
  const vm = /^\/api\/view\/([\w-]+)\/(stats|rewrites|rewrite\/(\d+)|prompts|info)$/.exec(p);
  if (vm && m === "GET") {
    const v = await viewerFor(vm[1]);
    if (!v) return fail(res, 404, "This link was turned off or doesn't exist.");
    const what = vm[2];
    if (what === "info") { const s = await db.getSettings(); return send(res, 200, { viewer: v.name, ownerName: s.ownerName }); }
    if (what === "stats") return send(res, 200, await stats(u.searchParams.get("days")));
    if (what === "rewrites") return send(res, 200, await listRewrites(u));
    if (what === "prompts") return send(res, 200, prompts());
    const r = await oneRewrite(vm[3]); delete (r || {}).connection;
    return r ? send(res, 200, r) : fail(res, 404, "Not found");
  }

  // ---- dashboard login
  if (p === "/api/login" && m === "POST") {
    const ip = ipOf(req);
    if (!PASSWORD) return fail(res, 503, "Set DASHBOARD_PASSWORD in Railway → Variables first.");
    if (tooMany(ip)) return fail(res, 429, "Too many tries. Wait 15 minutes.");
    const { password } = await readBody(req, 2000);
    if (!password || !safeEq(String(password), PASSWORD)) { attempts.get(ip).push(Date.now()); return fail(res, 401, "Wrong password."); }
    return send(res, 200, { ok: true }, { "set-cookie": `dra_s=${signSession()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 86400}${secureCookie(req)}` });
  }
  if (p === "/api/logout" && m === "POST") return send(res, 200, { ok: true }, { "set-cookie": `dra_s=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie(req)}` });
  if (p === "/api/me" && m === "GET") return send(res, 200, { loggedIn: loggedIn(req), passwordSet: !!PASSWORD, hasKey: !!process.env.ANTHROPIC_API_KEY });

  if (!p.startsWith("/api/")) return fail(res, 404, "Not found");
  if (!loggedIn(req)) return fail(res, 401, "Please log in.");
  // Same-site check on changes, on top of the SameSite cookie.
  if (m !== "GET" && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return fail(res, 403, "Blocked.");

  if (p === "/api/stats" && m === "GET") return send(res, 200, await stats(u.searchParams.get("days")));
  if (p === "/api/rewrites" && m === "GET") return send(res, 200, await listRewrites(u));
  if (p === "/api/prompts" && m === "GET") return send(res, 200, prompts());
  let mm;
  if ((mm = /^\/api\/rewrites\/(\d+)$/.exec(p))) {
    if (m === "GET") { const r = await oneRewrite(mm[1]); return r ? send(res, 200, r) : fail(res, 404, "Not found"); }
    if (m === "DELETE") { await db.q("DELETE FROM rewrites WHERE id = $1", [Number(mm[1])]); return send(res, 200, { ok: true }); }
  }
  if (p === "/api/rewrites" && m === "DELETE") { await db.q("DELETE FROM rewrites"); await db.q("DELETE FROM cache"); return send(res, 200, { ok: true }); }

  if (p === "/api/settings") {
    if (m === "GET") return send(res, 200, { ...(await db.getSettings()), hasKey: !!process.env.ANTHROPIC_API_KEY, prices: PRICES });
    if (m === "PUT") {
      const b = await readBody(req, 5000); const patch = {};
      if (typeof b.model === "string" && /^claude-[\w.-]{3,60}$/.test(b.model)) patch.model = b.model;
      if (typeof b.ownerName === "string") patch.ownerName = b.ownerName.slice(0, 80);
      if (typeof b.keepText === "boolean") patch.keepText = b.keepText;
      if (typeof b.paused === "boolean") patch.paused = b.paused;
      return send(res, 200, await db.setSettings(patch));
    }
  }

  // connection codes (for the extension) and viewer links (read-only)
  for (const [route, table, extra] of [["connections", "connections", "last_used"], ["viewers", "viewers", "last_viewed"]]) {
    if (p === `/api/${route}`) {
      if (m === "GET") {
        const { rows } = await db.q(`SELECT id, name, created_at, ${extra} AS last${table === "connections" ? ", hint" : ""} FROM ${table} WHERE NOT revoked ORDER BY created_at DESC`);
        return send(res, 200, rows);
      }
      if (m === "POST") {
        const b = await readBody(req, 2000);
        const name = String(b.name || "").trim().slice(0, 80) || (table === "connections" ? "My Chrome" : "Viewer");
        const token = (table === "connections" ? "dra_" : "") + rand(table === "connections" ? 24 : 18);
        const cols = table === "connections" ? "(name, token_hash, hint) VALUES ($1,$2,$3)" : "(name, token_hash) VALUES ($1,$2)";
        const params = table === "connections" ? [name, sha(token), token.slice(-4)] : [name, sha(token)];
        const { rows } = await db.q(`INSERT INTO ${table} ${cols} RETURNING id, name, created_at`, params);
        return send(res, 200, { ...rows[0], token }); // shown once
      }
    }
    const dm = new RegExp(`^/api/${route}/(\\d+)$`).exec(p);
    if (dm && m === "DELETE") { await db.q(`UPDATE ${table} SET revoked = true WHERE id = $1`, [Number(dm[1])]); return send(res, 200, { ok: true }); }
  }

  return fail(res, 404, "Not found");
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!e.status) console.error(e);
    if (!res.headersSent) fail(res, e.status || 500, e.status ? e.message : "Server error.");
  });
});

db.init().then(() => {
  server.listen(PORT, () => console.log(`Dyslexia Reading Aid server on :${PORT}${PASSWORD ? "" : " (DASHBOARD_PASSWORD not set)"}${process.env.ANTHROPIC_API_KEY ? "" : " (ANTHROPIC_API_KEY not set)"}`));
}).catch((e) => { console.error("Database setup failed:", e.message); process.exit(1); });

module.exports = server;
