# Question Reformatter

A Chrome extension that breaks dense Gradescope questions into a calm, scannable layout — **what you're asked → given → context → answer choices** — for students with dyslexia, autism, ADHD, or anyone who loses the question inside a long paragraph.

It changes the **layout**, never the **content**. It never solves, hints, or reorders answers.

## Install (Chrome)
1. Unzip this folder somewhere you'll keep it.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** → pick the `question-reformatter` folder.
5. Open a Gradescope assignment. A toolbar appears bottom-right.

## Use
- **Reformat questions** — tries to find every question on the page.
- **Pick a question** — if auto-find misses, click this, then click the question.
- The broken-down version appears **above** the original.
  - "What you're asked" → "Given" → "Context" → answer choices.
  - Numbers are blue. Words like NOT / except / at least are red and underlined.
  - Click a choice in the panel → it selects that answer in the real question.
  - 🔊 Read aloud reads the panel.

## Modes
- **Rules (default)**
  - No AI. Nothing leaves your browser.
  - Only splits, regroups and highlights the original words.
- **AI**
  - Needs an Anthropic API key (settings ⚙).
  - Follows strict instructions in `prompt.js`: layout only, no solving, no hints, no method names.
  - Every AI result is checked automatically. If any number, answer choice, or word like "not" was changed, added or dropped, the AI version is thrown out and the Rules version is shown.

## Saved results (no repeat cost)
- Every AI result that passes the safety check is saved on this device.
- Same question again (reload, come back tomorrow, re-click) → the saved one is used. No new tokens.
- Panels you had open re-appear when you return to the assignment. A return visit never calls the AI on its own.
- Settings → "Saved AI results" shows the count and has a Clear button.

## Math
- Reads math from MathJax (2 and 3), KaTeX, and MathML.
- The panel shows the page's own rendered math, so it looks identical.
- Each math piece is read aloud correctly by screen readers / Speechify (e.g. "H-naught, pi is not equal to 0.09").
- A "Symbols — how to say them" line lists symbols like μ "mu", H₀ "H-naught", ≠ "is not equal to".
- The AI sees math as placeholders (⟦M1⟧) and must copy them exactly. If it changes, drops or writes out any math, the AI version is rejected.

## Before using on graded work
- Get approval from your instructor and your school's disability services office.
- Show them the settings page → "Show the exact instructions the AI gets".

## Files
- `math.js` — reads math from the page, converts it to readable/spoken form
- `formatter.js` — rules mode + safety checks
- `prompt.js` — the AI's instructions
- `content.js` / `content.css` — the on-page toolbar and panel
- `background.js` — AI call (keeps the API key off the page)
- `options.html` / `options.js` — settings
