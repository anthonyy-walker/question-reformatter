// math.js
// Turns math on the page (MathJax 2/3, KaTeX, MathML, TeX source) into:
//   - text:   readable Unicode, e.g. "H₀ : μ = 10"
//   - spoken: how to say it, e.g. "H-naught, colon, mu equals 10"
// It never changes what the math says. It only changes how it is written out.

(function (root) {
  "use strict";

  const GREEK = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", theta: "θ",
    lambda: "λ", mu: "μ", nu: "ν", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ",
    varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", eta: "η", kappa: "κ", xi: "ξ", zeta: "ζ",
    Delta: "Δ", Sigma: "Σ", Pi: "Π", Omega: "Ω", Theta: "Θ", Lambda: "Λ", Phi: "Φ", Gamma: "Γ",
  };

  const SYMBOLS = {
    neq: "≠", ne: "≠", leq: "≤", le: "≤", geq: "≥", ge: "≥", lt: "<", gt: ">",
    pm: "±", mp: "∓", times: "×", cdot: "·", div: "÷", approx: "≈", sim: "~",
    infty: "∞", to: "→", rightarrow: "→", leftarrow: "←", sum: "Σ", prod: "Π",
    in: "∈", notin: "∉", cup: "∪", cap: "∩", mid: "|", vert: "|", ldots: "…", dots: "…", cdots: "⋯",
    "%": "%", "$": "$", "&": "&", "#": "#", "{": "{", "}": "}", "_": "_",
  };

  const SUB = { 0: "₀", 1: "₁", 2: "₂", 3: "₃", 4: "₄", 5: "₅", 6: "₆", 7: "₇", 8: "₈", 9: "₉",
    a: "ₐ", e: "ₑ", o: "ₒ", x: "ₓ", h: "ₕ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", p: "ₚ", s: "ₛ", t: "ₜ",
    i: "ᵢ", j: "ⱼ", r: "ᵣ", u: "ᵤ", v: "ᵥ", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" };
  const SUP = { 0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴", 5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹",
    n: "ⁿ", i: "ⁱ", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", T: "ᵀ" };

  // How each symbol is said out loud. Pronunciation only — no definitions.
  const SPOKEN = {
    "μ": "mu", "π": "pi", "σ": "sigma", "α": "alpha", "β": "beta", "ρ": "rho", "θ": "theta",
    "λ": "lambda", "χ": "chi", "ε": "epsilon", "δ": "delta", "γ": "gamma", "τ": "tau",
    "φ": "phi", "ψ": "psi", "ω": "omega", "η": "eta", "ν": "nu", "Σ": "sigma (sum)", "Δ": "delta",
    "H₀": "H-naught", "Hₐ": "H-a", "H_A": "H-a",
    "p̂": "p-hat", "x̄": "x-bar", "ȳ": "y-bar", "ŷ": "y-hat", "μ̂": "mu-hat", "β̂": "beta-hat",
    "≠": "is not equal to", "≤": "is less than or equal to", "≥": "is greater than or equal to",
    "<": "is less than", ">": "is greater than", "=": "equals", "≈": "is approximately",
    "±": "plus or minus", "×": "times", "·": "times", "÷": "divided by", "√": "square root of",
    "∞": "infinity", "→": "goes to",
  };

  const subscript = (s) => (s && [...s].every((c) => SUB[c]) ? [...s].map((c) => SUB[c]).join("") : `_(${s})`);
  const superscript = (s) => (s && [...s].every((c) => SUP[c]) ? [...s].map((c) => SUP[c]).join("") : `^(${s})`);

  // ---------- TeX -> readable Unicode ----------

  function texToText(tex) {
    let i = 0;
    const s = String(tex || "").trim();

    function readGroup() {
      // Reads {…} or a single token after ^, _, \hat etc.
      skipSpace();
      if (s[i] === "{") {
        let depth = 0, start = i + 1;
        for (; i < s.length; i++) {
          if (s[i] === "{") depth++;
          else if (s[i] === "}" && --depth === 0) { const inner = s.slice(start, i); i++; return texToText(inner); }
        }
        return texToText(s.slice(start));
      }
      if (s[i] === "\\") return readCommand();
      return s[i++] || "";
    }
    function skipSpace() { while (i < s.length && s[i] === " ") i++; }
    function readCommand() {
      i++; // skip backslash
      let name = "";
      const isLetter = () => i < s.length && /[a-zA-Z]/.test(s[i]);
      if (isLetter()) { while (isLetter()) name += s[i++]; }
      else name = s[i++] || "";
      if (GREEK[name]) return GREEK[name];
      if (SYMBOLS[name]) return SYMBOLS[name];
      switch (name) {
        case "hat": case "widehat": return readGroup() + "\u0302";
        case "bar": case "overline": return readGroup() + "\u0304";
        case "tilde": return readGroup() + "\u0303";
        case "vec": return readGroup() + "\u20d7";
        case "frac": case "dfrac": case "tfrac": { const a = readGroup(), b = readGroup(); return `${wrap(a)}/${wrap(b)}`; }
        case "sqrt": return "√" + wrap(readGroup());
        case "text": case "textrm": case "mathrm": case "mathit": case "mathbf": case "textbf": case "textit": case "operatorname": case "mbox": return readGroup();
        case "left": case "right": case "big": case "Big": case "bigg": case "Bigg": case "displaystyle": case "limits": return "";
        case ",": case ";": case ":": case " ": case "quad": case "qquad": case "!": return " ";
        case "\\": return " ";
        case "vs": return "vs";
        default: return name; // unknown command: keep its name rather than lose it
      }
    }
    function wrap(x) { return /^[\w.\u0300-\u036f]+$/.test(x) ? x : `(${x})`; }

    let out = "";
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\\") out += readCommand();
      else if (ch === "_") { i++; out += subscript(readGroup()); }
      else if (ch === "^") { i++; out += superscript(readGroup()); }
      else if (ch === "{") out += readGroup();
      else if (ch === "}") i++;
      else if (ch === "~") { out += " "; i++; }
      else { out += ch; i++; }
    }
    return tidy(out);
  }

  function tidy(t) {
    return t
      .replace(/\s+/g, " ")
      .replace(/\s*([=≠<>≤≥≈])\s*/g, " $1 ")
      .replace(/\s*:\s*/g, " : ")
      .replace(/\s+,/g, ",")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---------- MathML -> readable Unicode ----------

  function mathmlToText(node) {
    if (!node) return "";
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return "";
    const tag = node.localName;
    const kids = [...node.children];
    const all = () => kids.map(mathmlToText).join("");
    switch (tag) {
      case "annotation": case "annotation-xml": return "";
      case "semantics": return mathmlToText(kids[0]);
      case "msub": return mathmlToText(kids[0]) + subscript(mathmlToText(kids[1]).trim());
      case "msup": return mathmlToText(kids[0]) + superscript(mathmlToText(kids[1]).trim());
      case "msubsup": return mathmlToText(kids[0]) + subscript(mathmlToText(kids[1]).trim()) + superscript(mathmlToText(kids[2]).trim());
      case "mfrac": return `(${mathmlToText(kids[0])})/(${mathmlToText(kids[1])})`;
      case "msqrt": return `√(${all()})`;
      case "mover": {
        const base = mathmlToText(kids[0]), acc = mathmlToText(kids[1]).trim();
        if (/^[\^ˆ\u0302]$/.test(acc)) return base + "\u0302";
        if (/^[¯_‾\u0304\u2015-]$/.test(acc)) return base + "\u0304";
        if (/^[~˜\u0303]$/.test(acc)) return base + "\u0303";
        return base + acc;
      }
      case "mo": { const t = node.textContent.trim(); return t === "≠" || /^[=<>≤≥≈:]$/.test(t) ? ` ${t} ` : t; }
      case "mspace": return " ";
      case "mtext": return node.textContent;
      default:
        return kids.length ? all() : node.textContent;
    }
  }

  // ---------- readable Unicode -> spoken words ----------

  function toSpoken(text) {
    let t = ` ${text} `;
    // multi-character symbols first
    ["H₀", "Hₐ", "p̂", "x̄", "ȳ", "ŷ", "μ̂", "β̂"].forEach((sym) => {
      t = t.split(sym).join(` ${SPOKEN[sym]} `);
    });
    t = t.replace(/H_\(?A\)?/g, " H-a ");
    t = [...t].map((c) => (SPOKEN[c] ? ` ${SPOKEN[c]} ` : c)).join("");
    t = t.replace(/\s:\s/g, ", ").replace(/\bvs\b/g, "versus");
    t = t.replace(/[₀-₉]/g, (c) => " sub " + "0123456789"["₀₁₂₃₄₅₆₇₈₉".indexOf(c)]);
    t = t.replace(/²/g, " squared").replace(/³/g, " cubed");
    t = t.replace(/\s[-−]\s/g, " minus ").replace(/(\d)\/(\d)/g, "$1 over $2").replace(/\s\+\s/g, " plus ");
    return t.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
  }

  // Unique symbols in a piece of readable math, with how to say them.
  function glossary(text) {
    const found = [];
    const seen = new Set();
    ["H₀", "Hₐ", "p̂", "x̄", "ȳ", "ŷ", "μ̂", "β̂"].forEach((sym) => {
      if (text.includes(sym) && !seen.has(sym)) { seen.add(sym); found.push([sym, SPOKEN[sym]]); }
    });
    const stripped = ["H₀", "Hₐ", "p̂", "x̄", "ȳ", "ŷ", "μ̂", "β̂"].reduce((acc, s) => acc.split(s).join(" "), text);
    [...stripped].forEach((c) => {
      if (SPOKEN[c] && !seen.has(c) && !/^[=<>]$/.test(c)) { seen.add(c); found.push([c, SPOKEN[c]]); }
    });
    return found;
  }

  // ---------- reading math out of a DOM element ----------

  // Returns { tex, text } for a rendered math element, or null if it isn't math.
  function readMathElement(el) {
    if (!el || el.nodeType !== 1) return null;

    // KaTeX: TeX source is in the MathML annotation.
    const katex = el.classList.contains("katex") ? el : el.classList.contains("katex-display") ? el.querySelector(".katex") : null;
    if (katex) {
      const ann = katex.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) return { tex: ann.textContent, text: texToText(ann.textContent) };
      const mml = katex.querySelector("math");
      if (mml) return { tex: "", text: tidy(mathmlToText(mml)) };
    }

    // MathJax 2: rendered frame is followed by <script type="math/tex">.
    if (/^MathJax(_Display|_SVG|_CHTML|_SVG_Display|_CHTML_Display)?$/.test(el.className) || el.classList.contains("MathJax_SVG") || el.classList.contains("MathJax_CHTML") || el.classList.contains("MathJax")) {
      let sib = el.nextElementSibling;
      while (sib && sib.tagName !== "SCRIPT" && /MathJax/.test(sib.className)) sib = sib.nextElementSibling;
      if (sib && sib.tagName === "SCRIPT" && /math\/tex/.test(sib.type)) return { tex: sib.textContent, text: texToText(sib.textContent) };
      const mml = el.querySelector("math") || (el.getAttribute("data-mathml") && new DOMParser().parseFromString(el.getAttribute("data-mathml"), "text/xml").documentElement);
      if (mml) return { tex: "", text: tidy(mathmlToText(mml)) };
    }

    // MathJax 3: <mjx-container> with assistive MathML.
    if (el.localName === "mjx-container") {
      const mml = el.querySelector("mjx-assistive-mml math, math");
      if (mml) return { tex: "", text: tidy(mathmlToText(mml)) };
      const label = el.getAttribute("aria-label");
      if (label) return { tex: "", text: label };
    }

    // Plain MathML.
    if (el.localName === "math") return { tex: "", text: tidy(mathmlToText(el)) };

    return null;
  }

  function isMathSourceOrPreview(el) {
    return (el.tagName === "SCRIPT" && /math\/(tex|mml)/.test(el.type)) || el.classList.contains("MathJax_Preview") || el.classList.contains("MJX_Assistive_MathML");
  }

  // Raw TeX that was never rendered: \( … \), \[ … \], $$ … $$
  const RAW_TEX_RE = /\\\((.+?)\\\)|\\\[(.+?)\\\]|\$\$(.+?)\$\$/g;

  root.QRMath = { texToText, mathmlToText, toSpoken, glossary, readMathElement, isMathSourceOrPreview, RAW_TEX_RE, SPOKEN };
  if (typeof module !== "undefined" && module.exports) module.exports = root.QRMath;
})(typeof globalThis !== "undefined" ? globalThis : this);
