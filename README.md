# Figma → Code Pipeline

Automated Figma → HTML/CSS/JS conversion implementing [FIGMA-TO-CODE-WORKFLOW.md](FIGMA-TO-CODE-WORKFLOW.md):
extract via the Figma REST API → download assets with semantic names → generate three files with an LLM
(OpenRouter, any model) → validate in a real browser (Playwright) → automatic fix rounds → fidelity report.

## Setup (once)

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

Then edit `.env` and fill in:

| Key | Where to get it |
|---|---|
| `FIGMA_TOKEN` | Figma → Settings → Security → Personal access tokens (File content: read) |
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| `OPENROUTER_MODEL` | any slug from https://openrouter.ai/models (e.g. `minimax/minimax-m2`) |
| `MODEL_SUPPORTS_VISION` | `true` only if the model accepts image input |

## Run

```bash
node convert.js "https://www.figma.com/design/<key>/<name>?node-id=123-456" --name my-page
```

The URL must contain a `node-id` — in Figma, right-click the frame → **Copy link to selection**.

## Output

```
output/<name>/
  index.html  style.css  script.js   ← the deliverable
  assets/                            ← downloaded Figma assets (URLs expire, bytes committed)
  refs/                              ← design.json, figma-frame.png, per-round screenshots,
                                       validation-round*.json, cost.json
```

The run prints a per-call cost table at the end (real cost from OpenRouter, or estimated from
published pricing when a provider omits it); the same numbers land in `refs/cost.json`.

Exit code 0 = all checks passed; 2 = failures remain after `MAX_FIX_ROUNDS`
(details in `refs/validation-round*.json`).

## What gets validated (per round)

Animations are neutralised first (no transitions, reveals forced visible), then:

- **Geometry** — each element carrying `data-fig="<nodeId>"` is measured with
  `getBoundingClientRect` and compared to its Figma box (tolerance `GEO_TOLERANCE` px).
  Only the design's structural anchors are measured, and text anchors are judged on
  position alone — a text node's width in Figma is the text's own bounds, while in HTML
  a block element fills its parent.
- **Visual diff** — the render is pixel-compared against the Figma frame in 12 horizontal
  bands; failures name the worst bands with their design-Y ranges (`VISUAL_TOLERANCE` %).
  Page-vs-design total height is reported separately.
- **Interactions** — every pattern the page declares is actually driven: `aria-expanded`
  controls must toggle, `aria-pressed`/tab groups must leave exactly one active, carousel
  indicators must move the track, forms must handle their own submit and show validation
  feedback, a scrolled-header state must clear when scrolled back to top.
- **Fonts** — the families/weights the design uses must really resolve (measured against a
  fallback, since `document.fonts.check()` lies about missing families).
- **Horizontal overflow** at stage width / 768 / 375, with an offender hunt that names the
  elements not clipped by any ancestor.
- **Console + page errors**, **broken images**.

Failures are fed back to the LLM as structured JSON for up to `MAX_FIX_ROUNDS` fix passes.
Fixes come back as surgical patches (`===PATCH: file===` with git-conflict markers), not
whole-file rewrites — roughly 5x faster and cheaper per round.

## Notes & limits

- Named design tokens need Figma's Variables REST endpoint (Enterprise). Without it, the pipeline
  uses resolved colors from nodes — everything still works, token *names* are lost.
- Images are not compressed; the final log flags files > 300KB.
- Interaction checks are pattern-based: they only fire when the page declares the pattern
  (an `aria-expanded` control, a dot group, a form). A behaviour built without those hooks
  is not checked.
- Very large frames (>400KB design tree) are expensive — convert section frames separately.
