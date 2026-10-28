// background.js — service worker.
// - Makes the AI call (keeps the API key off the Gradescope page).
// - Saves every AI result that passes the safety check, so the same question
//   never costs tokens twice — even after closing the tab or restarting Chrome.

importScripts("prompt.js", "formatter.js", "local-ai.js");

const LOCAL_MODEL = "chrome-built-in";
const HEAVY_REPAIR = 2; // more problems than this after the self-fix → ask Claude instead (if a key is set)
const CACHE_PREFIX = "c:";
const MAX_SAVED = 2000; // ~2 KB each; well under Chrome's storage limit

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    QR_AI_REFORMAT: () => reformatAndLog(msg),
    QR_OPEN_OPTIONS: async () => chrome.runtime.openOptionsPage(),
    QR_CACHE_STATS: () => cacheStats(),
    QR_CACHE_CLEAR: () => cacheClear(),
    QR_LOCAL_STATUS: () => localStatus(),
    QR_WARM: () => localWarm(),
    QR_SERVER_TEST: () => serverPing(msg.url, msg.code),
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

// Rewrites being made right now (so a click waits for the one already in progress)
// and a queue so background preparing runs one at a time across all tabs.
const inflight = new Map();
let prefetchLock = Promise.resolve();
let currentPrefetch = null; // { jobId, key } of the background rewrite running right now

