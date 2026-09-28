/**
 * The content column of each top-level section, measured from the design.
 *
 * It is tempting to assume a page has ONE content column and give the generator
 * a single `.container`. Real designs rarely do: in one coffee landing page the
 * header ran 1161px wide from x=135, the product band 1268px from x=86, the menu
 * 1148px from x=146 and the how-to 1170px from x=135 — four different columns,
 * two of them not even centred on the canvas.
 *
 * One container cannot serve four widths, and the error it produces is invisible
 * at the element level: each child sits correctly inside its container, so the
 * fix rounds are told "this is 4.5px right" with no property to change, because
 * the mistake is two levels up and correcting it would break the other sections.
 * Measuring the columns and naming them removes the guess entirely.
 */
export function sectionContentWidths(tree, stageWidth) {
  const out = [];

  for (const section of tree.children || []) {
    if (!section.box || section.box[3] < 80) continue;

    // The content column is the widest block that is clearly inset from the
    // canvas edges — full-bleed art and backgrounds are not content.
    let best = null;
    (function walk(n, depth) {
      if (depth > 3) return;
      const b = n.box;
      if (b && depth > 0) {
        const [x, , w] = b;
        const inset = x > 8 && x + w < stageWidth - 8;
        if (inset && w > stageWidth * 0.45 && (!best || w > best.w)) {
          best = { x, w, name: n.name };
        }
      }
      (n.children || []).forEach((c) => walk(c, depth + 1));
    })(section, 0);

    if (!best) continue;
    const left = Math.round(best.x);
    const right = Math.round(stageWidth - (best.x + best.w));
    out.push({
      section: section.name,
      id: section.id,
      width: Math.round(best.w),
      left,
      right,
      centred: Math.abs(left - right) <= 2,
    });
  }

  // Report the most common column too: if every section agrees, one container
  // really is right and saying so is more useful than listing it five times.
  const byWidth = new Map();
  for (const s of out) byWidth.set(s.width, (byWidth.get(s.width) || 0) + 1);
  const dominant = [...byWidth.entries()].sort((a, b) => b[1] - a[1])[0];

  return {
    sections: out,
    uniform: byWidth.size === 1,
    dominantWidth: dominant ? dominant[0] : null,
  };
}
