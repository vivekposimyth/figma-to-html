import { INTERACTIONS_SCHEMA } from "./interactions.js";
export const FILE_MARKER_HELP = `Return the complete files using EXACTLY this format (no markdown fences around the markers):

===FILE: index.html===
<file content>
===END===
===FILE: style.css===
<file content>
===END===
===FILE: script.js===
<file content>
===END===`;

export const SYSTEM_PROMPT = `You are a senior frontend engineer converting a Figma design into production-quality plain HTML, CSS and vanilla JavaScript.

NON-NEGOTIABLE LAWS
1. Never invent design values. Every color, size, spacing, radius, shadow and font value comes from the design data provided. Do not round or "improve" them.
2. Copy ALL text verbatim from the design's text nodes — including trailing spaces and typos.
3. Never hand-draw icons or vector shapes. Use the provided asset files (relative path "assets/<file>") for every icon, logo, photo and decorative vector. No inline <svg> paths of your own invention, no emoji placeholders.
4. Structure comes from the design tree data, not guesswork.

ARCHITECTURE RULES
- Exactly three files: index.html, style.css, script.js.
- A real document head: lang on <html>, charset, viewport, a <title> and meta description taken from the design's own brand name and hero copy (never lorem or a filename), and a <link> that loads every font family/weight the design uses (the FONTS list in the prompt) before style.css. A missing font link is reported back to you as a failure.
- Semantic HTML: header/nav/main/section/article/figure/footer. Headings in order.
- Accessibility built in: a skip link, aria-label on icon-only buttons, aria-expanded on the nav toggle, alt="" on decorative images, real alt on content images, :focus-visible styles, aria-pressed on toggle buttons.
- CSS: define design tokens as custom properties in :root (use the provided variable names when given). Comment the design geometry (stage width, container width) at the top.
- Every spacing value that positions a data-fig element must carry the design coordinates it comes from, e.g. \`padding-top: 38px;   /* title bottom 707 -> cards 745 */\`. Later automated fix rounds depend on these comments to know which number to adjust and by how much — a bare \`38px\` is unfixable without re-deriving it.
- The design "stage" is STAGE_WIDTH px wide. Full-bleed decorative art lives in aria-hidden absolute layers positioned in design coordinates: left: 50%; margin-left: calc(<designX>px - STAGE_WIDTH/2 px). Add html { overflow-x: clip; } so decorative art never widens the page.
- Content column: use a .container with the design's content max-width and a --gutter padding.
- Responsive: the design is desktop-only, so create sensible breakpoints at 1024px, 768px and 480px. Grids collapse, layouts stack, nothing overflows horizontally at 375px. Never let any element cause document.scrollWidth to exceed the viewport at 375, 768 or STAGE_WIDTH px.
- JavaScript: one outer IIFE with "use strict"; each behavior (sticky header, mobile nav, tabs, carousel, forms...) is its own inner IIFE that null-checks its elements and returns early — fail soft. Respect prefers-reduced-motion. Scroll handlers use requestAnimationFrame and { passive: true }.
- Implement interactions the design implies (nav, hover states, carousel dots if testimonial cards repeat, form validation with an inline message) — but never invent new sections or content.

VALIDATION HOOKS (required — the output is machine-checked)
- The prompt gives you an explicit ANCHOR LIST of node ids. Put data-fig="<node id>" on exactly the elements that correspond to those anchors — no more, no less. An automated harness measures each [data-fig] element against the design box and returns deltas to you as failures.
- Do NOT tag deeply nested text spans or small inline bits; tagging things outside the anchor list only creates noise.
- Absolute positioning is allowed and encouraged where the design is clearly freeform; flex/grid where the design uses auto-layout ("layout" field in the data).

READING THE DESIGN TREE
- "sizing" is the designer's resize intent and overrides the measured box: w/h "fill" means stretch with the parent (width:100% or flex:1 — NOT a pixel width), "hug" means shrink to content (fit-content/auto), "fixed" means a real pixel size. A "fill" box turned into a hardcoded px width is a bug even when it measures correctly at stage width.
- "pin" is the Figma constraint (e.g. "center/top", "scale/top") — it tells you how the element should behave as the viewport changes.
- "gradient" fills carry "angleDeg" — use it (linear-gradient(<angleDeg>deg, ...)); do not default everything to top-to-bottom.
- Image assets are rendered from their node, so Figma's crop/pan/zoom is already baked into the file. Draw them at the node's box size with object-fit: cover and do NOT invent a different object-position.

${FILE_MARKER_HELP}`;

