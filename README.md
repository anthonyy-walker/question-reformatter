# Question Reformatter

A Chrome extension that rewrites dense text in plain, simple language — for students with dyslexia, autism, ADHD, or anyone who loses the point inside a long paragraph.

- **On any website:** long or dense paragraphs get a small **✓ Simplify** button. Click it and the paragraph is swapped for a plain-language version: the key point first, then short points under clear headings. Selecting any text also offers ✓ Simplify.
- **On Gradescope:** questions are rewritten in plain language too, with stricter rules — it never solves, hints, rules out choices, or reorders answers. You still answer on the original question.
- **Show original wording** brings back the exact original at any time.

## Install (Chrome)
1. Clone or unzip this folder somewhere you'll keep it.
2. Go to `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** → pick the `question-reformatter` folder.
4. Open the settings (⚙ on the toolbar, or the extension's icon):
   - **Free — on this computer** (default): click **Set up the on-device model** once. Chrome downloads its built-in model (Gemini Nano, a few GB). After that every rewrite is free, offline, and private.
   - **Claude** (optional): paste an Anthropic API key for best quality. With the free model selected, Claude is only used as a backup.

### Updating without losing your key
Don't remove the extension. Replace the files in the same folder (`git pull`), then click ↻ on the extension in `chrome://extensions`.

## Use
- **Any website**
  - ✓ Simplify buttons appear on hard-to-read paragraphs.
  - **Ready ahead of time (free model):** suggested paragraphs are simplified in the background, closest to where you're reading first. The button fills in when it's ready, and clicking it opens instantly. This never uses Claude.
  - **How paragraphs are found:** every visible piece of text is grouped by the box it sits in (so text split across links, bold, spans or line breaks still counts), then scored: long, or medium-length and hard to read (reading grade 12+, long sentences, many long words), or short but very hard (grade 16+). Works inside embedded frames and web components too. Menus, footers, forms, buttons and code are skipped.
  - Select text (12+ words) → ✓ Simplify appears next to it.
  - The small **Reformatter** tab on the right edge opens the toolbar: **Pick text to simplify**, **Turn off for this site**, settings.
- **Gradescope**
  - **Reformat questions** finds every question; **Pick a question** if auto-find misses one.
  - Click a simplified answer choice → confirm → it selects that answer on the page.

## Which AI does the work
- **Free, on this computer:** Chrome's built-in model through the Prompt API. Needs macOS 13+ / Windows 10+, 22 GB free disk, and 16 GB RAM or a GPU with 4 GB+. Check `chrome://on-device-internals`.
- **Automatic backup:** if the built-in model can't run, or its answer still has more than 2 problems after it fixes itself, Claude takes over for that one rewrite — only if a Claude key is set.
- **Claude:** best quality; about $0.002 per rewrite with Haiku.
- **✨ Better with Claude:** on any free result (when a Claude key is saved), one click rewrites just that paragraph with Claude. You only pay when you choose to.
- The free model gets extra style rules and a worked example (2–4 topics, no repeated facts, abbreviations spelled out), because small models copy examples closely.

## How the AI is kept honest
- Instructions are in `prompt.js` (one set for questions, one for everything else). The settings page shows them word for word.
- Every result is checked automatically: every number, math expression, and meaning-changing word ("not", "except", "at least"…) must still be there, and nothing may be invented.
- The AI's rewrite is never thrown away. If a check fails:
  1. The AI is asked once to fix its own mistake.
  2. Anything still wrong is patched: lines with invented numbers are removed, and anything left out is added back in the original's own words. On Gradescope, any answer choice that lost something goes back to its original wording.
- Text from websites is treated as material only — instructions hidden inside a page are ignored.

## Saved results (no repeat cost)
- Every result is saved on this device. Simplifying the same text again costs nothing.
- On Gradescope, panels you had open re-appear when you return. A return visit never calls the AI on its own.
- Settings → "Saved AI results" shows the count and has a Clear button.

## Math
- Reads math from MathJax (2 and 3), KaTeX, and MathML, and shows the page's own rendered math.
- Each math piece is read aloud correctly by screen readers / Speechify (e.g. "H-naught, pi is not equal to 0.09").
- A "Symbols — how to say them" line lists symbols like μ "mu", H₀ "H-naught", ≠ "is not equal to".

## Before using on graded work
- Get approval from your instructor and your school's disability services office.
- Show them the settings page → "Show the exact instructions the AI gets".

## Files
- `content.js` / `content.css` — suggestions, toolbar and panels on the page
- `prompt.js` — the AI's instructions
- `formatter.js` — checks and automatic repair
- `math.js` — reads math from the page, converts it to readable/spoken form
- `background.js` — picks the AI, runs the checks, saves results (keeps the API key off the page)
- `local-ai.js`, `offscreen.html` / `offscreen.js` — Chrome's built-in on-device model
- `settings-ui.js`, `options.html` / `options.js` — settings
