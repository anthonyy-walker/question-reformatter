// background.js — service worker.
// - Makes the AI call (keeps the API key off the Gradescope page).
// - Saves every AI result that passes the safety check, so the same question
//   never costs tokens twice — even after closing the tab or restarting Chrome.

importScripts("prompt.js", "formatter.js");

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
const CACHE_PREFIX = "c:";
const MAX_SAVED = 2000; // ~2 KB each; well under Chrome's storage limit

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handlers = {
    QR_AI_REFORMAT: () => reformat(msg),
    QR_OPEN_OPTIONS: async () => chrome.runtime.openOptionsPage(),
    QR_CACHE_STATS: () => cacheStats(),
    QR_CACHE_CLEAR: () => cacheClear(),
  };
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
function cacheKeyInput({ text, choices, math }, model) {
  return JSON.stringify({ v: PROMPT_VERSION, model, text, choices, math: (math || []).map((m) => [m.token, m.text]) });
}

// ---------- main flow ----------

async function reformat({ text, choices, math, forceFresh, cacheOnly }) {
  const { apiKey, model: chosen } = await chrome.storage.local.get(["apiKey", "model"]);
  const model = chosen || DEFAULT_MODEL;
  const key = CACHE_PREFIX + (await sha256(cacheKeyInput({ text, choices, math }, model)));

  if (!forceFresh) {
    const hit = (await chrome.storage.local.get(key))[key];
    if (hit) {
      hit.lastUsed = Date.now();
      chrome.storage.local.set({ [key]: hit });
      return { structured: hit.structured, notes: hit.notes || [], cached: true, savedAt: hit.savedAt };
    }
  }

  if (cacheOnly) return { miss: true };
  if (!apiKey) throw new Error("No API key set. Open Settings to add one.");

  const mathText = Object.fromEntries((math || []).map((m) => [m.token, m.text]));
  const check = (s) => QRFormatter.validate(text, choices, s, mathText);

  // 1) First try.
  const messages = [{ role: "user", content: buildUserMessage(text, choices, math) }];
  let { structured, raw } = await callModel(apiKey, model, messages);
  let problems = check(structured);
  let notes = [];

  // 2) If it broke a rule, the AI gets one chance to fix its own layout.
  if (problems.length) {
    try {
      const second = await callModel(apiKey, model, [...messages, { role: "assistant", content: raw }, { role: "user", content: buildFixMessage(problems) }]);
      if (check(second.structured).length < problems.length) structured = second.structured;
    } catch (_) { /* keep the first layout and repair it below */ }
    problems = check(structured);
  }

  // 3) Anything still wrong is patched with the question's own sentences. The layout is never thrown away.
  if (problems.length) {
    const fixed = QRFormatter.repair(text, choices, structured);
    structured = fixed.structured;
    notes = fixed.notes;
  }

  const now = Date.now();
  await chrome.storage.local.set({ [key]: { structured, notes, savedAt: now, lastUsed: now } });
  prune();
  return { structured, notes, remaining: check(structured), cached: false };
}

async function callModel(apiKey, model, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      temperature: 0,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const data = await res.json();
  const raw = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  const arr = (x) => (Array.isArray(x) ? x.map(String) : []);
  return { raw, structured: { source: "ai", task: arr(parsed.task), given: arr(parsed.given), context: arr(parsed.context), choices: arr(parsed.choices) } };
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