/** Shared design context block used by every per-file generation call. */
export function designContext({ designJson, variables, manifest, stage, pageName, anchors = [], fonts = [], components = [] }) {
  const assetList = manifest
    .map((a) =>
      `- assets/${a.file}  (${a.kind}, from node "${a.name}")` +
      (a.cssShape ? `\n    NOT ARTWORK — this export is a ${a.cssShape}. Reproduce it in CSS on the real element; do NOT use this file as an <img>.\n    source: ${a.source}` : "")
    )
    .join("\n");
  const anchorList = anchors
    .map((a) => `- ${a.id}  "${a.name}"  box=[${a.box.join(", ")}]${a.compare === "position" ? "  (text: position checked, width/height free)" : ""}`)
    .join("\n");
  return `We are converting the Figma frame "${pageName}" into index.html + style.css + script.js.

STAGE_WIDTH = ${stage.width}px, design height = ${stage.height}px.

ANCHOR LIST — put data-fig="<id>" on exactly these ${anchors.length} elements (these and only these are measured):
${anchorList || "(none)"}
${components.length ? `
INTERACTIVE COMPONENTS the design appears to contain. Build each as real, working controls — never as a flat image. Entries marked (verified) are checked automatically; the rest are hints from layer naming, so use your own judgement on those:
${components.map((c) => `- ${c.id}  "${c.name}" (${c.kind}${c.count ? `, ${c.count} items` : ""}${c.confidence === "structural" ? ", verified" : ", hint"}) at [${c.box.join(", ")}]\n    ${c.hint}`).join("\n")}
` : ""}

FONTS the design uses — load every one of these in the head (Google Fonts or @font-face) and use the exact family names:
${fonts.map((f) => `- ${f.family}  weights ${f.weights.join(", ")}`).join("\n") || "(none detected)"}

FIGMA VARIABLES (use these as :root token names):
${JSON.stringify(variables, null, 1)}

AVAILABLE ASSET FILES (reference by exact relative path; do not reference anything else):
${assetList || "(none)"}

DESIGN TREE (coordinates are [x, y, w, h] relative to the frame, in px):
${designJson}`;
}

/**
 * The files are generated ONE PER CALL (large pages overflow a single completion):
 * index.html first, then style.css against that HTML, then script.js.
 */
export function filePrompt({ target, ctx, files }) {
  const parts = [ctx];
  if (target === "index.html") {
    parts.push(`TASK: Produce ONLY the complete index.html now (style.css and script.js come in later calls — just reference them with <link rel="stylesheet" href="style.css"> and <script src="script.js" defer>).
Follow every HTML rule in the system prompt: semantic landmarks, a11y attributes, text verbatim, assets by exact path, and data-fig="<node id>" on every structural element.

Return exactly one block:
===FILE: index.html===
<content>
===END===`);
  } else if (target === "style.css") {
    parts.push(`THE ALREADY-GENERATED index.html (style every class/id it uses; do not invent new markup):
${files["index.html"]}

TASK: Produce ONLY the complete style.css now. Follow every CSS rule in the system prompt: :root tokens, documented stage geometry, the stage pattern for full-bleed art, html{overflow-x:clip}, responsive breakpoints at 1024/768/480px with no horizontal overflow at 375px. Elements carrying data-fig must land on their design-tree [x,y,w,h] coordinates at stage width.

Return exactly one block:
===FILE: style.css===
<content>
===END===`);
  } else if (target === "script.js") {
    parts.push(`THE ALREADY-GENERATED index.html (hook into its classes/ids/data attributes; do not assume markup that isn't there):
${files["index.html"]}

TASK: Produce ONLY the complete script.js now. Follow every JS rule in the system prompt: one outer IIFE, independent fail-soft inner IIFEs per behavior, prefers-reduced-motion, rAF + passive scroll handlers. Implement only the interactions this page's markup implies.

Return exactly one block:
===FILE: script.js===
<content>
===END===`);
  } else {
    parts.push(`THE index.html AND script.js YOU JUST WROTE:

===FILE: index.html===
${files["index.html"]}
===END===
===FILE: script.js===
${files["script.js"]}
===END===

TASK: Produce ONLY interactions.json — a machine-runnable test plan for EVERY behaviour your script.js implements, plus any behaviour the markup implies (anchor links that scroll, details/summary, etc).

This is how your work gets verified: a harness replays these steps in a real browser and asserts your expectations. It is not a summary — wrong selectors or expectations that don't hold WILL be reported as failures. So:
- One entry per behaviour. Cover all of them; an unlisted behaviour is untested, and untested behaviour that is broken will still be caught by other checks and blamed on you.
- Use the real selectors from the markup above.
- Each entry starts from a freshly loaded page, so include every step needed.
- Set "viewport" for behaviours that only exist at a width (e.g. 375 for a mobile nav).
- Assert what the user would SEE or what assistive tech would read, not implementation trivia.

Schema (use only these step and expectation keys):
${INTERACTIONS_SCHEMA}

Return exactly one block of valid JSON:
===FILE: interactions.json===
{ "interactions": [ ... ] }
===END===`);
  }
  return parts.join("\n\n");
}

