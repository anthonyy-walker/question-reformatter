// local-ai.js — Chrome's built-in on-device model (Gemini Nano) through the Prompt API.
// Free, private, offline after the one-time download. Works where `LanguageModel`
// exists: extension pages, the offscreen document, and (in newer Chrome) the service worker.

(function (root) {
  "use strict";

  const LANG = { expectedInputs: [{ type: "text", languages: ["en"] }], expectedOutputs: [{ type: "text", languages: ["en"] }] };

  const has = () => typeof root.LanguageModel !== "undefined";

  // "unavailable" | "downloadable" | "downloading" | "available" | "missing" (API not in this Chrome)
  async function availability() {
    if (!has()) return "missing";
    try { return await root.LanguageModel.availability(LANG); } catch (_) { return "unavailable"; }
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

  // messages: [{role:"user"|"assistant", content}], last one must be "user".
  async function run({ system, messages, schema }) {
    const state = await availability();
    if (state !== "available") throw new Error(`On-device model is ${state === "missing" ? "not in this Chrome" : state}.`);
    const session = await root.LanguageModel.create({
      ...LANG,
      initialPrompts: [{ role: "system", content: system }, ...messages.slice(0, -1)],
    });
    try {
      return await session.prompt(messages[messages.length - 1].content, schema ? { responseConstraint: schema } : undefined);
    } finally {
      session.destroy();
    }
  }

  // JSON shapes the model is forced to follow.
  const point = { type: "object", properties: { text: { type: "string" }, sub: { type: "array", items: { type: "string" } } }, required: ["text"] };
  const sections = { type: "array", items: { type: "object", properties: { heading: { type: "string" }, points: { type: "array", items: point } }, required: ["heading", "points"] } };
  const SCHEMAS = {
    question: { type: "object", properties: { sections, question: { type: "array", items: { type: "string" } }, choices_intro: { type: "string" }, choices: { type: "array", items: { type: "string" } } }, required: ["sections", "question", "choices"] },
    reading: { type: "object", properties: { summary: { type: "string" }, sections }, required: ["summary", "sections"] },
  };

  root.QRLocal = { has, availability, download, run, SCHEMAS };
})(typeof globalThis !== "undefined" ? globalThis : this);
