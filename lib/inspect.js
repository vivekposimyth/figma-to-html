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
