// settings-ui.js
// Small DOM helper + the Settings panel. Used inside Gradescope (as a pop-up)
// and on the extension's own options page, so both look the same.

(function (root) {
  "use strict";

  // h("button.qr-btn.qr-btn-primary", { onclick, "aria-label": "…" }, "text", child, …)
  function h(spec, attrs, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag || "div");
    el.classList.add("qr-el", ...classes.filter(Boolean));
    if (tag === "button") el.type = "button";
    Object.entries(attrs || {}).forEach(([k, v]) => {
      if (v == null || v === false) return;
      if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? "" : v);
    });
    kids.flat().forEach((k) => { if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k))); });
    return el;
  }

  const DEFAULTS = { textSize: "normal", theme: "light", apiKey: "", model: "claude-haiku-4-5-20251001", suggest: true, offSites: [], provider: "local", prefetch: true };
  const FIELDS = Object.keys(DEFAULTS);

  function load() {
    return new Promise((res) => chrome.storage.local.get(FIELDS, (s) => res({ ...DEFAULTS, ...s })));
  }

  // Builds the settings card. opts: { onClose, onSaved }
  async function buildSettings(opts = {}) {
    const s = await load();
    const draft = { ...s };

    const card = h("div.qr-settings", { role: "dialog", "aria-label": "Reformatter settings" });

    function render() {
      card.textContent = "";

      const head = h("div.qr-set-head", {},
        h("h1", { text: "Settings" }),
        opts.onClose && h("button.qr-btn.qr-btn-icon", { "aria-label": "Close settings", onclick: opts.onClose }, "✕"));

      // Which AI does the rewriting
      const providerOn = draft.provider || "local";
      const localStatus = h("span.qr-help", { role: "status" }, "Checking this computer…");
      const setupRow = h("div.qr-saved-row", {});
      const provider = h("div.qr-fieldset", { role: "radiogroup", "aria-label": "AI" },
        h("div.qr-legend", { text: "AI" }),
        h("div.qr-mode-grid", {}, [
          ["local", "Free — on this computer", "Chrome's built-in model (Gemini Nano). No cost, works offline, text never leaves your computer. If it struggles and a Claude key is set, Claude takes over for that one."],
          ["claude", "Claude", "Best quality. Uses your API key; about $0.002 per rewrite."],
        ].map(([k, name, desc]) => {
          const on = providerOn === k;
          return h(`button.qr-btn.qr-mode${on ? ".qr-on" : ""}`, { role: "radio", "aria-checked": String(on), onclick: () => { draft.provider = k; render(); } },
            h("span.qr-mode-name", {}, h("span.qr-dot", { "aria-hidden": "true" }, on ? "✓" : ""), name),
            h("span.qr-mode-desc", { text: desc }));
        })),
        localStatus, setupRow);
      chrome.runtime.sendMessage({ type: "QR_LOCAL_STATUS" }, (r) => {
        const st = r && r.ok ? r.result : "unavailable";
        localStatus.textContent = {
          available: "✓ On-device model is ready on this computer.",
          downloadable: "On-device model isn't downloaded yet (one time, a few GB).",
          downloading: "On-device model is downloading…",
          unavailable: "This computer can't run the on-device model. Claude will be used.",
          missing: "This Chrome doesn't have the built-in model. Update Chrome, or Claude will be used.",
        }[st] || st;
        if (st === "downloadable" || st === "downloading") {
          const canHere = location.protocol === "chrome-extension:" && globalThis.QRLocal && QRLocal.has();
          const btn = h("button.qr-btn.qr-btn-primary", { onclick: () => {
            if (!canHere) { chrome.runtime.sendMessage({ type: "QR_OPEN_OPTIONS" }); return; }
            btn.disabled = true; btn.textContent = "Downloading… 0%";
            QRLocal.download((p) => { btn.textContent = `Downloading… ${Math.round(p * 100)}%`; })
              .then(() => { localStatus.textContent = "✓ On-device model is ready on this computer."; btn.remove(); })
              .catch((e) => { btn.disabled = false; btn.textContent = "Try again"; localStatus.textContent = "Download failed: " + e.message; });
          } }, canHere ? "Set up the on-device model" : "Open setup page");
          setupRow.append(btn);
        }
      });

      // Suggestions on websites + sites where it's turned off
      const suggestOn = draft.suggest !== false;
      const offList = (draft.offSites || []);
      const suggest = h("div.qr-fieldset", {},
        h("div.qr-legend", { text: "Suggestions on websites" }),
        h("div.qr-seg", { role: "radiogroup", "aria-label": "Suggestions on websites" },
          [[true, "On"], [false, "Off"]].map(([v, name]) => {
            const on = suggestOn === v;
            return h(`button.qr-btn${on ? ".qr-on" : ""}`, { role: "radio", "aria-checked": String(on), onclick: () => { draft.suggest = v; render(); } }, (on ? "✓ " : "") + name);
          })),
        h("span.qr-help", { text: "When on, long or dense paragraphs get a small ✓ Simplify button." }),
        h("div.qr-legend", { text: "Get rewrites ready ahead of time", style: { marginTop: "10px" } }),
        h("div.qr-seg", { role: "radiogroup", "aria-label": "Get rewrites ready ahead of time" },
          [[true, "On"], [false, "Off"]].map(([v, name]) => {
            const on = (draft.prefetch !== false) === v;
            return h(`button.qr-btn${on ? ".qr-on" : ""}`, { role: "radio", "aria-checked": String(on), onclick: () => { draft.prefetch = v; render(); } }, (on ? "✓ " : "") + name);
          })),
        h("span.qr-help", { text: "Free model only. Suggested paragraphs are simplified in the background, closest to where you're reading first, so ✓ Simplify opens instantly (the button fills in when it's ready). Text stays on this computer. Claude is never used for this." }),
        offList.length
          ? h("div.qr-saved-row", {}, h("span", {}, "Turned off on: "), offList.map((host) =>
              h("button.qr-btn", { "aria-label": "Turn back on for " + host, onclick: () => { draft.offSites = offList.filter((x) => x !== host); render(); } }, host + "  ✕")))
          : null);

      const seg = (label, key, options) => h("div.qr-fieldset", {},
        h("div.qr-legend", { text: label }),
        h("div.qr-seg", { role: "radiogroup", "aria-label": label }, options.map(([k, name, px]) => {
          const on = draft[key] === k;
          return h(`button.qr-btn${on ? ".qr-on" : ""}`, { role: "radio", "aria-checked": String(on), onclick: () => { draft[key] = k; render(); } },
            px && h("span", { style: { fontSize: px + "px", fontWeight: 700, lineHeight: 1 } }, "Aa"),
            h("span", {}, (on ? "✓ " : "") + name));
        })));

      const key = h("input.qr-input", { type: "password", placeholder: "Paste your key (sk-ant-…)", autocomplete: "off", value: draft.apiKey, oninput: (e) => { draft.apiKey = e.target.value.trim(); } });
      const model = h("select.qr-input", { onchange: (e) => { draft.model = e.target.value; } },
        [["claude-haiku-4-5-20251001", "Claude Haiku (faster, cheaper)"], ["claude-sonnet-5-5", "Claude Sonnet (more careful)"]].map(([v, t]) => {
          const o = h("option", { value: v, text: t });
          if (draft.model === v) o.selected = true;
          return o;
        }));

      const fields = h("div.qr-two", {},
        h("label.qr-field", {}, h("span.qr-legend", { text: "API key" }), key, h("span.qr-help", { text: "Optional with the free model (used as backup). Stored on this device only. Sent only to api.anthropic.com." })),
        h("label.qr-field", {}, h("span.qr-legend", { text: "Model" }), model, h("span.qr-help", { text: "Haiku is plenty for most text." })));

      // Saved AI results
      const savedCount = h("span", { text: "…" });
      const clearBtn = h("button.qr-btn", { onclick: () => chrome.runtime.sendMessage({ type: "QR_CACHE_CLEAR" }, () => { savedCount.textContent = "0 results"; }) }, "Clear saved results");
      chrome.runtime.sendMessage({ type: "QR_CACHE_STATS" }, (r) => { savedCount.textContent = r && r.ok ? `${r.result.count} result${r.result.count === 1 ? "" : "s"}` : "unknown"; });
      const saved = h("div.qr-fieldset", {},
        h("div.qr-legend", { text: "Saved AI results" }),
        h("div.qr-saved-row", {}, h("span", {}, "Saved on this device: ", savedCount), clearBtn),
        h("span.qr-help", { text: "Simplifying the same text again (same page, another day) re-uses these, so it costs nothing. They are re-made automatically if the AI instructions or model change." }));

      // Exact instructions disclosure
      const instr = h("div.qr-instr-wrap", {});
      const open = !!render.showInstr;
      instr.append(h("button.qr-btn.qr-disclosure", { "aria-expanded": String(open), onclick: () => { render.showInstr = !open; render(); } },
        h("span", { "aria-hidden": "true", style: { width: "1em" } }, open ? "▾" : "▸"), "Show the exact instructions the AI gets"));
      if (open) {
        const copyBtn = h("button.qr-btn", { onclick: () => { navigator.clipboard.writeText("QUESTIONS (Gradescope)\n\n" + SYSTEM_PROMPT + "\n\n\nEVERYTHING ELSE (websites)\n\n" + READING_PROMPT).then(() => { copyBtn.textContent = "✓ Copied"; }); } }, "Copy instructions");
        instr.append(h("div.qr-instr", {},
          h("div.qr-instr-head", { text: "Sent with every request, word for word" }),
          h("div.qr-instr-head", { text: "For questions (Gradescope)" }),
          h("pre.qr-pre", { text: SYSTEM_PROMPT }),
          h("div.qr-instr-head", { text: "For everything else (websites)" }),
          h("pre.qr-pre", { text: READING_PROMPT }),
          h("div.qr-instr-head", { text: "Checked by the extension before anything is shown" }),
          h("ul.qr-ul", {},
            h("li", { text: "Every number from the original is still there, and none are invented." }),
            h("li", { text: "Every math expression is still there, unchanged, and none are invented." }),
            h("li", { text: "Questions: the question itself is still there." }),
            h("li", { text: "Every negation word from the original is still there." }),
            h("li", { text: "Questions: each answer choice keeps its numbers, math and meaning-changing words, in the same order. If one doesn't, the original wording is used for it." })),
          h("p.qr-help", { text: "If a check fails, the AI's rewrite is never thrown away. The AI is asked once to fix its own mistake. Anything still wrong is fixed automatically: lines with invented numbers are removed, and anything left out is added back in the question's own words." }),
          h("div", {}, copyBtn)));
      }

      const status = h("span.qr-saved", { role: "status" });
      const save = h("button.qr-btn.qr-btn-primary", { style: { minWidth: "120px" }, onclick: () => {
        chrome.storage.local.set(draft, () => { status.textContent = "✓ Saved"; opts.onSaved && opts.onSaved({ ...draft }); });
      } }, "Save");

      card.append(head, provider, suggest,
        seg("Text size", "textSize", [["normal", "Normal", 16], ["larger", "Larger", 20], ["largest", "Largest", 24]]),
        seg("Theme", "theme", [["light", "Light"], ["dark", "Dark"]]),
        fields, saved, instr,
        h("div.qr-saved-row", { style: { paddingTop: "8px" } }, save, status));
    }

    render();
    return card;
  }

  root.QRUI = { h, buildSettings, loadSettings: load, DEFAULTS };
})(typeof globalThis !== "undefined" ? globalThis : this);
