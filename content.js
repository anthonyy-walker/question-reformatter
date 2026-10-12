// content.js — runs on every page.
// • Gradescope (question mode): toolbar → find questions (or pick one) → a simpler
//   version appears right ABOVE the original. You still answer on the original.
// • Every other site (reading mode): long, dense paragraphs get a small Reformat
//   button. Click it and the paragraph is swapped for a plain-language version.
//   Selecting any text also offers Reformat. "Show original wording" brings it back.

(function () {
  "use strict";
  const F = globalThis.QRFormatter;
  const M = globalThis.QRMath;
  const { h, icon, buildSettings, loadSettings } = globalThis.QRUI;

  const PAGE_KEY = "p:" + location.origin + location.pathname;
  const EXTRA_SELECTORS = ['[class*="questionPrompt"]', '[class*="question--prompt"]', '[class*="problem--prompt"]', '[class*="question--body"]', ".question"];
  const TITLE_SELECTOR = 'h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="heading" i],[class*="points" i]';
  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|LABEL|BLOCKQUOTE|PRE|FIELDSET|LEGEND)$/;

  let settings = { ...globalThis.QRUI.DEFAULTS };
  const QUESTION_SITE = /(^|\.)gradescope\.com$/.test(location.hostname);
  const HOST = location.hostname;
  let picking = false, collapsed = !QUESTION_SITE, working = 0, hovered = null, siteOff = false;
  const panels = new Map(); // question element -> panel controller
  let toolbarHost, bannerEl, toastEl, toastTimer;

  // ---------------------------------------------------------------- startup

  // Frames: run reading mode inside real content frames (e.g. course pages), skip tiny ones (ads, widgets).
  const IN_FRAME = window.top !== window;
  if (IN_FRAME && (QUESTION_SITE || innerWidth < 320 || innerHeight < 200)) return;

  loadSettings().then((s) => {
    settings = s;
    siteOff = (s.offSites || []).includes(HOST);
    renderToolbar();
    if (QUESTION_SITE) {
      // Bring back panels from last visit (math may render late, so try twice).
      setTimeout(restorePanels, 900);
      setTimeout(restorePanels, 2600);
    } else {
      startSuggestions();
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    let touched = false;
    ["textSize", "theme", "apiKey", "model", "suggest", "offSites", "provider", "prefetch"].forEach((k) => { if (changes[k]) { settings[k] = changes[k].newValue; touched = true; } });
    if (changes.offSites || changes.suggest) { siteOff = (settings.offSites || []).includes(HOST); refreshSuggestions(); }
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
    if (IN_FRAME) return; // one toolbar per tab, in the top page
    if (!toolbarHost) { toolbarHost = rootAttrs(h("div.qr-toolbar-host"), true); document.body.appendChild(toolbarHost); }
    rootAttrs(toolbarHost, true);
    toolbarHost.classList.toggle("qr-collapsed", collapsed);
    toolbarHost.textContent = "";

    if (collapsed) {
      toolbarHost.append(h("button.qr-tab", { "aria-label": "Open Reformatter toolbar", onclick: () => { collapsed = false; renderToolbar(); } },
        icon("left", 16), h("span.qr-tab-word", {}, "Reformatter")));
      return;
    }
    const busy = working > 0;
    const head = h("div.qr-tb-head", {},
      h("span.qr-tb-title", {}, "Reformatter"),
      h("button.qr-btn", { "aria-label": "Settings", onclick: openSettings }, icon("gear", 19)),
      h("button.qr-btn", { "aria-label": "Collapse toolbar", onclick: () => { collapsed = true; renderToolbar(); } }, icon("right", 18)));

    if (QUESTION_SITE) {
      toolbarHost.append(h("div.qr-toolbar", { role: "toolbar", "aria-label": "Question Reformatter" }, head,
        h(`button.qr-btn${busy ? ".qr-working" : ".qr-btn-primary"}`, { disabled: busy, onclick: reformatAll }, busy ? "Working…" : "Reformat questions"),
        h(`button.qr-btn${picking ? ".qr-pick-on" : ""}`, { disabled: busy, "aria-pressed": String(picking), onclick: togglePicking }, picking ? "Cancel picking" : "Pick a question"),
        busy && h("p.qr-tb-status", { role: "status" }, "Working on it…")));
      return;
    }
    toolbarHost.append(h("div.qr-toolbar", { role: "toolbar", "aria-label": "Reformatter" }, head,
      h(`button.qr-btn${picking ? ".qr-pick-on" : ".qr-btn-primary"}`, { "aria-pressed": String(picking), onclick: togglePicking }, picking ? "Cancel picking" : "Pick text to reformat"),
      h("button.qr-btn", { "aria-pressed": String(!siteOff), onclick: toggleSite }, siteOff ? "Turn on for this site" : "Turn off for this site"),
      h("p.qr-tb-status", {}, siteOff ? "Off on " + HOST : `${suggestCount} paragraph${suggestCount === 1 ? "" : "s"} suggested here`)));
  }

  function toggleSite() {
    const list = new Set(settings.offSites || []);
    if (list.has(HOST)) list.delete(HOST); else list.add(HOST);
    settings.offSites = [...list];
    siteOff = list.has(HOST);
    chrome.storage.local.set({ offSites: settings.offSites });
    refreshSuggestions();
    renderToolbar();
  }




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
      icon("info", 20),
      h("span", { style: { flex: 1 } }, msg),
      h("button.qr-btn", { "aria-label": "Dismiss message", onclick: () => toastEl && toastEl.remove() }, icon("close", 16))), true);
    document.body.appendChild(toastEl);
    toastTimer = setTimeout(() => toastEl && toastEl.remove(), 7000);
  }

  // ---------------------------------------------------------------- pick mode

  function togglePicking() {
    picking = !picking;
    document.body.classList.toggle("qr-picking", picking);
    if (picking) {
      bannerEl = rootAttrs(h("div.qr-banner", { role: "status" },
        h("span", {}, QUESTION_SITE ? "Click the question you want reformatted. Press Esc to cancel." : "Click the text you want reformatted. Press Esc to cancel."),
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
    if (QUESTION_SITE) processElement(growToQuestion(target), {});
    else processReading(target.closest("p,li,dd,blockquote,td,figcaption,div,section,article") || target);
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
  // Screen-reader-only labels like "choice 1 of 3" are not part of the question.
  function isHiddenText(el) {
    if (/\b(sr-only|visually-?hidden|screen-?reader|a11y-?hidden|offscreen)\b/i.test(el.className || "")) return true;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true" && !el.closest(".katex,.MathJax,mjx-container")) return true;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return true;
    if (cs.position === "absolute" && (parseFloat(cs.width) <= 1 || parseFloat(cs.height) <= 1) && cs.overflow === "hidden") return true;
    return false;
  }

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
      if (isHiddenText(el)) return;
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
      .map((line) => line.replace(/\bchoice\s+\d+\s+of\s+\d+\b[:.]?/gi, "").trim())  // "choice 1 of 3"
      .filter(Boolean)
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
        if (entry) processElement(el, { restoring: true, read });
      });
    });
  }

  // ---------------------------------------------------------------- reformatting

  function reformatAll() {
    const qs = findQuestionElements();
    if (!qs.length) { toast("Couldn't find questions automatically. Use Pick a question."); return; }
    qs.forEach((q) => processElement(q, {}));
  }

  function processElement(q, { restoring, read }) {
    read = read || readQuestion(q);
    if (F.plain(read.text).replace(/\s+/g, "").length < 5 && !read.choices.length) {
      toast("That part of the page doesn't have enough text. Try clicking the question paragraph itself.");
      return;
    }
    const sig = signature(read);
    const old = panels.get(q);
    if (old) old.remove();

    const ctrl = makePanel(q, read, () => { panels.delete(q); forget(sig); }, {});
    panels.set(q, ctrl);
    runAI(ctrl, read, { kind: "question", restoring, onDone: () => remember(sig, q), onMiss: () => { ctrl.remove(); panels.delete(q); } });
  }

  // Sends text to the AI (or the saved copy) and fills the panel.
  function runAI(ctrl, read, { kind, restoring, onDone, onMiss, useClaude }) {
    ctrl.loading();
    working++; renderToolbar();
    chrome.runtime.sendMessage({
      type: "QR_AI_REFORMAT", kind, useClaude: !!useClaude, text: read.text, choices: read.choices,
      math: read.math.map(({ token, text }) => ({ token, text })),
      cacheOnly: !!restoring, // coming back to a page never spends tokens on its own
    }, (resp) => {
      working--; renderToolbar();
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        const msg = resp && resp.error ? resp.error : "The extension didn't respond. Reload the page and try again.";
        ctrl.error(msg, () => runAI(ctrl, read, { kind, restoring: false, onDone, onMiss }));
        return;
      }
      if (resp.result.miss) { onMiss && onMiss(); return; }
      const via = resp.result.via;
      ctrl.show(F.tidyLines(resp.result.structured), {
        // Free result + a Claude key saved → offer a one-click better version (pay only when you want it).
        upgrade: via === "local" && settings.apiKey ? () => runAI(ctrl, read, { kind, onDone, onMiss, useClaude: true }) : null,
      });
      onDone && onDone();
    });
  }

  // ---------------------------------------------------------------- reading mode (any website)

  const SKIP_AREAS = "nav,footer,form,button,select,textarea,input,pre,code,kbd,script,style,noscript,template,svg,math,iframe,[contenteditable=''],[contenteditable=true],[role=navigation],[role=banner],[role=contentinfo],[role=menu],[role=menubar],[role=toolbar],[role=dialog],[role=alert],[aria-hidden=true],[data-qr]";
  const MAX_SUGGEST = 80;
  let suggestCount = 0, scanTimer = null;
  const readingPanels = new Map(); // element -> panel

  function startSuggestions() {
    send({ type: "QR_WARM" }); // load the free model now, so the first rewrite isn't slow
    refreshSuggestions();
    new MutationObserver((muts) => {
      if (muts.every((m) => m.target.closest && m.target.closest("[data-qr]"))) return;
      clearTimeout(scanTimer);
      scanTimer = setTimeout(refreshSuggestions, 1200);
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
    // Pages that load content as you scroll
    addEventListener("scroll", () => { clearTimeout(scanTimer); scanTimer = setTimeout(refreshSuggestions, 900); }, { passive: true });
  }

  function refreshSuggestions() {
    if (QUESTION_SITE) return;
    const on = settings.suggest !== false && !siteOff;
    if (!on) {
      deepQueryAll(".qr-suggest").forEach((b) => b.remove());
      deepQueryAll("[data-qr-suggested]").forEach((e) => e.removeAttribute("data-qr-suggested"));
      prefetchQueue.clear();
      suggestCount = 0;
      renderToolbar();
      return;
    }
    suggestCount = deepQueryAll(".qr-suggest:not(.qr-sel-btn)").length;
    for (const el of findDenseParagraphs()) {
      if (suggestCount >= MAX_SUGGEST) break;
      if (el.hasAttribute("data-qr-suggested") || readingPanels.has(el)) continue;
      el.setAttribute("data-qr-suggested", "1");
      styleShadowRoot(el);
      const btn = rootAttrs(h("button.qr-suggest", { title: "Rewrite this paragraph in plain language", "aria-label": "Reformat this paragraph",
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); processReading(el); },
        onmouseenter: () => el.classList.add("qr-suggest-target"),
        onmouseleave: () => el.classList.remove("qr-suggest-target") },
        icon("check", 13), "Reformat"), false);
      el.appendChild(btn);
      suggestCount++;
      queuePrefetch(el);
    }
    if (!collapsed) renderToolbar();
  }

  // querySelectorAll that also looks inside open shadow roots.
  function deepQueryAll(sel, root = document) {
    const out = [...root.querySelectorAll(sel)];
    root.querySelectorAll("*").forEach((el) => { if (el.shadowRoot) out.push(...deepQueryAll(sel, el.shadowRoot)); });
    return out;
  }

  // Our styles don't reach inside shadow roots, so give each one a copy.
  let cssSheet = null;
  const styledRoots = new WeakSet();
  function styleShadowRoot(el) {
    const root = el.getRootNode();
    if (!(root instanceof ShadowRoot) || styledRoots.has(root)) return;
    styledRoots.add(root);
    (cssSheet ? Promise.resolve(cssSheet) : fetch(chrome.runtime.getURL("content.css")).then((r) => r.text()).then((css) => {
      cssSheet = new CSSStyleSheet();
      cssSheet.replaceSync(css.replace(/@font-face\s*{[^}]*}/g, ""));
      return cssSheet;
    })).then((sheet) => { root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet]; }).catch(() => {});
  }

  // How paragraphs are found:
  //   1. Walk every visible text node on the page (and inside open shadow roots).
  //   2. Group text by its nearest block-level box (whatever the tag is: p, div, span-with-display-block, li…).
  //      This catches text split across links, bold, spans and <br> lines.
  //   3. Score each block: long, OR medium-length and hard to read
  //      (reading grade 12+, long sentences, or many long words).
  function findDenseParagraphs() {
    const styleOf = new Map();
    const style = (el) => {
      let v = styleOf.get(el);
      if (!v) { const cs = getComputedStyle(el); v = { display: cs.display, hidden: cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" }; styleOf.set(el, v); }
      return v;
    };
    const blockish = (el) => { const d = style(el).display; return !(d.startsWith("inline") || d === "contents" || d === "ruby"); };
    const skipEl = (el) => el.matches(SKIP_AREAS) || (el.matches("header,aside") && !el.closest("article,main")) || style(el).hidden;
    const up = (el) => el.parentElement || (el.parentNode && el.parentNode.host) || null;

    const text = new Map();
    const roots = [document.body];
    for (let i = 0; i < roots.length; i++) {
      const walker = document.createTreeWalker(roots[i], NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode(n) {
          if (n.nodeType === 1) {
            if (skipEl(n)) return NodeFilter.FILTER_REJECT;
            if (n.shadowRoot) roots.push(n.shadowRoot);
            return NodeFilter.FILTER_SKIP;
          }
          return /\S/.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
      });
      let t;
      while ((t = walker.nextNode())) {
        let b = t.parentElement || (t.parentNode && t.parentNode.host);
        while (b && b !== document.body && !blockish(b)) b = up(b);
        if (!b || b === document.body || b === document.documentElement) continue;
        text.set(b, (text.get(b) || "") + t.nodeValue + " ");
      }
    }

    const out = [];
    text.forEach((t, el) => {
      const st = textStats(t);
      if (!st) return;
      const dense = st.words >= 60 ||
        (st.words >= 30 && (st.grade >= 12 || st.avgSentence >= 20 || st.longShare >= 0.28)) ||
        (st.words >= 15 && st.grade >= 16); // short but very hard (academic jargon)
      if (!dense) return;
      const r = el.getBoundingClientRect();
      if (r.width < 180 || r.height < 20) return;
      out.push(el);
    });
    return out;
  }

  // Word count, sentence length, share of long words, and a reading grade (Flesch–Kincaid).
  function textStats(raw) {
    const t = raw.replace(/\bReformat\s*$/g, "").replace(/\s+/g, " ").trim();
    if (t.length < 100) return null;
    const words = t.split(" ").filter((w) => /[A-Za-z]/.test(w));
    if (words.length < 15) return null;
    const sentences = Math.max(1, (t.match(/[.!?;:](\s|$)/g) || []).length);
    const syllables = words.reduce((n, w) => n + syllableCount(w), 0);
    const longShare = words.filter((w) => w.replace(/[^A-Za-z]/g, "").length >= 9).length / words.length;
    const avgSentence = words.length / sentences;
    const grade = 0.39 * avgSentence + 11.8 * (syllables / words.length) - 15.59;
    return { words: words.length, avgSentence, longShare, grade };
  }
  function syllableCount(word) {
    const w = word.toLowerCase().replace(/[^a-z]/g, "");
    if (!w) return 0;
    if (w.length <= 3) return 1;
    const groups = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
    return Math.max(1, groups ? groups.length : 1);
  }

  // The same text is read for preparing ahead and for clicking, so the saved result matches.
  function readingRead(el) {
    const math = newMathRegistry();
    let text = extractRich(el, { skip: new Set(), math });
    if (F.plain(text).replace(/\s+/g, " ").trim().split(" ").length < 8) return null;
    if (text.length > 8000) text = text.slice(0, 8000);
    return { text, choices: [], choiceInfo: [], math: math.list, title: "this paragraph" };
  }

  function processReading(el) {
    if (readingPanels.has(el)) return;
    const read = readingRead(el);
    if (!read) { toast("That's too short to reformat. Pick a longer paragraph."); return; }
    prefetchQueue.delete(el);
    const btn = el.querySelector(":scope > .qr-suggest"); if (btn) { btn.remove(); suggestCount = Math.max(0, suggestCount - 1); }
    styleShadowRoot(el);
    const ctrl = makePanel(el, read, () => {
      readingPanels.delete(el);
      el.removeAttribute("data-qr-suggested"); // offer it again later
      clearTimeout(scanTimer); scanTimer = setTimeout(refreshSuggestions, 300);
    }, { reading: true, hideTarget: el });
    readingPanels.set(el, ctrl);
    runAI(ctrl, read, { kind: "reading" });
  }

  // ---------------------------------------------------------------- preparing rewrites ahead of time
  // With the free on-device model, suggested paragraphs are reformatted in the background,
  // nearest to where you're reading first, one at a time. Clicking Reformat then opens instantly.
  // Never uses Claude, so it never costs anything.

  const PREFETCH_MAX = 40; // per page
  const prefetchQueue = new Set();
  let prefetching = false, prefetched = 0;
  const send = (m) => new Promise((res) => chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; res(r); }));

  function queuePrefetch(el) {
    if (settings.prefetch === false || (settings.provider || "local") !== "local") return;
    prefetchQueue.add(el);
    pumpPrefetch();
  }

  async function pumpPrefetch() {
    if (prefetching) return;
    prefetching = true;
    try {
      while (prefetchQueue.size && prefetched < PREFETCH_MAX && !siteOff) {
        if (document.hidden) { await new Promise((r) => document.addEventListener("visibilitychange", r, { once: true })); continue; }
        let best = null, bestDist = Infinity;
        for (const el of prefetchQueue) {
          if (!el.isConnected || readingPanels.has(el)) { prefetchQueue.delete(el); continue; }
          const r = el.getBoundingClientRect();
          const dist = r.bottom < 0 ? -r.bottom + 1500 : Math.max(0, r.top - innerHeight); // below the screen first, then above
          if (dist < bestDist) { bestDist = dist; best = el; }
        }
        if (!best) break;
        prefetchQueue.delete(best);
        const read = readingRead(best);
        if (!read) continue;
        const btn = best.querySelector(":scope > .qr-suggest");
        if (btn) { btn.classList.add("qr-preparing"); btn.title = "Getting it ready…"; }
        const resp = await send({ type: "QR_AI_REFORMAT", kind: "reading", prefetch: true, text: read.text, choices: [], math: read.math.map(({ token, text }) => ({ token, text })) });
        prefetched++;
        if (btn) {
          btn.classList.remove("qr-preparing");
          if (resp && resp.ok && resp.result.structured) { btn.classList.add("qr-ready"); btn.title = "Ready — opens instantly"; }
          else btn.title = "Rewrite this paragraph in plain language";
        }
        if (resp && resp.ok && resp.result.skipped) { prefetchQueue.clear(); break; } // free model not available here
        if (resp && resp.ok && resp.result.aborted) { prefetched--; prefetchQueue.add(best); await new Promise((r) => setTimeout(r, 500)); } // a click went first; try again after
      }
    } finally {
      prefetching = false;
    }
  }

  // Selecting text anywhere offers Reformat for just that selection.
  let selBtn = null;
  function hideSelBtn() { if (selBtn) { selBtn.remove(); selBtn = null; } }
  document.addEventListener("mousedown", (e) => { if (selBtn && !selBtn.contains(e.target)) hideSelBtn(); }, true);
  document.addEventListener("scroll", hideSelBtn, true);
  document.addEventListener("mouseup", (e) => {
    if (QUESTION_SITE || siteOff || picking || e.target.closest("[data-qr]")) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().replace(/\s+/g, " ").trim() : "";
      if (!sel || sel.isCollapsed || text.split(" ").length < 12) return;
      const range = sel.getRangeAt(0);
      const anchorEl = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement);
      if (!anchorEl || anchorEl.closest("input,textarea,[contenteditable],[data-qr]")) return;
      const rect = range.getBoundingClientRect();
      hideSelBtn();
      selBtn = rootAttrs(h("button.qr-suggest.qr-sel-btn", { "aria-label": "Reformat the selected text",
        style: { top: Math.max(8, rect.bottom + 8) + "px", left: Math.max(8, Math.min(window.innerWidth - 140, rect.left)) + "px" },
        onclick: (ev) => { ev.preventDefault(); ev.stopPropagation(); hideSelBtn(); processSelection(range, text); } },
        icon("check", 13), "Reformat"), false);
      document.body.appendChild(selBtn);
    }, 10);
  }, true);

  function processSelection(range, text) {
    let end = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    end = end.closest("p,li,dd,blockquote,td,figcaption,div,section,article,h1,h2,h3,h4,h5,h6") || end;
    if (text.length > 8000) text = text.slice(0, 8000);
    const read = { text, choices: [], choiceInfo: [], math: [], title: "the selected text" };
    const ctrl = makePanel(end, read, () => {}, { reading: true, after: true });
    window.getSelection().removeAllRanges();
    runAI(ctrl, read, { kind: "reading" });
  }

  // ---------------------------------------------------------------- the panel

  // opts.reading: plain text (no choices). opts.hideTarget: hide that element while the rewrite shows.
  // opts.after: insert the panel after q instead of before it.
  function makePanel(q, read, onClosed, opts = {}) {
    const mathByToken = Object.fromEntries(read.math.map((m) => [m.token, m]));
    const panel = rootAttrs(h(`div.qr-panel${opts.reading ? ".qr-reading" : ""}`, { role: "region", "aria-label": "Simpler version of " + read.title }), false);
    q.parentNode.insertBefore(panel, opts.after ? q.nextSibling : q);

    let data = null, meta = {}, pending = null, part = 0, showOriginal = false;

    const inputListener = () => data && draw();
    read.choiceInfo.forEach((c) => c.input.addEventListener("change", inputListener));

    function setOriginalHidden(hide) { if (opts.hideTarget) opts.hideTarget.style.display = hide ? "none" : ""; }
    function remove() {
      read.choiceInfo.forEach((c) => c.input.removeEventListener("change", inputListener));
      setOriginalHidden(false);
      panel.remove();
    }
    function close() { remove(); onClosed(); }

    function header() {
      return h("div.qr-header", {},
        h("div.qr-header-actions", {},
          data && meta.upgrade && h("button.qr-btn", { title: "Rewrite this one with Claude (about $0.002)", onclick: meta.upgrade }, "Better with Claude"),
          data && h("button.qr-btn", { "aria-pressed": String(showOriginal), onclick: () => { showOriginal = !showOriginal; setOriginalHidden(!showOriginal); draw(); } }, showOriginal ? "Hide original wording" : "Show original wording"),
          h("button.qr-btn.qr-btn-icon", { "aria-label": "Close reformatted view", onclick: close }, icon("close", 17))));
    }

    function loading() {
      panel.textContent = "";
      panel.append(header(), h("div.qr-loading", { role: "status" },
        h("span.qr-loading-bar", { "aria-hidden": "true" }),
        h("span.qr-loading-text", {}, "Reformatting…")));
    }

    function error(msg, retry) {
      panel.textContent = "";
      panel.append(header(), h("div.qr-warn", { role: "status" },
        icon("info", 22),
        h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", minWidth: 0 } },
          h("p.qr-warn-title", {}, "Couldn't reformat this yet"),
          h("p.qr-warn-text", {}, msg),
          h("div", {}, h("button.qr-btn", { onclick: retry }, "Try again")))));
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

    // Bullets are drawn with CSS (no text symbols), so they look the same everywhere.
    const row = (str, mark = null, cls = "") => h(`div.qr-row${cls}`, {}, h(`span.qr-mark${mark ? ".qr-mark-text" : ""}`, { "aria-hidden": "true" }, mark), h("span.qr-text", {}, rich(str)));
    const label = (txt) => h("div.qr-label", {}, h("span", {}, txt));

    function section(heading, points) {
      const sec = h("section.qr-sec", { "aria-label": heading }, label(heading));
      points.forEach((p) => {
        sec.append(row(p.text));
        (p.sub || []).forEach((x) => sec.append(row(x, null, ".qr-sub")));
      });
      return sec;
    }

    function questionSection() {
      const items = data.question || [];
      const parts = items.length >= 2 && items.every((t) => /^(<[bi]>)*\(([a-h])\)/.test(t)) ? items : null;
      const sec = h("section.qr-sec", { "aria-label": "The question" }, label("The question"));
      if (!parts) { items.forEach((t) => sec.append(row(t))); return sec; }

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
          h("button.qr-btn", { disabled: part <= 0, onclick: () => { part--; draw(); } }, icon("left", 16), "Previous part"),
          h("button.qr-btn", { disabled: part >= parts.length - 1, onclick: () => { part++; draw(); } }, "Next part", icon("right", 16)))));
      return sec;
    }

    const allStrings = () => [...F.simpleLines(data), data.choices_intro || "", ...data.choices];
    function symbolsSection() {
      const used = new Set((allStrings().join(" ").match(F.TOKEN_RE) || []));
      const text = read.math.filter((m) => used.has(m.token)).map((m) => m.text).join(" ");
      const gloss = M.glossary(text);
      if (!gloss.length) return null;
      return h("section.qr-sec", { "aria-label": "Symbols" }, label("Symbols — how to say them"),
        h("div.qr-symbols", {}, gloss.map(([sym, say]) => h("span.qr-sym", {}, h("span.qr-sym-glyph", {}, sym), `“${say}”`))));
    }

    function choicesSection() {
      const sec = h("section.qr-sec", { "aria-label": "The answer choices" }, label("The answer choices"));
      if (!data.choices.length) {
        sec.append(h("p.qr-empty", {}, "Written answer. Type it in the answer box on the page."));
        return h("div.qr-box", {}, sec);
      }
      if (data.choices_intro) sec.append(row(data.choices_intro));
      const list = h("div.qr-choices", {});
      data.choices.forEach((c, i) => {
        const letter = String.fromCharCode(65 + i);
        const info = read.choiceInfo[i];
        const isSel = !!(info && info.input.checked);
        const isPend = pending === i && !isSel;
        const btn = h(`button.qr-choice${isSel ? ".qr-selected" : ""}${isPend ? ".qr-pending" : ""}`, { "aria-pressed": String(isSel), onclick: () => { if (!isSel && info) { pending = i; draw(); } } },
          h("span.qr-letter", {}, letter + "."),
          h("span.qr-choice-text", {}, rich(c)),
          isSel && h("span.qr-tag-sel", {}, icon("check", 13), "Selected"),
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

    function originalSection() {
      const sec = h("section.qr-sec", { "aria-label": "Original wording" }, label("Original wording"));
      read.text.split("\n").filter((l) => F.plain(l).trim()).forEach((l) => sec.append(row(l)));
      read.choices.forEach((c, i) => sec.append(row(c, String.fromCharCode(65 + i) + ".")));
      return h("div.qr-box.qr-original", {}, sec);
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
          icon("info", 22),
          h("div", { style: { display: "flex", flexDirection: "column", gap: "4px", minWidth: 0 } },
            h("p.qr-warn-title", {}, meta.warnTitle),
            h("p.qr-warn-text", {}, meta.warnText),
            h("ul.qr-warn-list", {}, meta.warnings.map((w) => h("li", {}, w))))));
      }
      if (showOriginal && !opts.hideTarget) panel.append(originalSection());
      if (data.summary) panel.append(h("div.qr-keypoint", {}, h("span.qr-keypoint-label", {}, "Key point"), h("p.qr-text", {}, rich(data.summary))));
      const qbox = h("div.qr-box", {});
      (data.sections || []).forEach((sec) => { if (sec.points && sec.points.length) qbox.append(section(sec.heading || "Details", sec.points)); });
      if ((data.question || []).length) qbox.append(questionSection());
      const sym = symbolsSection(); if (sym) qbox.append(sym);
      panel.append(qbox);
      if (!opts.reading) panel.append(choicesSection());
      if (focusedLabel) { const b = [...panel.querySelectorAll("button")].find((x) => x.textContent === focusedLabel); if (b) b.focus(); }
    }

    return {
      remove, loading,
      error,
      show(d, m) { data = d; meta = m || {}; setOriginalHidden(!showOriginal); draw(); },
    };
  }
})();
