# Figma → HTML/CSS/JS Conversion Workflow

A repeatable engineering process, derived from a real, validated conversion session
(coffee-landing / "Cafe Street", Figma node `179:4172` → 426-line HTML, 1072-line CSS,
306-line vanilla JS, verified to ±0.5px against Figma coordinates).

---

## Phase 0 — Inputs & ground rules

**Required inputs**
- Figma URL with a `node-id` (right-click frame → *Copy link to selection*).
- Target: plain HTML/CSS/JS unless the project dictates a stack.
- Output directory (new folder per page, e.g. `<name>/` with `index.html`, `style.css`, `script.js`, `assets/`).

**Non-negotiable laws** (carried over from the session's pipeline, which proved valuable even when hand-writing):
1. Never invent design — every value (color, size, spacing, radius, shadow) comes from the Figma data, never guessed.
2. Copy text verbatim from text nodes, including trailing spaces and typos.
3. Never hand-draw icons/vectors — always use the exported asset. A drawn approximation is always wrong.
4. Structure comes from the MCP design context, not from squinting at a screenshot. Screenshots confirm; they don't define.
5. Every correction should be small, verifiable, and re-checked in the browser.

---

## Phase 1 — Extract the design (before any code)

1. Load the design-to-code skill (`figma:figma-design-to-code`) — mandatory prerequisite for `get_design_context`.
2. In parallel, call:
   - `get_design_context(fileKey, nodeId)` — returns React+Tailwind **reference** code (never paste verbatim), a screenshot, all asset URLs, and hints.
   - `get_variable_defs(fileKey, nodeId)` — returns the named design tokens (e.g. `Primary #FF902B`, `Secondary #2F2105`, shadow effects). These become the `:root` custom properties.
3. Read the reference code to build a mental model: section list, the design **stage width** (e.g. 1440px), the **content column** (e.g. 1170px), repeated card patterns, glass/gradient surfaces, absolute-positioned decorative layers.
4. `get_screenshot` on sub-nodes only where the context is ambiguous (e.g. to read text inside a logo image).

## Phase 2 — Assets: download once, name well, verify

Asset URLs from the MCP **expire in ~7 days** — always download and commit them.

1. Build a manifest of `semantic-name|asset-id` pairs FIRST (e.g. `hero-cup.png|6fa3…`), then download in one loop with `curl -sS -f` and a `FAILED` echo per miss. (The session downloaded twice — once with generic names — and had to dedupe 31 files. Name first, download once.)
2. Verify: file count matches manifest, `find . -size 0` is empty, no `FAILED` lines.
3. `cat` the small structural SVGs (card shells, masks, panels). They reveal the real fills — e.g. `linearGradient` white 0.4→0.7 + `backdrop-filter: blur(4px)` — which you then reproduce as CSS on real elements instead of stretching the SVG.
4. Photos/logos stay as files; simple rectangles/gradients found inside SVGs are re-expressed as CSS.

## Phase 3 — Write the three files (single deliberate pass)

**index.html**
- Semantic landmarks: `header`, `nav`, `main`, `section`, `article`, `figure`, `footer`.
- Accessibility built in from the start, not retrofitted: skip-link, `aria-label`s, `aria-expanded` on the nav toggle, `aria-pressed` on toggle chips, `role="search"`, empty `alt=""` on decorative images, real `alt` on content images, `width`/`height` attributes on images.
- All copy verbatim from Figma text nodes.
- Decorative full-bleed art goes in a dedicated `aria-hidden` "stage" layer per section.

**style.css**
- Header comment records the design geometry: stage width, container width, side margins, and the source node id.
- `:root` tokens: Figma variables first (named as in Figma), then the literal colors the design uses, gradients, shadows, `--container`, `--gutter`.
- The **stage pattern** for full-bleed decorative art positioned in design coordinates:
  `position:absolute; left:50%; margin-left: calc(designX - stageWidth/2)px` — keeps art pinned to the 1440 design grid at any viewport.
- Container: `max-width: calc(var(--container) + var(--gutter)*2); padding-inline: var(--gutter)` so gutters only bite below the stage width.
- `html { overflow-x: clip }` so the decorative stage can never widen the page.
- Comments state constraints ("title bottom 707 → cards 745"), which makes later pixel-nudging auditable.

**script.js**
- One outer IIFE, `"use strict"`, and **independent, fail-soft IIFEs per behavior** (sticky header, mobile nav, cart, chips, carousel, newsletter, reveal-on-scroll). Each starts with a null-check and returns early — one missing element never kills the rest.
- Respect `prefers-reduced-motion`.
- rAF-throttled scroll handlers with `{ passive: true }`.

## Phase 4 — Serve properly (never file://)

`file://` loads as a static snapshot — CSS/JS/assets don't resolve in the preview pane. Do it right the first time:
1. Write a minimal Node static server (with content-types and path-traversal guard) using the **Write tool** (not a bash heredoc — the session's heredoc mangled a regex escape and crashed the server on first boot).
2. Create `.claude/launch.json` pointing at it; start with `preview_start`.
3. If startup fails, the error output names the line — fix and restart.

## Phase 5 — Fidelity loop: measure, don't eyeball

Set the viewport to the design stage size (e.g. 1440px wide). Then loop:

1. **Neutralize animation before measuring**: `document.documentElement.style.scrollBehavior='auto'` and force all `.reveal` elements visible, then wait ~400ms.
2. **Geometry probe**: one `javascript_exec` snippet that returns `[left, top+scrollY, width, height]` for a named anchor element in *every* section (h1, cards, titles, figures, buttons, forms). Correct for viewport offset: `off = (stageWidth - innerWidth)/2`.
3. **Compare to Figma coordinates** from the design context. Deltas become a batch of small CSS patches. Apply many exact substitutions in one scripted pass — each guarded (`assert old in file`) so a miss fails loudly instead of silently skipping.
4. Navigate (reload) → re-probe. **Exit criterion: every anchor within ~0.5px.**
5. Also in each probe: `imgFail` (`[...document.images].filter(i => !i.complete || !i.naturalWidth)`), console errors, `document.fonts.check(...)` for the webfont.

## Phase 6 — Visual pass: section by section vs Figma

Numbers can match while looks don't. Scroll each section into view, screenshot, and compare against `get_screenshot` of the corresponding Figma node. (This is how the session caught a wrong circular crop on the hero cup — the reference had a transparent-background photo.) Fix, reload, re-shoot.

## Phase 7 — Responsive pass (evidence-driven)

The design usually has only a desktop frame, so breakpoints are engineering decisions — make them intentionally and check them empirically:

1. At each width (375 mobile preset, 768 tablet preset, ~436 in-between, desktop):
   - **Overflow check**: `scrollWidth > clientWidth` on `documentElement`.
   - If overflowing, run the **overflow hunter**: iterate `body *`, collect elements whose rect exceeds the viewport **and** have no `overflow:hidden/clip/auto` ancestor — that list names the real culprits (in the session: the testimonial band and the 1440px stage art).
   - Fix at the source (clip the section, rescale the badge, restore the gutter), not by hiding symptoms.
2. Verify grid/stack behavior (columns collapse, cards center, `justify-content` as intended).
3. Reset the viewport with `preset: "desktop"` when done.

## Phase 8 — Interaction pass: drive it programmatically

Test every behavior with `javascript_exec`, asserting state — not by assuming the code works:
- Cart: click add buttons → badge unhides and counts.
- Toggle chips: exactly one `is-active` + `aria-pressed` per group.
- Carousel: click each dot, wait for the transition, read `transform` per dot — the session found two real bugs this way (maxOffset mis-measured absolutely-positioned captions; then a double-subtraction of the current offset). Re-test after each fix, at desktop **and** mobile widths.
- Forms: dispatch submit with invalid then valid input; assert message text, `aria-invalid`, field cleared.
- Sticky header: scroll → class appears; scroll back → class removed.
- Mobile nav: toggle open/close; `aria-expanded` tracks; closes on link click / Escape / outside click.

## Phase 9 — Definition of done

All of these, verified in the running browser — never "it compiles":
- [ ] Geometry anchors within ~0.5px of Figma at stage width
- [ ] Every section visually matches its Figma screenshot
- [ ] No console errors, no failed images, webfont confirmed loaded
- [ ] No horizontal overflow at 375 / 768 / desktop
- [ ] Every interaction asserted programmatically (desktop + mobile)
- [ ] Assets committed locally (Figma URLs expire), semantic names
- [ ] Copy verbatim; semantic HTML; a11y attributes present; reduced-motion respected
- [ ] Final report to user: file list, fidelity table (Figma vs rendered), checks performed

## Known gaps to improve on (observed weaknesses)

- **Optimize images** — the session shipped 6.6MB of PNGs untouched. Add a compression pass (or at least flag it).
- **State the invented breakpoints** to the user, since the design had no mobile frames.
- **Run an automated a11y audit** (axe-core via CDN in the page, or headings/contrast spot checks), not just built-in semantics.
- **Compare sections against Figma screenshots earlier** (right after Phase 5, per section) — the circular-crop bug survived until the visual pass.
- Prefer the Write/Edit tools over bash heredocs for any file containing regexes/backslashes (Windows escaping broke the server once).
- Batch scripted CSS patches are fine, but keep each substitution assert-guarded and re-verify in the browser immediately after.
