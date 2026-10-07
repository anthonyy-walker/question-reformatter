// formatter.js
// Shared logic: rule-based restructuring + safety checks.
// Used by the page (content script), the background worker, and Node tests.
//
// "Rich text" here is a plain string that may contain:
//   ⟦M3⟧            a math expression (looked up in a separate list)
//   <b>…</b> <i>…</i>  bold / italic emphasis from the original question
// Rules mode NEVER adds words. It only splits, groups and highlights the original.

(function (root) {
  "use strict";

  const ABBREVIATIONS = ["e.g.", "i.e.", "vs.", "approx.", "etc.", "Dr.", "Mr.", "Ms.", "Mrs.", "St.", "No.", "Fig.", "U.S.", "et al."];

  const TOKEN_RE = /⟦M\d+⟧/g;
  const TAG_RE = /<\/?[bi]>/g;
  // Numbers as they appear in stats problems: 1,250  0.05  .05  -3.2  45%  $12.50
  const NUMBER_RE = /\$?[-−]?(?:\d[\d,]*(?:\.\d+)*|\.\d+)%?/g;
  // Words that flip or limit meaning.
  const NEGATION_RE = /\b(not|never|except|none|incorrect|false|least|most|fewer than|more than|no more than|no less than|at least|at most|cannot|isn't|aren't|doesn't|don't|won't|differ)\b/gi;
  // Sentence openers that mark "this is the actual task".
  const DIRECTIVE_RE = /^(?:<[bi]>)?(which|what|why|how|calculate|compute|find|determine|identify|select|choose|state|explain|interpret|describe|give|report|write|is|are|does|do|can|should|would|based on|using|according to|research question)\b/i;

  // ---------- helpers ----------

  const plain = (t) => String(t || "").replace(TOKEN_RE, " ").replace(TAG_RE, "");
  const tokens = (t) => String(t || "").match(TOKEN_RE) || [];

  function normalizeSpace(text) {
    return String(text || "").replace(/ /g, " ").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{2,}/g, "\n").trim();
  }

  function extractNumbers(text) {
    return (plain(text).match(NUMBER_RE) || [])
      .map((n) => n.replace(/−/g, "-").replace(/[$,%]/g, ""))
      .filter((n) => /\d/.test(n))
      .map((n) => n.replace(/\.$/, ""));
  }

  // Close tags at the end of a piece and re-open them at the start of the next,
  // so emphasis survives when a sentence is cut in two.
  function balanceTags(pieces) {
    const open = { b: false, i: false };
    return pieces.map((p) => {
      let prefix = (open.b ? "<b>" : "") + (open.i ? "<i>" : "");
      (p.match(TAG_RE) || []).forEach((t) => { open[t[t.length - 2]] = !t.startsWith("</"); });
      let suffix = (open.i ? "</i>" : "") + (open.b ? "</b>" : "");
      return (prefix + p + suffix).replace(/<([bi])>\s*<\/\1>/g, "");
    });
  }

  function splitSentences(text) {
    let t = normalizeSpace(text);
    ABBREVIATIONS.forEach((abbr, i) => { t = t.split(abbr).join(`__ABBR${i}__`); });

    // 1) lines, 2) join a short "Label:" line with the line after it, 3) sentences.
    const lines = t.split("\n").map((s) => s.trim()).filter(Boolean);
    const joined = [];
    for (let i = 0; i < lines.length; i++) {
      const words = plain(lines[i]).trim().split(/\s+/).length;
      if (/:\s*(<\/[bi]>)*$/.test(lines[i]) && words <= 5 && i + 1 < lines.length) {
        joined.push(lines[i] + " " + lines[i + 1]);
        i++;
      } else joined.push(lines[i]);
    }

    const out = [];
    joined.forEach((line) => {
      line
        .split(/(?<=[.?!](?:<\/[bi]>)*)\s+(?=(?:<[bi]>)*[A-Z(“"$⟦])/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach((s) => out.push(s));
    });

    return balanceTags(out).map((s) => ABBREVIATIONS.reduce((acc, abbr, i) => acc.split(`__ABBR${i}__`).join(abbr), s));
  }

  function isTaskSentence(s) {
    const p = plain(s).trim();
    return /\?\s*$/.test(p) || DIRECTIVE_RE.test(s.trim());
  }

  // Finds "(a) … (b) … (c) …" and splits it into labelled parts.
  function splitParts(text) {
    const marks = [];
    const re = /(^|\s)\(([a-h])\)\s/g;
    let m, expect = "a";
    while ((m = re.exec(text))) {
      if (m[2] === expect) { marks.push({ letter: m[2], at: m.index + m[1].length }); expect = String.fromCharCode(expect.charCodeAt(0) + 1); }
    }
    if (marks.length < 2) return null;
    const parts = marks.map((mk, i) => {
      const end = i + 1 < marks.length ? marks[i + 1].at : text.length;
      return `(${mk.letter}) ` + text.slice(mk.at + 4, end).trim();
    });
    return { before: text.slice(0, marks[0].at).trim(), parts };
  }

  // ---------- rule-based restructuring ----------

  function ruleFormat(questionText, choices) {
    const task = [], given = [], context = [];
    const multi = splitParts(normalizeSpace(questionText).replace(/\n/g, " \n"));
    const body = multi ? multi.before : questionText;

    const sentences = splitSentences(body);
    sentences.forEach((s) => {
      if (!multi && isTaskSentence(s)) task.push(s);
      else if (extractNumbers(s).length || tokens(s).length) given.push(s);
      else context.push(s);
    });

    if (multi) multi.parts.forEach((p) => task.push(p.replace(/\s*\n\s*/g, " ")));

    // If nothing looked like a task, the last sentence usually is.
    if (!task.length && sentences.length) {
      const last = sentences[sentences.length - 1];
      task.push(last);
      [given, context].forEach((arr) => { const i = arr.lastIndexOf(last); if (i !== -1) arr.splice(i, 1); });
    }

    return { source: "rules", task, given, context, choices: (choices || []).slice() };
  }

  // ---------- safety checks ----------

  function multiset(arr) {
    const m = new Map();
    arr.forEach((x) => m.set(x, (m.get(x) || 0) + 1));
    return m;
  }
  function diff(before, after) {
    const missing = [], added = [];
    const a = multiset(before), b = multiset(after);
    a.forEach((n, k) => { if ((b.get(k) || 0) < n) missing.push(k); });
    b.forEach((n, k) => { if ((a.get(k) || 0) < n) added.push(k); });
    return { missing, added };
  }
  const allText = (s) => [...(s.task || []), ...(s.given || []), ...(s.context || []), ...(s.choices || [])].join(" \n ");

  // mathText: optional { "⟦M1⟧": "H₀ : μ = 10", … } so warnings can show the math readably.
  function validate(originalText, originalChoices, structured, mathText) {
    const warnings = [];
    const show = (tok) => (mathText && mathText[tok] ? mathText[tok] : tok);
    const origAll = originalText + " \n " + (originalChoices || []).join(" \n ");
    const newAll = allText(structured);

    const nums = diff(extractNumbers(origAll), extractNumbers(newAll));
    if (nums.missing.length) warnings.push(`Left out these numbers from the question: ${nums.missing.join(", ")}`);
    if (nums.added.length) warnings.push(`Added numbers that are not in the question: ${nums.added.join(", ")}`);

    const maths = diff(tokens(origAll), tokens(newAll));
    if (maths.missing.length) warnings.push(`Left out this math: ${maths.missing.map(show).join(" ; ")}`);
    if (maths.added.length) warnings.push(`Repeated or invented this math: ${maths.added.map(show).join(" ; ")}`);

    const norm = (c) => normalizeSpace(String(c).replace(TAG_RE, ""));
    const a = (originalChoices || []).map(norm), b = (structured.choices || []).map(norm);
    if (a.length !== b.length || a.some((c, i) => c !== b[i])) warnings.push("Changed or reordered the answer choices.");

    const neg = (t) => (plain(t).match(NEGATION_RE) || []).map((w) => w.toLowerCase());
    const negs = diff(neg(origAll), neg(newAll));
    if (negs.missing.length) warnings.push(`Dropped words that change the meaning: ${negs.missing.join(", ")}`);

    return warnings;
  }

  root.QRFormatter = { splitSentences, splitParts, extractNumbers, ruleFormat, validate, plain, tokens, normalizeSpace, NEGATION_RE, NUMBER_RE, TOKEN_RE };
  if (typeof module !== "undefined" && module.exports) module.exports = root.QRFormatter;
})(typeof globalThis !== "undefined" ? globalThis : this);