async function reformat({ text, choices, math, forceFresh, cacheOnly, kind, prefetch, useClaude, site, pageTitle }) {
  const reading = kind === "reading";
  choices = reading ? [] : choices || [];
  const st = await chrome.storage.local.get(["provider", "serverUrl", "serverCode"]);
  // Only two ways to rewrite: the free on-device model, or your own server (which holds the Claude key,
  // runs the checks and logs every rewrite). Nothing talks to Claude directly from this computer.
  const provider = st.provider === "local" || !st.provider ? "local" : "server";
  const serverUrl = st.serverUrl || DEFAULT_SERVER;
  const serverCode = st.serverCode;
  const remote = !!serverCode;
  const apiKey = remote ? "server" : null; // "is the server available?" below
  const claudeModel = SERVER_MODEL;
  const keyFor = async (m) => CACHE_PREFIX + (await sha256(cacheKeyInput({ text, choices, math, kind }, m)));

  // Saved result from either provider → free.
  if (!forceFresh) {
    for (const m of useClaude ? [claudeModel] : [LOCAL_MODEL, SERVER_MODEL]) {
      const key = await keyFor(m);
      const hit = (await chrome.storage.local.get(key))[key];
      if (hit) {
        hit.lastUsed = Date.now();
        chrome.storage.local.set({ [key]: hit });
        return { structured: hit.structured, cached: true, via: hit.via || m, savedAt: hit.savedAt,
          _log: { model: m === LOCAL_MODEL ? "on-device" : SERVER_MODEL, firstProblems: hit.firstProblems || [], repaired: !!hit.repaired } };
      }
    }
  }
  if (cacheOnly) return { miss: true };

  const localKey = await keyFor(LOCAL_MODEL);
  if (!useClaude && inflight.has(localKey)) {
    try {
      const done = await inflight.get(localKey);
      if (done && done.structured) return { ...done, cached: true };
    } catch (_) { /* make it again below */ }
  }

  const mathText = Object.fromEntries((math || []).map((m) => [m.token, m.text]));
  const check = (s) => QRFormatter.checkSimple(text, choices, s, mathText, { reading });
  const system = reading ? READING_PROMPT : SYSTEM_PROMPT;
  const localSystem = reading ? LOCAL_READING_PROMPT : SYSTEM_PROMPT;
  const firstMessage = reading ? buildReadingMessage(text, math) : buildUserMessage(text, choices, math);
  const schema = QRLocal.SCHEMAS[reading ? "reading" : "question"];

  // One attempt = first answer, then one chance for the model to fix its own mistakes.
  // On-device: one pass only (a second "fix it" pass doubled the wait); mistakes are repaired instantly instead.
  async function attempt(which, jobId) {
    const started = Date.now();
    if (which !== "local") {
      if (!remote) throw new Error("Connect your server first: Settings → My server → paste your connection code.");
      const r = await serverCall(serverUrl, serverCode, { text, choices, math, kind: reading ? "reading" : "question", site, pageTitle, forceFresh });
      console.log(`[Reading Aid] server ${kind || "question"} rewrite: ${((Date.now() - started) / 1000).toFixed(1)}s${r.cached ? " (saved on server)" : ""}`);
      return { structured: r.structured, problems: [], model: SERVER_MODEL, via: "claude" };
    }
    const call = (msgs) => localCall(msgs, localSystem, schema, jobId);
    const messages = [{ role: "user", content: firstMessage }];
    const raw = await call(messages);
    let structured = parseStructured(raw);
    let problems = check(structured);
    console.log(`[Reading Aid] ${which} ${kind || "question"} rewrite: ${((Date.now() - started) / 1000).toFixed(1)}s, ${problems.length} problem(s)`);
    if (problems.length && which !== "local") {
      try {
        const raw2 = await call([...messages, { role: "assistant", content: raw }, { role: "user", content: buildFixMessage(problems) }]);
        const second = parseStructured(raw2);
        if (check(second).length < problems.length) structured = second;
      } catch (_) { /* keep the first answer; it gets repaired below */ }
      problems = check(structured);
    }
    return { structured, problems, model: which === "local" ? LOCAL_MODEL : claudeModel, via: which };
  }

  async function finish(r) {
    // Anything still wrong is patched with the original's own words. The rewrite is never thrown away.
    let structured = r.structured;
    if (r.problems.length) structured = QRFormatter.repairSimple(text, choices, structured, mathText, { reading });
    const now = Date.now();
    const repaired = r.problems.length > 0;
    await chrome.storage.local.set({ [await keyFor(r.model)]: { structured, via: r.via, savedAt: now, lastUsed: now, firstProblems: r.problems, repaired } });
    prune();
    // The server logs its own rewrites; on-device ones are sent to it afterwards (see reformatAndLog).
    return { structured, cached: false, via: r.via, _log: r.model === SERVER_MODEL ? null : { model: "on-device", firstProblems: r.problems, repaired } };
  }

  // Preparing ahead of time: free on-device model only, one at a time, never Claude.
  if (prefetch) {
    if ((provider || "local") !== "local") return { skipped: true };
    const job = prefetchLock.then(() => {
      const jobId = "p" + Date.now() + Math.random();
      const p = (async () => {
        if ((await localStatus()) !== "available") return { skipped: true };
        currentPrefetch = { jobId, key: localKey };
        try { return finish(await attempt("local", jobId)); }
        catch (e) { if (/abort/i.test(String(e && e.message))) return { aborted: true }; throw e; }
        finally { if (currentPrefetch && currentPrefetch.jobId === jobId) currentPrefetch = null; }
      })();
      inflight.set(localKey, p);
      return p.finally(() => inflight.delete(localKey));
    });
    prefetchLock = job.catch(() => {});
    return job;
  }

  let r;
  if (useClaude) {
    r = await attempt("claude");
  } else if (provider === "server") {
    // Server first; if it can't be reached (offline, paused), the free on-device model.
    try { r = await attempt("claude"); }
    catch (e) {
      if ((await localStatus()) !== "available") throw e;
      r = await attempt("local");
    }
  } else if ((provider || "local") === "local") {
    // A click goes first: pause whatever is being prepared in the background (it is re-queued).
    if (currentPrefetch && currentPrefetch.key !== localKey) {
      viaOffscreen("QR_LOCAL_ABORT", { jobId: currentPrefetch.jobId }).catch(() => {});
      currentPrefetch = null;
    }
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
        : "The free on-device model can't run in this Chrome. Connect your server in Settings → My server.");
    }
  }

  return finish(r);
}

// ---------- logging every rewrite to your server ----------
// Every rewrite you open is logged on your server, including ones made on this computer
// and saved copies. Rewrites prepared in the background are logged only when you open them.
// If the server can't be reached, the log entry waits here and is sent next time.

