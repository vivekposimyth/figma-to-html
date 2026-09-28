import fs from "node:fs";
import { chat } from "./llm.js";

/**
 * Visual inspection by judgement instead of by rule.
 *
 * Coded checks can only find defects somebody thought to enumerate — geometry,
 * overflow, clipping, broken images. Real designs break in ways no rule
 * anticipates: a gradient going the wrong way, an icon that is subtly the wrong
 * one, a shadow that reads as a border, text that wrapped into three lines
 * instead of two. A model looking at the design and the render side by side
 * catches those without anyone predicting them first.
 *
 * Two deliberate choices:
 *  - This runs as its OWN call with no memory of having written the code, so it
 *    critiques rather than defends. A generator reviewing itself passes itself.
 *  - It is told to report only what it can SEE, and to say nothing when the two
 *    images match, so it does not manufacture work.
 */
const SYSTEM = `You are a meticulous design QA reviewer. You are shown pairs of images: on the LEFT the intended design, on the RIGHT the current web implementation of it, with the design's y-range labelled.

Report ONLY differences you can actually see. For each one give:
  - where it is (which element, which part of the crop)
  - what the design shows vs what the render shows
  - the most likely CSS/HTML cause

Rules:
- Ignore differences smaller than a couple of pixels, font antialiasing, and image compression artefacts.
- Ignore the fact that photos may be at different scales if the framing is the same.
- Be specific: "the card's shadow is missing" not "styling differs".
- Order by how much a person would notice: missing or wrong elements first, then colour/typography, then spacing.
- If the two sides match apart from trivia, return an empty findings list. Saying "nothing significant" is a valid and useful answer.

Reply as JSON only, no prose around it:
{"findings":[{"where":"...","design":"...","render":"...","likelyCause":"...","severity":"high|medium|low"}]}`;

export async function inspectVisually(cfg, { crops, figmaShot, renderShot, mobileShot }) {
  if (!cfg.vision) return null;
  // The mobile view always goes in: the design has no mobile frame, so that
  // layout is invented and unreviewed by anything else.
  const images = [...(crops?.length ? crops : [figmaShot, renderShot]), mobileShot].filter(
    (p) => p && fs.existsSync(p)
  );
  if (!images.length) return null;

  const parts = [{
    type: "text",
    text: (crops?.length
      ? `Side-by-side crops of the regions that differ most (LEFT = design, RIGHT = render). Report what is actually wrong in each.`
      : `First image: the intended design. Second image: the current render of the whole page. Report what is actually wrong.`)
      + (mobileShot ? `\n\nThe LAST image is the same page at 375px wide. There is no mobile design to compare it against, so judge it on its own merits: is anything squeezed, colliding, cut off, touching the edge with no gutter, or unreadable? Report those the same way.` : ""),
  }];
  let budget = 4 * 1024 * 1024;
  for (const p of images) {
    const buf = fs.readFileSync(p);
    if (buf.length > budget) continue;
    budget -= buf.length;
    const mime = /\.jpe?g$/i.test(p) ? "image/jpeg" : "image/png";
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
    });
  }

  let res;
  try {
    res = await chat({ ...cfg, maxTokens: Math.min(cfg.maxTokens, 8000) }, {
      system: SYSTEM,
      userContent: parts,
    });
  } catch (e) {
    return { error: e.message, usage: null };
  }

  const m = res.text.match(/\{[\s\S]*\}/);
  let findings = [];
  if (m) {
    try { findings = JSON.parse(m[0]).findings || []; } catch { /* keep empty */ }
  }
  return {
    findings: findings.slice(0, 12),
    usage: res.usage,
    raw: findings.length ? undefined : res.text.slice(0, 300),
  };
}

/**
 * Triage: decide which reported failures are REAL defects.
 *
 * The coded checks in validate.js are hypotheses, not verdicts. Each one freezes
 * a judgement somebody made once — "an element's rendered box should match its
 * Figma box" — and a frozen judgement is wrong on some designs. When it is, the
 * generator has no way to disagree: it is handed a failure list and told to fix
 * it, so it obeys, and a rule's mistake becomes the page's mistake. That is
 * exactly how a Figma GROUP's union-of-children box, which is not a CSS box at
 * all, became `width: 1521px` and a horizontal scrollbar.
 *
 * So the model gets to look at the two pictures and say "that one is not a
 * defect" BEFORE the list reaches the score or the fix round. It cannot reject
 * anything objectively verifiable — a thrown error, a broken image, a failed
 * interaction, a page wider than its viewport are facts, not opinions. It may
 * only rule on the classes that are somebody's heuristic, and it must give a
 * reason for every rejection so a wrong rule shows up in the log instead of
 * silently steering the next patch.
 */