/**
 * Which files a failure could possibly be fixed in. Sending all three every
 * round costs ~19K tokens of input AND invites the model to answer in kind —
 * shown three complete files, it tends to return three complete files instead
 * of the patch it was asked for, which is where most of a run's time goes.
 */
const FILES_FOR_FAILURE = {
  geometry: ["style.css"],
  responsive: ["style.css"],
  overflow: ["style.css"],
  visual: ["style.css"],
  visualFindings: ["style.css", "index.html"],
  clippedElements: ["style.css"],
  fontsNotLoaded: ["index.html"],
  brokenImages: ["index.html"],
  missingComponents: ["index.html", "script.js"],
  missingDataFig: ["index.html"],
  interactions: ["script.js", "index.html"],
  declaredInteractions: ["script.js", "interactions.json"],
  interactionsSpecInvalid: ["interactions.json"],
  deadControls: ["script.js", "index.html"],
  consoleErrors: ["script.js"],
  pageErrors: ["script.js"],
};

export function fixPrompt({ validation, files, round, failedPatches = [], hasCrops = false }) {
  const wanted = new Set();
  for (const key of Object.keys(validation))
    (FILES_FOR_FAILURE[key] || ["style.css", "index.html"]).forEach((f) => wanted.add(f));
  // a patch that failed to apply needs its file present to be retried
  failedPatches.forEach((p) => wanted.add(p.file));
  const included = ["index.html", "style.css", "script.js", "interactions.json"]
    .filter((f) => wanted.has(f) && files[f]);
  const omitted = ["index.html", "style.css", "script.js"]
    .filter((f) => files[f] && !wanted.has(f));
  const imageNote = hasCrops
    ? `\nATTACHED IMAGES: side-by-side crops of the regions that differ most. LEFT = the Figma design, RIGHT = your render, labelled with the design-Y range. Look at them and name what is actually wrong (missing background, wrong colour, absent image, wrong spacing) before writing patches.\n`
    : "";
  const patchWarning = failedPatches.length
    ? `\nLAST ROUND ${failedPatches.length} PATCH(ES) DID NOT APPLY — copy OLD text character-for-character from the files below:\n` +
      failedPatches.map((p) => `- ${p.file}: ${p.why}\n    OLD was: ${JSON.stringify(p.old.slice(0, 120))}`).join("\n") + "\n"
    : "";
  return `Fix round ${round}. The generated page was loaded in a real browser and machine-validated. It FAILED these checks:
${patchWarning}${imageNote}

${JSON.stringify(validation, null, 1)}

Interpretation guide:
- "geometry": rendered [data-fig] elements whose position/size differs from the design box by more than the tolerance. "delta" is [dx, dy, dw, dh] in px (rendered minus design), and "checked" says which components are judged (text anchors are judged on position only — never add fixed widths to text to chase dw).
  Each entry hands you everything needed to fix it without searching:
    * "section"     — where it lives in the design (e.g. "Popular rental deals > Frame 990 > card")
    * "computed"    — its live position/display/margin/padding/offsets in the browser
    * "parent"      — the parent's display, padding-top and gap (usually the real cause)
    * "cssRules"    — the actual rules from your style.css that target it, cascade-last first. PATCH ONE OF THESE.
  An entry with "sharedCause" is a CLUSTER: several elements drifted together, so there is ONE property to change — make one patch, not one per element.
  HOW TO FIX A DELTA — do the arithmetic, don't guess:
    * dy = +6 means the element sits 6px too LOW -> find the property that creates that gap (the margin-top/padding-top above it, or its "top" if absolutely positioned) and SUBTRACT 6px from it. dy = -6 -> ADD 6px.
    * Same for dx with margin-left/padding-left/"left".
    * Deltas are exact: a 32px padding with dy=+6 becomes 26px. Keep the comment next to it updated.
- "overflow": widths where document.scrollWidth exceeded the viewport, with the offending elements (no clipping ancestor). Fix at the source — clip the decorative layer, resize or stack the element — don't just hide symptoms.
- "consoleErrors" / "pageErrors": JS errors to eliminate.
- "brokenImages": src values that failed to load — the path is wrong or the asset name doesn't exist; use only paths from the asset list.
- "missingDataFig": too few measurable elements; add data-fig attributes as instructed.
- "fontsNotLoaded": the design's font families/weights never resolved in the browser. Add the correct webfont link (Google Fonts or @font-face) in the <head> and make sure font-family names match exactly.
- "interactions": a behaviour in your script.js is broken — each entry says what failed. These are real bugs found by clicking the page, not style issues; fix the JS (or the markup hooks it relies on).
- "declaredInteractions": your OWN interactions.json was replayed in the browser and an expectation did not hold. Either the behaviour is broken (fix script.js / the markup) or your declaration was wrong (fix interactions.json — e.g. a selector that matches nothing). Never delete an entry just to make it pass.
- "deadControls": these controls produced no DOM change, no scroll and no navigation when clicked. Wire the behaviour the design implies, or make a purely decorative control a real link/non-interactive element.
- "interactionsSpecInvalid": interactions.json is not valid JSON — return a corrected complete file.
- "visualFindings": a separate reviewer looked at the design and your render side by side and listed what actually differs, each with where it is, what the design shows, what your render shows, and the likely cause. These are observations, not measurements — read them as a careful colleague's review and fix the cause they name.
- "responsive": defects found at narrow widths. The design has no mobile frame, so these layouts are yours alone and no other check can see them — none of them make the page overflow. "squeezed" means a flex/grid row shrank its children instead of collapsing (flexbox shrinks by default; give the children flex-basis:100% or a single column at that breakpoint). "overlaps" are two pieces of TEXT sitting on top of each other. "edgeTouch" is text running to the viewport edge with no gutter. "cramped" is a control narrower than its own label, so the label wrapped — "hasWidth"/"needsWidth" give the exact numbers.
- "clippedElements": an element is cut off by a clipping ancestor — the hidden part does not render at all. Give the clipping container padding on that axis with an equal negative margin to keep the layout, or move the overhanging element outside it. Note that "overflow-x: auto" forces the vertical axis to clip too, so a horizontal carousel will eat anything that overhangs its top or bottom.
- "missingComponents": the design contains an interactive component (carousel indicators, a dropdown) that your page does not have as real controls — usually because it was rendered as a single image. Build the actual elements (N buttons, a <select> or an aria-expanded control), wire them in script.js, and add them to interactions.json.
- "visual": the rendered page was pixel-compared against the Figma frame render. "overallDiffPct" is how much differs; "worstBands" are horizontal slices with their design-Y ranges. Each band also carries "designAvgColor" vs "renderAvgColor" — read them even if you cannot see images: a band where the design averages #ff902b and your render averages #ffffff means a background/section fill is missing there. A high band usually means a wrong/missing background image, an asset that did not render, wrong colors, or a section that drifted vertically. "heightDiffPct" is how much taller (+) or shorter (-) the rendered page is than the design — a large value means accumulated vertical spacing errors.

THE FILES THESE FAILURES COULD LIVE IN:

${included.map((f) => `===FILE: ${f}===\n${files[f]}\n===END===`).join("\n")}
${omitted.length ? `(${omitted.join(" and ")} ${omitted.length > 1 ? "are" : "is"} not shown because nothing in these failures points at ${omitted.length > 1 ? "them" : "it"}. Do not patch what you cannot see.)\n` : ""}
HOW TO REPLY — SURGICAL PATCHES, NOT WHOLE FILES.
Rewriting a whole file wastes minutes of generation time. Return only the exact snippets that change, as patch blocks:

===PATCH: style.css===
<<<<<<< OLD
  padding-top: 32px;    /* title bottom 713 */
=======
  padding-top: 38px;    /* title bottom 707 */
>>>>>>> NEW
===END===

Rules for patches:
- The OLD text must appear EXACTLY ONCE in that file, copied character-for-character (indentation included). Include a line or two of surrounding context if a value alone would be ambiguous.
- One patch block per change; emit as many blocks as you need, for any of the three files.
- Keep comments next to changed values updated.
- Only if a change is so sweeping that patches make no sense (a whole section restructured) may you fall back to returning that ONE complete file as ===FILE: name=== ... ===END===.
Change only what the failures require; do not regress passing areas; keep all text verbatim and all rules from the system prompt.`;
}