const LOG_QUEUE = "logq";
async function reformatAndLog(msg) {
  const started = Date.now();
  const r = await reformat(msg);
  const meta = r && r._log;
  if (r) delete r._log;
  if (meta && r.structured && !msg.prefetch && !msg.cacheOnly) {
    const reading = msg.kind === "reading";
    queueLog({
      kind: reading ? "reading" : "question", text: msg.text, choices: reading ? [] : msg.choices || [],
      math: msg.math || [], site: msg.site, pageTitle: msg.pageTitle, result: r.structured,
      model: meta.model, cached: !!r.cached, firstProblems: meta.firstProblems, repaired: meta.repaired,
      ms: Date.now() - started, at: new Date().toISOString(),
    });
  }
  return r;
}
async function queueLog(entry) {
  const { [LOG_QUEUE]: q = [] } = await chrome.storage.local.get(LOG_QUEUE);
  q.push(entry);
  await chrome.storage.local.set({ [LOG_QUEUE]: q.slice(-300) });
  flushLogs();
}
let flushing = false;
async function flushLogs() {
  if (flushing) return;
  flushing = true;
  try {
    const st = await chrome.storage.local.get(["serverUrl", "serverCode", LOG_QUEUE]);
    const q = st[LOG_QUEUE] || [];
    if (!st.serverCode || !q.length) return;
    const url = st.serverUrl || DEFAULT_SERVER;
    let sent = 0;
    for (const entry of q) {
      try { await serverFetch(url, st.serverCode, "/api/ext/log", entry); sent++; }
      catch (_) { break; } // offline or server down: try again later
    }
    const { [LOG_QUEUE]: now = [] } = await chrome.storage.local.get(LOG_QUEUE);
    await chrome.storage.local.set({ [LOG_QUEUE]: now.slice(sent) });
  } finally { flushing = false; }
}
chrome.runtime.onStartup.addListener(() => { flushLogs(); });

// ---------- providers ----------

const SERVER_MODEL = "my-server";
const DEFAULT_SERVER = "https://server-production-0b34.up.railway.app";

// No Claude key is kept on this computer any more (the server holds it). Remove an old one.
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["provider"], (s) => {
    chrome.storage.local.remove(["apiKey", "model"]);
    if (s.provider === "claude") chrome.storage.local.set({ provider: "server" });
  });
});

async function serverFetch(url, code, path, body) {
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(url || "")) throw new Error("The server address must start with https://");
  let res;
  try {
    res = await fetch(url.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + code },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) { throw new Error("Couldn't reach your server. Check the address and your internet."); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
  return data;
}
const serverCall = (url, code, body) => serverFetch(url, code, "/api/ext/reformat", body);
const serverPing = (url, code) => serverFetch(url, code, "/api/ext/ping");


// The on-device model runs here if this service worker has it, otherwise in a hidden offscreen page.
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (existing.length) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["DOM_PARSER"], justification: "Run Chrome's on-device language model (Prompt API)." });
}
async function viaOffscreen(type, payload) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: "offscreen", type, payload });
  if (!r || !r.ok) throw new Error(r ? (r.aborted ? "aborted: " : "") + r.error : "The on-device model didn't respond.");
  return r.result;
}
// Always run in the offscreen page: it stays open, so the model stays loaded and warm.
async function localCall(messages, system, schema, jobId) {
  return viaOffscreen("QR_LOCAL_RUN", { system, messages, schema, jobId });
}
async function localStatus() {
  try { return await viaOffscreen("QR_LOCAL_STATUS"); }
  catch (_) { return "unavailable"; }
}
async function localWarm() {
  const { provider } = await chrome.storage.local.get("provider");
  if ((provider || "local") !== "local") return false;
  return viaOffscreen("QR_LOCAL_WARM", { systems: [LOCAL_READING_PROMPT, SYSTEM_PROMPT] }).catch(() => false);
}
chrome.runtime.onStartup.addListener(() => { localWarm(); });
chrome.runtime.onInstalled.addListener(() => { localWarm(); });

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
