// background.js — service worker.
// - Makes the AI call (keeps the API key off the Gradescope page).
// - Saves every AI result that passes the safety check, so the same question
//   never costs tokens twice — even after closing the tab or restarting Chrome.

importScripts("prompt.js", "formatter.js", "local-ai.js");

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const LOCAL_MODEL = "chrome-built-in";
const HEAVY_REPAIR = 2; // more problems than this after the self-fix → ask Claude instead (if a key is set)
const CACHE_PREFIX = "c:";
const MAX_SAVED = 2000; // ~2 KB each; well under Chrome's storage limit

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    QR_AI_REFORMAT: () => reformat(msg),
    QR_OPEN_OPTIONS: async () => chrome.runtime.openOptionsPage(),
    QR_CACHE_STATS: () => cacheStats(),
    QR_CACHE_CLEAR: () => cacheClear(),
    QR_LOCAL_STATUS: () => localStatus(),
  };
  if (msg && msg.target === "offscreen") return; // meant for the offscreen page
  const h = handlers[msg && msg.type];
  if (!h) return;
  h().then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true; // async reply
});

// ---------- cache key ----------

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The key covers everything that could change the answer: the instructions'
// version, the model, the question, the choices, and what each math piece says.
function cacheKeyInput({ text, choices, math, kind }, model) {
  const v = kind === "reading" ? "r" + READING_PROMPT_VERSION : PROMPT_VERSION;
  return JSON.stringify({ v, kind, model, text, choices, math: (math || []).map((m) => [m.token, m.text]) });
}

// ---------- main flow ----------

async function reformat({ text, choices, math, forceFresh, cacheOnly, kind }) {
  const reading = kind === "reading";
  choices = reading ? [] : choices || [];
  const { apiKey, model: chosen, provider } = await chrome.storage.local.get(["apiKey", "model", "provider"]);
  const claudeModel = chosen || DEFAULT_MODEL;
  const keyFor = async (m) => CACHE_PREFIX + (await sha256(cacheKeyInput({ text, choices, math, kind }, m)));

  // Saved result from either provider → free.
  if (!forceFresh) {
    for (const m of [LOCAL_MODEL, claudeModel]) {
      const key = await keyFor(m);
      const hit = (await chrome.storage.local.get(key))[key];
      if (hit) {
        hit.lastUsed = Date.now();
        chrome.storage.local.set({ [key]: hit });
        return { structured: hit.structured, cached: true, via: hit.via || m, savedAt: hit.savedAt };
      }
    }
  }
  if (cacheOnly) return { miss: true };

  const mathText = Object.fromEntries((math || []).map((m) => [m.token, m.text]));
  const check = (s) => QRFormatter.checkSimple(text, choices, s, mathText, { reading });
  const system = reading ? READING_PROMPT : SYSTEM_PROMPT;
  const firstMessage = reading ? buildReadingMessage(text, math) : buildUserMessage(text, choices, math);
  const schema = QRLocal.SCHEMAS[reading ? "reading" : "question"];

  // One attempt = first answer, then one chance for the model to fix its own mistakes.
  async function attempt(which) {
    const call = (msgs) => (which === "local" ? localCall(msgs, system, schema) : claudeCall(apiKey, claudeModel, msgs, system));
    const messages = [{ role: "user", content: firstMessage }];
    const raw = await call(messages);
    let structured = parseStructured(raw);
    let problems = check(structured);
    if (problems.length) {
      try {
        const raw2 = await call([...messages, { role: "assistant", content: raw }, { role: "user", content: buildFixMessage(problems) }]);
        const second = parseStructured(raw2);
        if (check(second).length < problems.length) structured = second;
      } catch (_) { /* keep the first answer; it gets repaired below */ }
      problems = check(structured);
    }
    return { structured, problems, model: which === "local" ? LOCAL_MODEL : claudeModel, via: which };
  }

  let r;
  if ((provider || "local") === "local") {
    const status = await localStatus();
    if (status === "available") {
      try {
        r = await attempt("local");
        if (r.problems.length > HEAVY_REPAIR && apiKey) r = await attempt("claude").catch(() => r);
      } catch (e) {
        if (!apiKey) throw new Error("The on-device model had a problem: " + e.message);
        r = await attempt("claude");
      }
    } else if (apiKey) {
      r = await attempt("claude");
    } else {
      throw new Error(status === "downloadable" || status === "downloading"
        ? "The free on-device model isn't downloaded yet. Open Settings → Set up the on-device model."
        : "The free on-device model can't run in this Chrome. Add a Claude API key in Settings.");
    }
  } else {
    if (!apiKey) throw new Error("No Claude API key set. Open Settings to add one, or switch to the free on-device model.");
    r = await attempt("claude");
  }

  // Anything still wrong is patched with the original's own words. The rewrite is never thrown away.
  let structured = r.structured;
  if (r.problems.length) structured = QRFormatter.repairSimple(text, choices, structured, mathText, { reading });

  const now = Date.now();
  await chrome.storage.local.set({ [await keyFor(r.model)]: { structured, via: r.via, savedAt: now, lastUsed: now } });
  prune();
  return { structured, cached: false, via: r.via };
}

// ---------- providers ----------

async function claudeCall(apiKey, model, messages, system) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model, max_tokens: 2000, temperature: 0, system, messages }),
  });
  if (!res.ok) throw new Error(`Claude API error ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

// The on-device model runs here if this service worker has it, otherwise in a hidden offscreen page.
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Run Chrome's on-device language model (Prompt API)." });
}
async function viaOffscreen(type, payload) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type, payload });
  if (!r || !r.ok) throw new Error(r ? r.error : "The on-device model didn't respond.");
  return r.result;
}
async function localCall(messages, system, schema) {
  return QRLocal.has() ? QRLocal.run({ system, messages, schema }) : viaOffscreen("QR_LOCAL_RUN", { system, messages, schema });
}
async function localStatus() {
  try { return QRLocal.has() ? await QRLocal.availability() : await viaOffscreen("QR_LOCAL_STATUS"); }
  catch (_) { return "unavailable"; }
}

function parseStructured(raw) {
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const arr = (x) => (Array.isArray(x) ? x.map(String) : []);
  const sections = (Array.isArray(parsed.sections) ? parsed.sections : []).map((sec) => ({
    heading: String(sec.heading || ""),
    points: (Array.isArray(sec.points) ? sec.points : []).map((p) => (typeof p === "string" ? { text: p, sub: [] } : { text: String(p.text || ""), sub: arr(p.sub) })),
  }));
  return { source: "ai", summary: String(parsed.summary || ""), sections, question: arr(parsed.question), choices_intro: String(parsed.choices_intro || ""), choices: arr(parsed.choices) };
}

// ---------- housekeeping ----------

async function savedEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith(CACHE_PREFIX));
}

async function prune() {
  const entries = await savedEntries();
  if (entries.length <= MAX_SAVED) return;
  entries.sort((a, b) => (a[1].lastUsed || 0) - (b[1].lastUsed || 0));
  await chrome.storage.local.remove(entries.slice(0, entries.length - MAX_SAVED).map(([k]) => k));
}

async function cacheStats() {
  const entries = await savedEntries();
  return { count: entries.length };
}

async function cacheClear() {
  const entries = await savedEntries();
  await chrome.storage.local.remove(entries.map(([k]) => k));
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith("p:")));
  return { count: 0 };
}
