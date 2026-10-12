// local-ai.js — Chrome's built-in on-device model (Gemini Nano) through the Prompt API.
// Free, private, offline after the one-time download.
//
// Speed tricks:
//  • One "base" session per instruction set is created once and kept warm. Each rewrite
//    clones it, so the model never re-reads the long instructions (that was the slow part).
//  • Answers are capped in size by the JSON schema, so the model writes less.
//  • Runs can be cancelled, so a click can jump ahead of background preparing.

(function (root) {
  "use strict";

  const LANG = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };
  const has = () => typeof root.LanguageModel !== "undefined";

  let availCache = { value: null, at: 0 };
  // "unavailable" | "downloadable" | "downloading" | "available" | "missing" (API not in this Chrome)
  async function availability() {
    if (!has()) return "missing";
    if (availCache.value === "available" && Date.now() - availCache.at < 60000) return "available";
    let v;
    try { v = await root.LanguageModel.availability(LANG); } catch (_) { v = "unavailable"; }
    availCache = { value: v, at: Date.now() };
    return v;
  }

  // Starts (or continues) the one-time model download. Must be called from a click.
  async function download(onProgress) {
    if (!has()) throw new Error("This version of Chrome doesn't have the built-in model.");
    const s = await root.LanguageModel.create({
      ...LANG,
      monitor(m) { m.addEventListener("downloadprogress", (e) => onProgress && onProgress(e.loaded)); },
    });
    s.destroy();
  }

  // Warm sessions that already have the instructions loaded.
  const bases = new Map();
  function baseFor(system) {
    if (!bases.has(system)) {
      const p = root.LanguageModel.create({ ...LANG, initialPrompts: [{ role: "system", content: system }] });
      p.catch(() => bases.delete(system));
      bases.set(system, p);
    }
    return bases.get(system);
  }
  async function warm(systems) {
    if ((await availability()) !== "available") return false;
    await Promise.all(systems.map((s) => baseFor(s).catch(() => null)));
    return true;
  }

  // messages: [{role:"user"|"assistant", content}], last one must be "user".
  async function run({ system, messages, schema, signal }) {
    const state = await availability();
    if (state !== "available") throw new Error(`On-device model is ${state === "missing" ? "not in this Chrome" : state}.`);
    const opts = schema ? { responseConstraint: schema, signal } : { signal };
    let session;
    if (messages.length === 1) {
      const base = await baseFor(system);
      session = await base.clone({ signal });
    } else {
      session = await root.LanguageModel.create({ ...LANG, signal, initialPrompts: [{ role: "system", content: system }, ...messages.slice(0, -1)] });
    }
    try {
      return await session.prompt(messages[messages.length - 1].content, opts);
    } finally {
      session.destroy();
    }
  }

  // JSON shapes the model is forced to follow — with size caps so answers stay short (= fast).
  const point = { type: "object", properties: { text: { type: "string" }, sub: { type: "array", items: { type: "string" }, maxItems: 3 } }, required: ["text"] };
  const sections = { type: "array", maxItems: 4, items: { type: "object", properties: { heading: { type: "string" }, points: { type: "array", items: point, maxItems: 5 } }, required: ["heading", "points"] } };
  const SCHEMAS = {
    question: { type: "object", properties: { sections, question: { type: "array", items: { type: "string" } }, choices_intro: { type: "string" }, choices: { type: "array", items: { type: "string" } } }, required: ["sections", "question", "choices"] },
    reading: { type: "object", properties: { summary: { type: "string" }, sections }, required: ["summary", "sections"] },
  };

  root.QRLocal = { has, availability, download, warm, run, SCHEMAS };
})(typeof globalThis !== "undefined" ? globalThis : this);
