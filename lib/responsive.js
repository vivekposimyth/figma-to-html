/**
 * Responsive quality checks.
 *
 * The design only ever has a desktop frame, so every mobile layout is the
 * generator's own invention — and it was the least-checked part of the pipeline:
 * the only question asked of a narrow viewport was "does the page scroll
 * sideways?". That misses the most common way a responsive layout actually
 * breaks, because flexbox's default is to SHRINK children rather than wrap, so a
 * row the generator forgot to collapse squeezes silently and never overflows.
 *
 * Every check here is structural — no class names, no layer names — and each was
 * tuned against known-good output so it stays quiet when the layout is fine.
 */
export async function checkResponsiveQuality(page, viewportWidth) {
  return page.evaluate((vw) => {
    const lab = (e) =>
      e.tagName.toLowerCase() + (e.className ? "." + String(e.className).trim().split(/\s+/)[0] : "");
    const rect = (e) => e.getBoundingClientRect();
    const shown = (e) => {
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.05) return false;
      const b = rect(e);
      return b.width > 1 && b.height > 1 && b.left > -200 && b.top > -2000;
    };
    const textOf = (e) => (e.textContent || "").trim();
    const isText = (e) => e.tagName !== "IMG" && e.tagName !== "SVG" && textOf(e).length > 1;
    // where the GLYPHS actually are, not where the box is: a full-width centred
    // heading has a box at x=0 but its text nowhere near the edge
    const textRects = (e) => {
      try {
        const r = document.createRange();
        r.selectNodeContents(e);
        return [...r.getClientRects()].filter((b) => b.width > 1 && b.height > 1);
      } catch { return []; }
    };
    const inScroller = (e) => {
      let p = e.parentElement;
      while (p && p !== document.body) {
        const o = getComputedStyle(p).overflowX;
        if ((o === "auto" || o === "scroll") && p.scrollWidth > p.clientWidth + 2) return true;
        p = p.parentElement;
      }
      return false;
    };
    const out = { squeezed: [], overlaps: [], edgeTouch: [], cramped: [] };

    // 1. A column squeezed too narrow to read. Measured in characters, not
    //    pixels, so it holds for any font size.
    for (const e of document.querySelectorAll("p,li,h1,h2,h3,h4,span,a,div,figcaption")) {
      if (e.children.length) continue;                 // leaves only: real text, real box
      const txt = textOf(e);
      if (txt.length < 20) continue;
      if (!shown(e)) continue;
      const fontSize = parseFloat(getComputedStyle(e).fontSize) || 16;
      const charsPerLine = rect(e).width / (fontSize * 0.5);
      if (charsPerLine < 10)
        out.squeezed.push({
          el: lab(e), width: Math.round(rect(e).width), fontSize: Math.round(fontSize),
          charsPerLine: Math.round(charsPerLine), text: txt.slice(0, 30),
        });
    }

    // 2. Two pieces of visible content sitting on top of each other. Geometry
    //    measures each element alone and overflow only watches the viewport
    //    edge, so a collision passes both.
    // Only text-vs-text counts. Text sitting on an image is how designs work;
    // two pieces of text on top of each other never is.
    const content = [...document.querySelectorAll("*")].filter(
      (e) => !e.children.length && shown(e) && isText(e)
    );
    const seenPair = new Set();
    for (let i = 0; i < content.length; i++) {
      for (let j = i + 1; j < content.length; j++) {
        const a = content[i], b = content[j];
        if (a.contains(b) || b.contains(a)) continue;
        // deliberate stacking: both positioned and layered against each other
        const ca = getComputedStyle(a), cb = getComputedStyle(b);
        const layered = ca.position !== "static" && cb.position !== "static" &&
          (ca.zIndex !== "auto" || cb.zIndex !== "auto");
        if (layered) continue;
        const ra = rect(a), rb = rect(b);
        const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
        const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
        if (ox <= 8 || oy <= 8) continue;
        const key = lab(a) + "|" + lab(b);
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        out.overlaps.push({
          a: `${lab(a)} "${textOf(a).slice(0, 14)}"`,
          b: `${lab(b)} "${textOf(b).slice(0, 14)}"`,
          overlapPx: `${Math.round(ox)}x${Math.round(oy)}`,
        });
      }
      if (out.overlaps.length >= 6) break;
    }

    // 3. Text pinned against the viewport edge with no gutter. Not an overflow,
    //    so nothing else notices — it just looks broken.
    for (const e of document.querySelectorAll("p,h1,h2,h3,h4,li,figcaption")) {
      if (e.children.length || !shown(e)) continue;
      if (textOf(e).length < 10) continue;
      if (inScroller(e)) continue;          // a sideways carousel is meant to run off-screen
      const rs = textRects(e);
      if (!rs.length) continue;
      const left = Math.min(...rs.map((r) => r.left));
      const right = Math.max(...rs.map((r) => r.right));
      if (right - left < 40) continue;
      if (left < 8 || right > vw - 8)
        out.edgeTouch.push({ el: lab(e), textLeft: Math.round(left), textRight: Math.round(right), viewport: vw });
    }

    // 4. A control too small for its own label, so the text wraps inside it.
    for (const e of document.querySelectorAll("button, a[class*='btn'], a[class*='button'], [role='button']")) {
      if (!shown(e)) continue;
      const txt = textOf(e);
      if (txt.length < 2 || txt.length > 24) continue;
      // Ask the box directly: how wide would this label need to be on one line?
      // If that is more than the control actually has, the label wrapped. Box
      // height proves nothing — padding legitimately makes buttons tall — and
      // counting text rects catches icons sitting beside the label.
      const prev = e.style.whiteSpace;
      e.style.whiteSpace = "nowrap";
      const needed = e.scrollWidth;
      e.style.whiteSpace = prev;
      const have = e.clientWidth;
      if (have > 0 && needed > have + 2)
        out.cramped.push({
          el: lab(e), text: txt.slice(0, 20),
          hasWidth: Math.round(have), needsWidth: Math.round(needed),
        });
    }

    for (const k of Object.keys(out)) out[k] = out[k].slice(0, 6);
    return out;
  }, viewportWidth);
}