// Only "geometry" for now, deliberately. It is the one class that is a flat list
// of independent items, so a verdict can be given per item — and it is where the
// damage is: a frozen box comparison against a design node that has no CSS box.
// The other judgement-based classes (responsive, visual, lostFlow, notFullBleed,
// clippedElements) are single structured reports, not lists, so the only verdict
// available on them is "drop the whole report", which is far too blunt. They can
// join once they report per-item.
const TRIAGEABLE = new Set(["geometry"]);

const TRIAGE_SYSTEM = `You are triaging the output of automated checks on a web page built from a design.

You see the intended design and the current render. For each reported failure, decide ONE thing: would a person looking at this page call it a defect?

Reject a failure when the check is measuring something that is not really there:
- A wrapper or group whose only job is to hold children. In the design tool a group's box is just the union of its children — it has no fill, no border, nothing to see — so its width and height cannot be "wrong" on the page. Only its children's positions are real.
- An element sitting at the right place but reported as too wide, when it is a block-level container whose width comes from its parent and nothing visible fills it.
- Decorative art that hangs past the edge of the frame by design.
- A difference the two pictures simply do not show.

Keep a failure when you can see it, or when it plainly follows from the numbers:
- Anything visibly out of place, overlapping, missing, cut off, or the wrong size.
- An element whose position (x or y) is off — position errors are almost always real, even when small.
- Anything you are unsure about. Keeping a false alarm costs one wasted patch; dropping a real defect ships it.

Reply as JSON only, no prose:
{"rejected":[{"id":"<the id given>","why":"<short reason>"}]}
Return {"rejected":[]} if every failure looks real.`;

export async function triageFailures(cfg, { failures, figmaShot, renderShot, mobileShot }) {
  if (!cfg.vision) return null;

  // Build a compact, addressable list of only the judgement-based failures.
  const items = [];
  for (const [key, list] of Object.entries(failures)) {
    if (!TRIAGEABLE.has(key) || !Array.isArray(list)) continue;
    list.forEach((f, i) => {
      const id = `${key}#${i}`;
      if (f.sharedCause) {
        items.push({ id, what: f.sharedCause, elements: (f.elements || []).map((e) => e.el).join(", ") });
      } else {
        items.push({
          id,
          what: f.el || f.name || f.section || JSON.stringify(f).slice(0, 120),
          delta: f.delta,
          designBox: f.design,
          css: f.computed && { position: f.computed.position, display: f.computed.display },
          parent: f.parent && { tag: f.parent.tag, display: f.parent.display },
        });
      }
    });
  }
  if (!items.length) return { rejected: [], usage: null, considered: 0 };

  const images = [figmaShot, renderShot, mobileShot].filter((p) => p && fs.existsSync(p));
  const parts = [{
    type: "text",
    text: `First image: the intended design. Second image: the current render.` +
      (mobileShot ? ` Third: the same page at 375px wide.` : "") +
      `\n\nReported failures:\n${JSON.stringify(items, null, 1)}`,
  }];
  let budget = 4 * 1024 * 1024;
  for (const p of images) {
    const buf = fs.readFileSync(p);
    if (buf.length > budget) continue;
    budget -= buf.length;
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${/\.jpe?g$/i.test(p) ? "image/jpeg" : "image/png"};base64,${buf.toString("base64")}`,
      },
    });
  }

  let res;
  try {
    res = await chat({ ...cfg, maxTokens: Math.min(cfg.maxTokens, 4000) }, {
      system: TRIAGE_SYSTEM,
      userContent: parts,
    });
  } catch (e) {
    return { error: e.message, rejected: [], usage: null, considered: items.length };
  }

  const m = res.text.match(/\{[\s\S]*\}/);
  let rejected = [];
  if (m) { try { rejected = JSON.parse(m[0]).rejected || []; } catch { /* keep empty */ } }

  // Never let triage empty a class entirely on a single call — if it wants to
  // drop everything, the rule is either right or the model misread the task,
  // and silently shipping a blank list is the worse of the two outcomes.
  const byKey = {};
  for (const r of rejected) {
    const key = String(r.id || "").split("#")[0];
    if (TRIAGEABLE.has(key)) (byKey[key] ||= []).push(r);
  }
  const kept = [];
  for (const [key, rs] of Object.entries(byKey)) {
    const total = (failures[key] || []).length;
    if (rs.length >= total && total > 1) continue;   // refuse a clean sweep
    kept.push(...rs);
  }
  return { rejected: kept, usage: res.usage, considered: items.length };
}

/** Remove triaged-out failures from a validation result, in place. */
export function applyTriage(result, rejected) {
  const drop = new Map();
  for (const r of rejected) {
    const [key, idx] = String(r.id).split("#");
    if (!drop.has(key)) drop.set(key, new Set());
    drop.get(key).add(Number(idx));
  }
  for (const [key, idxs] of drop) {
    const list = result.failures[key];
    if (!Array.isArray(list)) continue;
    const next = list.filter((_, i) => !idxs.has(i));
    if (next.length) result.failures[key] = next;
    else delete result.failures[key];
  }
  result.pass = Object.keys(result.failures).length === 0;
  return result;
}
