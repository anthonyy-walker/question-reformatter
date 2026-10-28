// reformat.js — the same rewrite the extension does, run on the server:
// fixed instructions (prompt.js) → Claude → automatic checks (formatter.js) →
// one self-fix pass → automatic repair. Every rewrite is logged.
const crypto = require("crypto");
const P = require("../prompt.js");
const F = require("../formatter.js");
const db = require("./db");

const MAX_TEXT = 20000;

function parseStructured(raw) {
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const arr = (x) => (Array.isArray(x) ? x.map(String) : []);
  const sections = (Array.isArray(parsed.sections) ? parsed.sections : []).map((sec) => ({
    heading: String(sec.heading || ""),
    points: (Array.isArray(sec.points) ? sec.points : []).map((p) => (typeof p === "string" ? { text: p, sub: [] } : { text: String(p.text || ""), sub: arr(p.sub) })),
  }));
  return { source: "ai", summary: String(parsed.summary || ""), sections, question: arr(parsed.question), choices_intro: String(parsed.choices_intro || ""), choices: arr(parsed.choices) };
}

async function claudeCall(model, messages, system) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("The server has no Claude API key. Add ANTHROPIC_API_KEY in Railway → Variables."), { status: 503 });
  const res = await fetch(process.env.ANTHROPIC_URL || "https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, system, messages }),
  });
  if (!res.ok) throw Object.assign(new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: 502 });
  const data = await res.json();
  return {
    text: (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(""),
    inTok: (data.usage && data.usage.input_tokens) || 0,
    outTok: (data.usage && data.usage.output_tokens) || 0,
  };
}

function clean(body) {
  const kind = body.kind === "reading" ? "reading" : "question";
  const text = String(body.text || "").slice(0, MAX_TEXT);
  if (text.trim().length < 5) throw Object.assign(new Error("No text to rewrite."), { status: 400 });
  const choices = kind === "reading" ? [] : (Array.isArray(body.choices) ? body.choices : []).slice(0, 30).map((c) => String(c).slice(0, 2000));
  const math = (Array.isArray(body.math) ? body.math : []).slice(0, 200)
    .map((m) => ({ token: String((m && m.token) || ""), text: String((m && m.text) || "").slice(0, 500) }))
    .filter((m) => /^⟦M\d+⟧$/.test(m.token));
  const site = String(body.site || "").slice(0, 200) || null;
  const pageTitle = String(body.pageTitle || "").slice(0, 300) || null;
  return { kind, text, choices, math, site, pageTitle };
}

async function reformat(body, connectionId) {
  const started = Date.now();
  const settings = await db.getSettings();
  if (settings.paused) throw Object.assign(new Error("The server is paused. Turn it back on in the dashboard → Settings."), { status: 503 });
  const { kind, text, choices, math, site, pageTitle } = clean(body);
  const reading = kind === "reading";
  const model = settings.model;
  const original = { text, choices, math };
  const v = reading ? "r" + P.READING_PROMPT_VERSION : P.PROMPT_VERSION;
  const key = crypto.createHash("sha256").update(JSON.stringify({ v, kind, model, text, choices, math: math.map((m) => [m.token, m.text]) })).digest("hex");

  const log = (row) => db.q(
    `INSERT INTO rewrites (kind, site, page_title, model, status, cached, original, result, first_problems, final_problems, repaired, self_fixed, input_tokens, output_tokens, ms, error, connection_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
    [kind, site, pageTitle, model, row.status, !!row.cached,
      settings.keepText ? original : { text: "(text not kept)", choices: [], math: [] },
      settings.keepText ? row.result || null : null,
      JSON.stringify(row.firstProblems || []), JSON.stringify(row.finalProblems || []),
      !!row.repaired, !!row.selfFixed, row.inTok || 0, row.outTok || 0, Date.now() - started, row.error || null, connectionId || null]
  ).catch((e) => console.error("log failed:", e.message));

  if (!body.forceFresh) {
    const { rows } = await db.q("SELECT result, first_problems, repaired FROM cache WHERE key = $1", [key]);
    if (rows.length) {
      await log({ status: "ok", cached: true, result: rows[0].result, firstProblems: rows[0].first_problems, repaired: rows[0].repaired });
      return { structured: rows[0].result, via: "server", model, cached: true };
    }
  }

  const mathText = Object.fromEntries(math.map((m) => [m.token, m.text]));
  const check = (s) => F.checkSimple(text, choices, s, mathText, { reading });
  const system = reading ? P.READING_PROMPT : P.SYSTEM_PROMPT;
  const firstMessage = reading ? P.buildReadingMessage(text, math) : P.buildUserMessage(text, choices, math);
  let inTok = 0, outTok = 0;
  const call = async (msgs) => { const r = await claudeCall(model, msgs, system); inTok += r.inTok; outTok += r.outTok; return r.text; };

  try {
    const messages = [{ role: "user", content: firstMessage }];
    const raw = await call(messages);
    let structured = parseStructured(raw);
    const firstProblems = check(structured);
    let problems = firstProblems;
    let selfFixed = false;
    if (problems.length) {
      try {
        const raw2 = await call([...messages, { role: "assistant", content: raw }, { role: "user", content: P.buildFixMessage(problems) }]);
        const second = parseStructured(raw2);
        if (check(second).length < problems.length) { structured = second; selfFixed = true; }
      } catch (_) { /* keep the first answer; it is repaired below */ }
      problems = check(structured);
    }
    const repaired = problems.length > 0;
    if (repaired) structured = F.repairSimple(text, choices, structured, mathText, { reading });
    await db.q("INSERT INTO cache (key, model, result, first_problems, repaired) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING",
      [key, model, structured, JSON.stringify(firstProblems), repaired]);
    await log({ status: "ok", result: structured, firstProblems, finalProblems: problems, repaired, selfFixed, inTok, outTok });
    return { structured, via: "server", model, cached: false };
  } catch (e) {
    await log({ status: "error", error: String(e.message || e).slice(0, 500), inTok, outTok });
    throw e;
  }
}

module.exports = { reformat, parseStructured };
