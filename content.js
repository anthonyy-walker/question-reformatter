// content.js — runs on gradescope.com pages.
// Toolbar → find questions (or pick one) → show a broken-down version right
// ABOVE the original. The original stays untouched; you still answer there.

(function () {
  "use strict";
  const F = globalThis.QRFormatter;
  const M = globalThis.QRMath;
  const { h, buildSettings, loadSettings } = globalThis.QRUI;

  const PAGE_KEY = "p:" + location.origin + location.pathname;
  const EXTRA_SELECTORS = ['[class*="questionPrompt"]', '[class*="question--prompt"]', '[class*="problem--prompt"]', '[class*="question--body"]', ".question"];
  const TITLE_SELECTOR = 'h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="heading" i],[class*="points" i]';
  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|LABEL|BLOCKQUOTE|PRE|FIELDSET|LEGEND)$/;

  let settings = { ...globalThis.QRUI.DEFAULTS };
  let picking = false, collapsed = false, working = 0, hovered = null;
  const panels = new Map(); // question element -> panel controller
  let toolbarHost, bannerEl, toastEl, toastTimer;

  // ---------------------------------------------------------------- startup

  loadSettings().then((s) => {
    settings = s;
    renderToolbar();
    // Bring back panels from last visit (math may render late, so try twice).
    setTimeout(restorePanels, 900);
    setTimeout(restorePanels, 2600);
  });

  chrome.storage.onChanged.addListener((changes) => {
    let touched = false;
    ["mode", "textSize", "theme", "apiKey", "model"].forEach((k) => { if (changes[k]) { settings[k] = changes[k].newValue; touched = true; } });
    if (touched) { applyLook(); renderToolbar(); }
  });

  function rootAttrs(el, float) {
    el.classList.add("qr-root");
    if (float) el.classList.add("qr-float");
    el.setAttribute("data-theme", settings.theme || "light");
    el.setAttribute("data-size", settings.textSize || "normal");
    el.setAttribute("data-qr", "1");
    return el;
  }
  function applyLook() {
    document.querySelectorAll(".qr-root").forEach((el) => rootAttrs(el, el.classList.contains("qr-float")));
  }

  // ---------------------------------------------------------------- toolbar

  function renderToolbar() {
    if (!toolbarHost) { toolbarHost = rootAttrs(h("div.qr-toolbar-host"), true); document.body.appendChild(toolbarHost); }
    rootAttrs(toolbarHost, true);
    toolbarHost.classList.toggle("qr-collapsed", collapsed);
    toolbarHost.textContent = "";

    if (collapsed) {
      toolbarHost.append(h("button.qr-tab", { "aria-label": "Open Reformatter toolbar", onclick: () => { collapsed = false; renderToolbar(); } },
        h("span", { "aria-hidden": "true", style: { fontSize: "18px", lineHeight: 1 } }, "‹"), h("span.qr-tab-word", {}, "Reformatter")));
      return;
    }
    const isAI = settings.mode === "ai";
    const busy = working > 0;
    toolbarHost.append(h("div.qr-toolbar", { role: "toolbar", "aria-label": "Question Reformatter" },
      h("div.qr-tb-head", {},
        h("span.qr-tb-title", {}, "Reformatter"),
        h("button.qr-btn", { "aria-label": "Settings", onclick: openSettings }, gearIcon()),
        h("button.qr-btn", { "aria-label": "Collapse toolbar", onclick: () => { collapsed = true; renderToolbar(); } }, "›")),
      h(`button.qr-btn${busy ? ".qr-working" : ".qr-btn-primary"}`, { disabled: busy, onclick: reformatAll }, busy ? "Working…" : "Reformat questions"),
      h(`button.qr-btn${picking ? ".qr-pick-on" : ""}`, { disabled: busy, "aria-pressed": String(picking), onclick: togglePicking }, picking ? "Cancel picking" : "Pick a question"),
      h("div.qr-seg", { role: "radiogroup", "aria-label": "Mode" },
        h(`button.qr-btn${!isAI ? ".qr-on" : ""}`, { role: "radio", "aria-checked": String(!isAI), onclick: () => setMode("rules") }, isAI ? "Rules" : "✓ Rules"),
        h(`button.qr-btn${isAI ? ".qr-on" : ""}`, { role: "radio", "aria-checked": String(isAI), onclick: () => setMode("ai") }, isAI ? "✓ AI" : "AI")),
      busy && h("p.qr-tb-status", { role: "status" }, "Finding questions on this page…")));
  }

  function gearIcon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", "20"); svg.setAttribute("height", "20"); svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor"); svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
    const c = document.createElementNS(NS, "circle"); c.setAttribute("cx", "12"); c.setAttribute("cy", "12"); c.setAttribute("r", "3");
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", "M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z");
    svg.append(c, p);
    return svg;
  }

  function setMode(m) { settings.mode = m; chrome.storage.local.set({ mode: m }); renderToolbar(); }

  // ---------------------------------------------------------------- settings pop-up

  async function openSettings() {
    const overlay = rootAttrs(h("div.qr-overlay"), true);
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
    const onKey = (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
    document.addEventListener("keydown", onKey, true);
    overlay.append(await buildSettings({ onClose: close, onSaved: (v) => { settings = { ...settings, ...v }; applyLook(); renderToolbar(); } }));
    document.body.appendChild(overlay);
    const first = overlay.querySelector("button"); if (first) first.focus();
  }

  // ---------------------------------------------------------------- toast + banner

  function toast(msg) {
    if (toastEl) toastEl.remove();
    clearTimeout(toastTimer);
    toastEl = rootAttrs(h(`div.qr-toast${collapsed ? ".qr-toast-collapsed" : ""}`, { role: "status" },
      h("span.qr-info-icon", { "aria-hidden": "true" }, "i"),
      h("span", { style: { flex: 1 } }, msg),
      h("button.qr-btn", { "aria-label": "Dismiss message", onclick: () => toastEl && toastEl.remove() }, "✕")), true);
    document.body.appendChild(toastEl);
    toastTimer = setTimeout(() => toastEl && toastEl.remove(), 7000);
  }

  // ---------------------------------------------------------------- pick mode

  function togglePicking() {
    picking = !picking;
    document.body.classList.toggle("qr-picking", picking);
    if (picking) {
      bannerEl = rootAttrs(h("div.qr-banner", { role: "status" },
        h("span", {}, "Click the question you want reformatted. Press Esc to cancel."),
        h("button.qr-btn", { onclick: togglePicking }, "Cancel")), true);
      document.body.appendChild(bannerEl);
    } else {
      if (bannerEl) bannerEl.remove();
      clearHover();
    }
    renderToolbar();
  }
  function clearHover() { if (hovered) hovered.classList.remove("qr-pick-hover"); hovered = null; }

  document.addEventListener("mouseover", (e) => {
    if (!picking || e.target.closest("[data-qr]")) return;
    clearHover();
    hovered = e.target.closest("p,div,section,li,label,form") || e.target;
    hovered.classList.add("qr-pick-hover");
  }, true);

  document.addEventListener("click", (e) => {
    if (!picking || e.target.closest("[data-qr]")) return;
    e.preventDefault(); e.stopPropagation();
    const target = hovered || e.target;
    togglePicking();
    processElement(growToQuestion(target), { mode: settings.mode });
  }, true);

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) togglePicking(); });

  // If the student clicked just the paragraph, include the choices that belong to it.
  function growToQuestion(el) {
    let scope = el;
    for (let i = 0; i < 4 && !findChoices(scope).length && scope.parentElement && scope.parentElement !== document.body; i++) {
      const up = scope.parentElement;
      if (up.querySelectorAll('input[type="radio"],input[type="checkbox"]').length > 8) break;
      if (textLen(up) > textLen(scope) * 4 + 200) break; // went too far up
      scope = up;
    }
    return findChoices(scope).length ? scope : el;
  }
  const textLen = (el) => (el.textContent || "").replace(/\s+/g, " ").trim().length;

  // ---------------------------------------------------------------- finding questions

  function findQuestionElements() {
    const found = new Set();
    // 1) Every group of radio buttons / checkboxes / text boxes is one question.
    const groups = new Map();
    document.querySelectorAll('input[type="radio"],input[type="checkbox"],textarea').forEach((inp) => {
      if (inp.closest("[data-qr]")) return;
      const key = inp.name ? inp.type + ":" + inp.name : "solo:" + Math.random();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(inp);
    });
    const allInputs = [...groups.values()].flat();
    groups.forEach((inputs) => {
      let q = commonAncestor(inputs);
      if (!q) return;
      while (q.parentElement && q.parentElement !== document.body && questionTextLen(q) < 40) {
        const up = q.parentElement;
        if (allInputs.some((i) => up.contains(i) && !inputs.includes(i))) break; // would swallow another question
        q = up;
      }
      if (questionTextLen(q) >= 20) found.add(q);
    });
    // 2) Long text blocks with no inputs (shared scenario / background).
    EXTRA_SELECTORS.forEach((sel) => document.querySelectorAll(sel).forEach((el) => {
      if (el.closest("[data-qr]") || el.querySelector("input,textarea")) return;
      if ([...found].some((f) => f.contains(el) || el.contains(f))) return;
      if (textLen(el) > 150) found.add(el);
    }));
    // keep the innermost, in page order
    const list = [...found].filter((n) => ![...found].some((m) => m !== n && n.contains(m)));
    return list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function commonAncestor(nodes) {
    if (!nodes.length) return null;
    let a = nodes[0].parentElement;
    while (a && !nodes.every((n) => a.contains(n))) a = a.parentElement;
    return a;
  }
  function questionTextLen(q) {
    const skip = new Set(findChoices(q).map((c) => c.container));
    return F.plain(extractRich(q, { skip, math: newMathRegistry() })).replace(/\s+/g, " ").trim().length;
  }

  // ---------------------------------------------------------------- choices

  function findChoices(scope) {
    const inputs = [...scope.querySelectorAll('input[type="radio"],input[type="checkbox"]')].filter((i) => !i.closest("[data-qr]"));
    return inputs.map((input) => {
      let container = input.id && scope.querySelector(`label[for="${CSS.escape(input.id)}"]`);
      if (!container) container = input.closest("label");
      if (!container) {
        container = input;
        while (container.parentElement && container.parentElement !== scope &&
          container.parentElement.querySelectorAll('input[type="radio"],input[type="checkbox"]').length === 1) container = container.parentElement;
      }
      return { input, container };
    });
  }

  // ---------------------------------------------------------------- reading the DOM into "rich text"

  function newMathRegistry() {
    const list = [];
    return {
      list,
      add(info, node) {
        const token = `⟦M${list.length + 1}⟧`;
        const text = (info.text || "").trim();
        list.push({ token, text, tex: info.tex || "", spoken: M.toSpoken(text), node });
        return token;
      },
    };
  }

  // Walks an element and returns text with ⟦Mn⟧ for math and <b>/<i> for emphasis.
  function extractRich(rootEl, { skip, math }) {
    let out = "";
    (function walk(n) {
      if (n.nodeType === 3) {
        out += n.nodeValue.replace(M.RAW_TEX_RE, (_m, a, b, c) => {
          const tex = a || b || c;
          return " " + math.add({ tex, text: M.texToText(tex) }, null) + " ";
        });
        return;
      }
      if (n.nodeType !== 1) return;
      const el = n;
      if (skip && skip.has(el)) return;
      if (el.matches("[data-qr], input, button, textarea, select, style, noscript, svg")) return;
      if (el.tagName === "SCRIPT") {
        // Un-rendered MathJax 2 source (no rendered copy next to it).
        if (/math\/tex/.test(el.type) && !(el.previousElementSibling && /MathJax/.test(el.previousElementSibling.className))) {
          out += " " + math.add({ tex: el.textContent, text: M.texToText(el.textContent) }, null) + " ";
        }
        return;
      }
      if (M.isMathSourceOrPreview(el) || el.classList.contains("katex-mathml")) return;

      const info = M.readMathElement(el);
      if (info && info.text) { out += math.add(info, el); return; }

      if (el.tagName === "IMG") { if (el.alt) out += ` ${el.alt} `; return; }
      if (el.tagName === "BR") { out += "\n"; return; }
      const block = BLOCK.test(el.tagName);
      const bold = /^(B|STRONG)$/.test(el.tagName) || (el.style && Number(el.style.fontWeight) >= 600);
      const ital = /^(I|EM)$/.test(el.tagName);
      if (block) out += "\n";
      if (bold) out += "<b>";
      if (ital) out += "<i>";
      el.childNodes.forEach(walk);
      if (ital) out += "</i>";
      if (bold) out += "</b>";
      if (block) out += "\n";
    })(rootEl);

    return out
      .replace(/<([bi])>(\s*)<\/\1>/g, "$2")
      .replace(/[ \t ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .split("\n")
      .filter((line) => !/^\s*(<[bi]>)*\s*\d+(\.\d+)?\s+points?\s*(<\/[bi]>)*\s*$/i.test(line))  // "2 Points"
      .filter((line, i) => !(i < 2 && /^\s*(<[bi]>)*\s*Q\d+(\.\d+)*\b/.test(line) && F.plain(line).length < 90)) // "Q1 Scenario 1" title
      .join("\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  }

  function questionTitle(q) {
    const t = q.querySelector(TITLE_SELECTOR);
    const txt = t && !t.closest("label") ? t.textContent.replace(/\s+/g, " ").trim() : "";
    return txt && txt.length < 90 ? txt.replace(/\s*\d+(\.\d+)?\s*points?$/i, "") : "this question";
  }

  function titleNodes(q) {
    return [...q.querySelectorAll(TITLE_SELECTOR)].filter((t) => !t.closest("label") && t.textContent.trim().length < 90 && !t.querySelector("input"));
  }

  // Reads one question: text, choices and the math inside both.
  function readQuestion(q) {
    const math = newMathRegistry();
    const choiceInfo = findChoices(q);
    const skip = new Set([...choiceInfo.map((c) => c.container), ...titleNodes(q)]);
    const text = extractRich(q, { skip, math });
    const choices = choiceInfo.map((c) => extractRich(c.container, { skip: new Set(), math }));
    return { text, choices, choiceInfo, math: math.list, title: questionTitle(q) };
  }

  // ---------------------------------------------------------------- page memory (re-open panels on return)

  function signature(read) {
    const s = JSON.stringify([read.text, read.choices, read.math.map((m) => m.text)]);
    let h1 = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h1 ^= s.charCodeAt(i); h1 = Math.imul(h1, 16777619); }
    return (h1 >>> 0).toString(36) + ":" + s.length;
  }
  // Element paths ignore our own panels, so they stay valid on the next visit.
  const realKids = (n) => [...n.children].filter((c) => !c.hasAttribute("data-qr"));
  function pathTo(el) {
    const path = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) path.unshift(realKids(n.parentElement).indexOf(n));
    return path;
  }
  function fromPath(path) { return path.reduce((n, i) => (n ? realKids(n)[i] : null), document.body); }

  // Kept in memory and written as a whole, so several panels saving at once can't overwrite each other.
  let pageList = null;
  const pageListReady = new Promise((res) => chrome.storage.local.get(PAGE_KEY, (s) => { pageList = s[PAGE_KEY] || []; res(); }));
  function writePageList() { chrome.storage.local.set({ [PAGE_KEY]: pageList }); }
  async function remember(sig, el, mode) {
    await pageListReady;
    pageList = pageList.filter((e) => e.sig !== sig);
    pageList.push({ sig, path: pathTo(el), mode });
    writePageList();
  }
  async function forget(sig) {
    await pageListReady;
    pageList = pageList.filter((e) => e.sig !== sig);
    writePageList();
  }

  function restorePanels() {
    pageListReady.then(() => {
      const saved = pageList.slice();
      if (!saved.length) return;
      const candidates = new Set(findQuestionElements());
      saved.forEach((e) => { const el = fromPath(e.path); if (el) candidates.add(el); });
      candidates.forEach((el) => {
        if (panels.has(el)) return;
        const read = readQuestion(el);
        const entry = saved.find((e) => e.sig === signature(read));
        if (entry) processElement(el, { mode: entry.mode, restoring: true, read });
      });
    });
  }

  // ---------------------------------------------------------------- reformatting

  function reformatAll() {
    const qs = findQuestionElements();
    if (!qs.length) { toast("Couldn't find questions automatically. Use Pick a question."); return; }
    qs.forEach((q) => processElement(q, { mode: settings.mode }));
  }

  function processElement(q, { mode, restoring, read }) {
    read = read || readQuestion(q);
    if (F.plain(read.text).replace(/\s+/g, "").length < 5 && !read.choices.length) {
      toast("That part of the page doesn't have enough text. Try clicking the question paragraph itself.");
      return;
    }
    const sig = signature(read);
    const old = panels.get(q);
    if (old) old.remove();

    const ctrl = makePanel(q, read, () => { panels.delete(q); forget(sig); });
    panels.set(q, ctrl);

    const rules = F.ruleFormat(read.text, read.choices);
    const showRules = (extra) => { ctrl.show(rules, { label: "Rules · original words", ...extra }); remember(sig, q, "rules"); };
    if (mode !== "ai") { showRules(); return; }

    ctrl.loading();
    working++; renderToolbar();
    chrome.runtime.sendMessage({
      type: "QR_AI_REFORMAT", text: read.text, choices: read.choices,
      math: read.math.map(({ token, text }) => ({ token, text })),
      cacheOnly: !!restoring, // coming back to a page never spends tokens on its own
    }, (resp) => {
      working--; renderToolbar();
      if (!resp || !resp.ok) {
        showRules({ warnTitle: "Showing the Rules version instead", warnText: "The AI didn't respond:", warnings: [resp ? resp.error : "No response from the extension."] });
        return;
      }
      const { structured, notes, cached, miss } = resp.result;
      if (miss) { showRules(); return; }
      const fixedNote = notes && notes.length ? { noteTitle: "Fixed automatically", noteText: "The AI's layout is kept. These spots were corrected using the question's own words:", notes } : {};
      ctrl.show(structured, { label: cached ? "AI · checked · saved, no new cost" : "AI · checked", ...fixedNote });
      remember(sig, q, "ai");
    });
  }

  // ---------------------------------------------------------------- the panel

  function makePanel(q, read, onClosed) {
    const mathByToken = Object.fromEntries(read.math.map((m) => [m.token, m]));
    const panel = rootAttrs(h("div.qr-panel", { role: "region", "aria-label": "Reformatted view of " + read.title }), false);
    q.parentNode.insertBefore(panel, q);

    let data = null, meta = {}, pending = null, part = 0;

    const inputListener = () => data && draw();
    read.choiceInfo.forEach((c) => c.input.addEventListener("change", inputListener));

    function remove() {
      read.choiceInfo.forEach((c) => c.input.removeEventListener("change", inputListener));
      panel.remove();
    }
    function close() { remove(); onClosed(); }

    function header() {
      return h("div.qr-header", {},
        h("span.qr-qlabel", {}, `Reformatted · ${read.title}` + (meta.label ? ` · ${meta.label}` : "")),
        h("div.qr-header-actions", {}, h("button.qr-btn.qr-btn-icon", { "aria-label": "Close reformatted view", onclick: close }, "✕")));
    }

    function loading() {
      panel.textContent = "";
      panel.append(header(), h("p.qr-loading", { role: "status" }, "Reformatting…"));
    }

    // Renders rich text: math tokens, <b>/<i>, and bold numbers / meaning-flipping words.
    function rich(str) {
      const frag = document.createDocumentFragment();
      const stack = [frag];
      const top = () => stack[stack.length - 1];
      String(str).split(/(⟦M\d+⟧|<\/?[bi]>)/).forEach((piece) => {
        if (!piece) return;
        if (piece === "<b>" || piece === "<i>") { const e = h(piece === "<b>" ? "b" : "i"); top().append(e); stack.push(e); return; }
        if (piece === "</b>" || piece === "</i>") { if (stack.length > 1) stack.pop(); return; }
        if (/^⟦M\d+⟧$/.test(piece)) { top().append(mathNode(piece)); return; }
        highlight(top(), piece);
      });
      return frag;
    }

    function mathNode(token) {
      const m = mathByToken[token];
      if (!m) return document.createTextNode(token);
      const wrap = h("span.qr-math", { role: "img", "aria-label": m.spoken || m.text, title: m.spoken || m.text });
      if (m.node) {
        const clone = m.node.cloneNode(true);
        clone.removeAttribute("id");
        clone.querySelectorAll('[id^="MathJax-Element"]').forEach((e) => e.removeAttribute("id"));
        clone.setAttribute("aria-hidden", "true");
        wrap.append(clone);
      } else {
        wrap.append(h("span.qr-math-text", { "aria-hidden": "true" }, m.text));
      }
      return wrap;
    }

    function highlight(target, text) {
      const re = new RegExp(`(${F.NUMBER_RE.source})|(${F.NEGATION_RE.source})`, "gi");
      let last = 0, m;
      while ((m = re.exec(text))) {
        if (!m[0]) { re.lastIndex++; continue; }
        const isNum = m[1] && /\d/.test(m[1]);
        if (!isNum && !m[2]) continue;
        if (m.index > last) target.append(document.createTextNode(text.slice(last, m.index)));
        target.append(h("span.qr-hl", {}, m[0]));
        last = m.index + m[0].length;
      }
      if (last < text.length) target.append(document.createTextNode(text.slice(last)));
    }

    const row = (str, cls = "") => h("div.qr-row", {}, h("span.qr-mark", { "aria-hidden": "true" }, "◦"), h(`span.qr-text${cls}`, {}, rich(str)));
    const label = (txt) => h("div.qr-label", {}, h("span", { "aria-hidden": "true" }, "•"), h("span", {}, txt));

    function askedSection() {
      const parts = data.task.length >= 2 && data.task.every((t) => /^(<[bi]>)*\(([a-h])\)/.test(t)) ? data.task : null;
      const sec = h("section.qr-sec", { "aria-label": "What you're asked" }, label("What you're asked"));
      if (!parts) { data.task.forEach((t) => sec.append(row(t))); return sec; }

      part = Math.min(part, parts.length - 1);
      const letterOf = (t) => t.match(/\(([a-h])\)/)[1];
      const cur = parts[part];
      sec.append(h("div.qr-stepper", {},
        h("div.qr-step-top", {},
          h("span.qr-step-count", {}, `Part ${letterOf(cur)} of ${parts.length}`),
          h("div.qr-step-tabs", { "aria-label": "Parts" }, parts.map((t, i) =>
            h(`button.qr-btn.qr-btn-icon${i === part ? ".qr-tab-on" : ""}`, { "aria-label": "Part " + letterOf(t), "aria-current": i === part ? "step" : null, onclick: () => { part = i; draw(); } }, letterOf(t))))),
        h("p.qr-text", {}, h("span.qr-part-tag", {}, `(${letterOf(cur)}) `), rich(cur.replace(/^(<[bi]>)*\([a-h]\)\s*/, "$1"))),
        h("div.qr-step-nav", {},
          h("button.qr-btn", { disabled: part <= 0, onclick: () => { part--; draw(); } }, "‹ Previous part"),
          h("button.qr-btn", { disabled: part >= parts.length - 1, onclick: () => { part++; draw(); } }, "Next part ›"))));
      return sec;
    }

    function symbolsSection() {
      const used = new Set((allStrings().join(" ").match(F.TOKEN_RE) || []));
      const text = read.math.filter((m) => used.has(m.token)).map((m) => m.text).join(" ");
      const gloss = M.glossary(text);
      if (!gloss.length) return null;
      return h("section.qr-sec", { "aria-label": "Symbols" }, label("Symbols — how to say them"),
        h("div.qr-symbols", {}, gloss.map(([sym, say]) => h("span.qr-sym", {}, h("span.qr-sym-glyph", {}, sym), `“${say}”`))));
    }
    const allStrings = () => [...data.task, ...data.given, ...data.context, ...data.choices];

    function choicesSection() {
      const sec = h("section.qr-sec", { "aria-label": "Answer choices" }, label("Answer choices"));
      if (!data.choices.length) {
        sec.append(h("p.qr-empty", {}, "Written answer. Type it in the answer box on the page."));
        return h("div.qr-box", {}, sec);
      }
      const list = h("div.qr-choices", {});
      data.choices.forEach((c, i) => {
        const letter = String.fromCharCode(65 + i);
        const info = read.choiceInfo[i];
        const isSel = !!(info && info.input.checked);
        const isPend = pending === i && !isSel;
        const btn = h(`button.qr-choice${isSel ? ".qr-selected" : ""}${isPend ? ".qr-pending" : ""}`, { "aria-pressed": String(isSel), onclick: () => { if (!isSel && info) { pending = i; draw(); } } },
          h("span.qr-letter", {}, letter + "."),
          h("span.qr-choice-text", {}, rich(c)),
          isSel && h("span.qr-tag-sel", {}, "✓ Selected"),
          isPend && h("span.qr-tag-pend", {}, "Confirm?"));
        const wrap = h("div.qr-choice-wrap", {}, btn);
        if (isPend) {
          wrap.append(h("div.qr-confirm", { role: "group", "aria-label": "Confirm answer" },
            h("span.qr-confirm-q", {}, `Select ${letter} on the page?`),
            h("button.qr-btn.qr-btn-primary", { onclick: () => selectOnPage(info, letter) }, `Yes, select ${letter}`),
            h("button.qr-btn", { onclick: () => { pending = null; draw(); } }, "Cancel")));
        }
        list.append(wrap);
      });
      sec.append(list);
      return h("div.qr-box", {}, sec);
    }

    function selectOnPage(info, letter) {
      pending = null;
      info.input.click();
      if (!info.input.checked) { info.input.checked = true; info.input.dispatchEvent(new Event("change", { bubbles: true })); }
      draw();
      toast(`Answer ${letter} is now selected on the page. Remember to save your answer there.`);
    }

    function draw() {
      const focusedLabel = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.textContent : null;
      panel.textContent = "";
      panel.append(header());
      if (meta.warnings && meta.warnings.length) {
        panel.append(h("div.qr-warn", { role: "status" },
          h("span.qr-info-icon", { "aria-hidden": "true" }, "i"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } },
            h("p.qr-warn-title", {}, meta.warnTitle),
            h("p.qr-warn-text", {}, meta.warnText),
            h("ul.qr-warn-list", {}, meta.warnings.map((w) => h("li", {}, w))))));
      }
      if (meta.notes && meta.notes.length) {
        panel.append(h("div.qr-note", { role: "status" },
          h("span.qr-info-icon", { "aria-hidden": "true" }, "i"),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } },
            h("p.qr-warn-title", {}, meta.noteTitle),
            h("p.qr-warn-text", {}, meta.noteText),
            h("ul.qr-warn-list", {}, meta.notes.map((w) => h("li", {}, w))))));
      }
      const qbox = h("div.qr-box", {});
      if (data.task.length) qbox.append(askedSection());
      if (data.given.length) {
        const g = h("section.qr-sec", { "aria-label": "Given" }, label("Given"));
        data.given.forEach((t) => g.append(row(t)));
        qbox.append(g);
      }
      const c = h("section.qr-sec", { "aria-label": "Context" }, label("Context"));
      if (data.context.length) data.context.forEach((t) => c.append(row(t)));
      else c.append(h("p.qr-empty", {}, "No background in this question."));
      qbox.append(c);
      const sym = symbolsSection(); if (sym) qbox.append(sym);
      panel.append(qbox, choicesSection());
      // keep keyboard focus where it was
      if (focusedLabel) { const b = [...panel.querySelectorAll("button")].find((x) => x.textContent === focusedLabel); if (b) b.focus(); }
    }

    return {
      remove, loading,
      show(d, m) { data = d; meta = m || {}; draw(); },
    };
  }
})();
