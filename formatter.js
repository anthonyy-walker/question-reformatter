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
    b.forEach((n, k) => { if (!a.has(k)) added.push(k); }); // repeating something from the question is fine; inventing is not
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


  // ---------- automatic repair ----------
  // Never throws the AI's layout away. Instead it patches only the spots that
  // broke a rule, using the question's own sentences, until every check passes.
  //   1. Answer choices: always the original ones, word for word.
  //   2. A line with a number or math that is NOT in the question: removed.
  //   3. Anything left out (number, math, meaning-changing word): the original
  //      sentence that contains it replaces the AI line most like it, or is added.
  const words = (t) => new Set(plain(t).toLowerCase().match(/[a-z0-9.]{3,}/g) || []);
  function overlap(a, b) {
    const A = words(a), B = words(b);
    if (!A.size || !B.size) return 0;
    let n = 0; A.forEach((w) => { if (B.has(w)) n++; });
    return n / Math.min(A.size, B.size);
  }

  function repair(originalText, originalChoices, structured) {
    const out = { ...structured, task: [...(structured.task || [])], given: [...(structured.given || [])], context: [...(structured.context || [])] };
    const notes = [];
    const SECTIONS = ["task", "given", "context"];
    const norm = (c) => normalizeSpace(String(c).replace(TAG_RE, ""));

    // 1. choices
    const choices = (originalChoices || []).slice();
    const same = choices.length === (out.choices || []).length && choices.every((c, i) => norm(c) === norm(out.choices[i]));
    if (!same) notes.push("Used the original answer choices, word for word.");
    out.choices = choices;

    // 2. remove lines with invented numbers or math
    const origNums = new Set(extractNumbers(originalText + " " + choices.join(" ")));
    const origToks = new Set(tokens(originalText + " " + choices.join(" ")));
    let removed = 0;
    SECTIONS.forEach((k) => {
      out[k] = out[k].filter((line) => {
        const bad = extractNumbers(line).some((n) => !origNums.has(n)) || tokens(line).some((t) => !origToks.has(t));
        if (bad) removed++;
        return !bad;
      });
    });
    if (removed) notes.push(`Removed ${removed} line${removed > 1 ? "s" : ""} that had something not in the question.`);

    // 3. put back what was left out
    const multi = splitParts(normalizeSpace(originalText).replace(/\n/g, " \n"));
    const sentences = multi ? [...splitSentences(multi.before), ...multi.parts] : splitSentences(originalText);
    const restored = { numbers: new Set(), math: new Set(), words: new Set() };
    const lowerNeg = (t) => (plain(t).match(NEGATION_RE) || []).map((w) => w.toLowerCase());

    // A line may only be swapped for the original sentence if the swap loses nothing:
    // every number, math piece and meaning-changing word in that line is also in the sentence.
    const contained = (line, source) => {
      const sn = extractNumbers(source), st = tokens(source), sw = lowerNeg(source);
      return extractNumbers(line).every((n) => sn.includes(n)) && tokens(line).every((t) => st.includes(t)) && lowerNeg(line).every((w) => sw.includes(w));
    };
    const origOrder = (line) => { const i = sentences.findIndex((x) => norm(x) === norm(line)); return i; };

    for (let round = 0; round < 60; round++) {
      const all = SECTIONS.flatMap((k) => out[k]).join(" \n ") + " \n " + choices.join(" \n ");
      const origAll = originalText + " \n " + choices.join(" \n ");
      const missing = [
        ...diff(extractNumbers(origAll), extractNumbers(all)).missing.map((v) => ["numbers", v, (x) => extractNumbers(x).includes(v)]),
        ...diff(tokens(origAll), tokens(all)).missing.map((v) => ["math", v, (x) => tokens(x).includes(v)]),
        ...diff(lowerNeg(origAll), lowerNeg(all)).missing.map((v) => ["words", v, (x) => lowerNeg(x).includes(v)]),
      ];
      const fixable = missing.find(([, , has]) => sentences.some(has));
      if (!fixable) break;
      const [kind, value, has] = fixable;
      const present = new Set(SECTIONS.flatMap((k) => out[k]).map(norm));
      const source = sentences.find((x) => has(x) && !present.has(norm(x))) || sentences.find(has);

      // Swap out the AI line most like the original sentence (only if nothing is lost), otherwise add the sentence.
      let best = null;
      SECTIONS.forEach((k) => out[k].forEach((line, i) => {
        if (norm(line) === norm(source) || !contained(line, source)) return;
        const score = overlap(line, source);
        if (score >= 0.3 && (!best || score > best.score)) best = { k, i, score };
      }));
      if (best) out[best.k][best.i] = source;
      else {
        const k = isTaskSentence(source) ? "task" : extractNumbers(source).length || tokens(source).length ? "given" : "context";
        // keep the question's order: put it right after the closest earlier original sentence already shown
        const myIdx = origOrder(source);
        let at = out[k].length;
        for (let j = out[k].length - 1; j >= 0; j--) { const o = origOrder(out[k][j]); if (o !== -1 && o < myIdx) { at = j + 1; break; } if (o > myIdx) at = j; }
        out[k].splice(at, 0, source);
      }
      restored[kind].add(value);
    }

    if (restored.numbers.size) notes.push(`Put back numbers the AI left out: ${[...restored.numbers].join(", ")}.`);
    if (restored.math.size) notes.push(`Put back ${restored.math.size} math expression${restored.math.size > 1 ? "s" : ""} the AI left out.`);
    if (restored.words.size) notes.push(`Put back words that change the meaning: ${[...restored.words].join(", ")}.`);
    if (!out.task.length) {
      const t = sentences.filter(isTaskSentence);
      out.task = t.length ? t : sentences.slice(-1);
      notes.push("Put back the question's task.");
    }
    return { structured: out, notes };
  }

  root.QRFormatter = { repair, splitSentences, splitParts, extractNumbers, ruleFormat, validate, plain, tokens, normalizeSpace, NEGATION_RE, NUMBER_RE, TOKEN_RE };
  if (typeof module !== "undefined" && module.exports) module.exports = root.QRFormatter;
})(typeof globalThis !== "undefined" ? globalThis : this);
