// db.js — Postgres storage: the rewrite log, saved results, connection codes,
// and settings. Tables are created on start.
const { Pool } = require("pg");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Add a Postgres database to this project.");
  process.exit(1);
}
const local = /localhost|127\.0\.0\.1|\.railway\.internal/.test(url);
const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });

const q = (text, params) => pool.query(text, params);

async function init() {
  await q(`
    CREATE TABLE IF NOT EXISTS rewrites (
      id            BIGSERIAL PRIMARY KEY,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      kind          TEXT NOT NULL,
      site          TEXT,
      page_title    TEXT,
      model         TEXT,
      status        TEXT NOT NULL,          -- ok | error
      cached        BOOLEAN NOT NULL DEFAULT false,
      original      JSONB NOT NULL,         -- { text, choices, math }
      result        JSONB,                  -- the rewrite the student saw
      first_problems JSONB NOT NULL DEFAULT '[]',
      final_problems JSONB NOT NULL DEFAULT '[]',
      repaired      BOOLEAN NOT NULL DEFAULT false,
      self_fixed    BOOLEAN NOT NULL DEFAULT false,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      ms            INTEGER,
      error         TEXT,
      connection_id BIGINT
    );
    CREATE INDEX IF NOT EXISTS rewrites_created ON rewrites (created_at DESC);
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY, model TEXT, result JSONB NOT NULL,
      first_problems JSONB NOT NULL DEFAULT '[]', repaired BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS connections (
      id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, hint TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), last_used TIMESTAMPTZ, revoked BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
  `);
}

const DEFAULT_SETTINGS = { model: "claude-haiku-4-5-20251001", ownerName: "", keepText: true, paused: false };

async function getSettings() {
  const { rows } = await q("SELECT key, value FROM settings");
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = r.value;
  return s;
}
async function setSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    await q("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2", [k, JSON.stringify(v)]);
  }
  return getSettings();
}

module.exports = { q, init, pool, getSettings, setSettings, DEFAULT_SETTINGS };
