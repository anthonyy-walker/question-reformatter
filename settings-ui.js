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

  const DEFAULTS = { mode: "rules", textSize: "normal", theme: "light", apiKey: "", model: "claude-haiku-4-5-20251001" };
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

      const modes = h("div.qr-fieldset", { role: "radiogroup", "aria-label": "Default mode" },
        h("div.qr-legend", { text: "Default mode" }),
        h("div.qr-mode-grid", {}, [
          ["rules", "Rules", "Keeps the original words. Splits the question by sentence. No AI, nothing leaves your browser."],
          ["ai", "AI", "Restructures the layout under strict rules, then is checked against the original before it shows. Results are saved, so each question is only paid for once."],
        ].map(([k, name, desc]) => {
          const on = draft.mode === k;
          return h(`button.qr-btn.qr-mode${on ? ".qr-on" : ""}`, { role: "radio", "aria-checked": String(on), onclick: () => { draft.mode = k; render(); } },
            h("span.qr-mode-name", {}, h("span.qr-dot", { "aria-hidden": "true" }, on ? "✓" : ""), name),
            h("span.qr-mode-desc", { text: desc }));
        })));

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
        h("label.qr-field", {}, h("span.qr-legend", { text: "API key" }), key, h("span.qr-help", { text: "Only needed for AI mode. Stored on this device only. Sent only to api.anthropic.com." })),
        h("label.qr-field", {}, h("span.qr-legend", { text: "Model" }), model, h("span.qr-help", { text: "Used only when the mode is AI." })));

      // Saved AI results
      const savedCount = h("span", { text: "…" });
      const clearBtn = h("button.qr-btn", { onclick: () => chrome.runtime.sendMessage({ type: "QR_CACHE_CLEAR" }, () => { savedCount.textContent = "0 questions"; }) }, "Clear saved results");
      chrome.runtime.sendMessage({ type: "QR_CACHE_STATS" }, (r) => { savedCount.textContent = r && r.ok ? `${r.result.count} question${r.result.count === 1 ? "" : "s"}` : "unknown"; });
      const saved = h("div.qr-fieldset", {},
        h("div.qr-legend", { text: "Saved AI results" }),
        h("div.qr-saved-row", {}, h("span", {}, "Saved on this device: ", savedCount), clearBtn),
        h("span.qr-help", { text: "Coming back to an assignment re-uses these, so it costs nothing. They are re-made automatically if the AI instructions or model change." }));

      // Exact instructions disclosure
      const instr = h("div.qr-instr-wrap", {});
      const open = !!render.showInstr;
      instr.append(h("button.qr-btn.qr-disclosure", { "aria-expanded": String(open), onclick: () => { render.showInstr = !open; render(); } },
        h("span", { "aria-hidden": "true", style: { width: "1em" } }, open ? "▾" : "▸"), "Show the exact instructions the AI gets"));
      if (open) {
        const copyBtn = h("button.qr-btn", { onclick: () => { navigator.clipboard.writeText(SYSTEM_PROMPT).then(() => { copyBtn.textContent = "✓ Copied"; }); } }, "Copy instructions");
        instr.append(h("div.qr-instr", {},
          h("div.qr-instr-head", { text: "Sent with every question, word for word" }),
          h("pre.qr-pre", { text: SYSTEM_PROMPT }),
          h("div.qr-instr-head", { text: "Checked by the extension before anything is shown" }),
          h("ul.qr-ul", {},
            h("li", { text: "Every number in the result appears in the original question, and none are added." }),
            h("li", { text: "Every math expression is still there, unchanged, and none are added." }),
            h("li", { text: "Every negation word from the original is still there." }),
            h("li", { text: "The answer choices are unchanged and in the same order." })),
          h("p.qr-help", { text: "If any check fails, the Rules version is shown instead, with a note listing what failed." }),
          h("div", {}, copyBtn)));
      }

      const status = h("span.qr-saved", { role: "status" });
      const save = h("button.qr-btn.qr-btn-primary", { style: { minWidth: "120px" }, onclick: () => {
        chrome.storage.local.set(draft, () => { status.textContent = "✓ Saved"; opts.onSaved && opts.onSaved({ ...draft }); });
      } }, "Save");

      card.append(head, modes,
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
