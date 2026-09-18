import { rgbaToCss } from "./figma.js";
import { inferFlow } from "./infer-layout.js";

const VECTOR_TYPES = new Set([
  "VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE", "ELLIPSE",
  "REGULAR_POLYGON", "RECTANGLE",
]);
const PURE_VECTOR = new Set(["VECTOR", "BOOLEAN_OPERATION", "STAR", "LINE"]);

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * Figma stores a cropped background fill as an affine matrix over the image's
 * normalised space. Nothing downstream can guess it, and getting it wrong shows
 * a different part of the photo — so translate it into the CSS the generator
 * actually needs. For an unrotated crop the visible region is
 *   x in [tx, tx + a],  y in [ty, ty + d]
 * which is exactly what background-size/background-position express.
 */
function cropToCss(fill) {
  const m = fill.imageTransform;
  if (!m) return { css: "background-size: cover; background-position: center;" };
  const [[a, b, tx], [c, d, ty]] = m;
  if (Math.abs(b) > 1e-6 || Math.abs(c) > 1e-6)
    return { rotatedCrop: true, css: "background-size: cover; background-position: center;" };

  const pct = (v) => Math.round(v * 1000) / 10;
  const posX = a < 0.999 ? pct(tx / (1 - a)) : 50;
  const posY = d < 0.999 ? pct(ty / (1 - d)) : 50;
  return {
    css: `background-size: ${pct(1 / a)}% ${pct(1 / d)}%; background-position: ${posX}% ${posY}%; background-repeat: no-repeat;`,
    imageTransform: m,
  };
}


/**
 * Turn Figma's raw node tree into a compact design.json the LLM can digest:
 *  - coordinates relative to the frame origin ([x, y, w, h], 0.1px precision)
 *  - text verbatim with resolved typography
 *  - fills/strokes/effects resolved to CSS-ish values
 *  - asset export plan: image fills -> png by imageRef, vector art -> svg by nodeId
 */
/**
 * Pick the structural landmarks to measure against Figma — the same kind of
 * anchors the reference session hand-picked (~25 of them): section containers,
 * headings, cards, figures, buttons, forms. Deeply nested text spans are
 * deliberately excluded: in Figma a text node's box is the text's own bounds,
 * while in HTML a block element fills its parent, so comparing their widths
 * produces failures that cannot be fixed without bad markup.
 */
export function selectAnchors(tree) {
  const out = [];
  const MAX_DEPTH = 4;
  const seenRepeat = new Map(); // parentId+size -> count, to sample repeated cards
  const sameBox = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= 2);
  // child sits inside parent with only padding-sized insets on every side
  const insetWithin = ([cx, cy, cw, ch], [px, py, pw, ph], max) =>
    cx - px >= 0 && cx - px <= max &&
    cy - py >= 0 && cy - py <= max &&
    px + pw - (cx + cw) >= 0 && px + pw - (cx + cw) <= max &&
    py + ph - (cy + ch) >= 0 && py + ph - (cy + ch) <= max;

  (function walk(n, parentId, keptBox, onlyChild, ancestors) {
    if (!n.box) return;
    const [, , w, h] = n.box;
    const deep = (n.depth ?? 0) > MAX_DEPTH;
    const tiny = w < 60 || h < 24;
    const isText = n.type === "TEXT";
    // a wrapper that covers its kept ancestor exactly — or sits inside it as a
    // lone padding wrapper — becomes the same HTML element, so measuring both
    // is redundant and ambiguous to tag
    const duplicate =
      sameBox(n.box, keptBox) ||
      (keptBox && onlyChild && insetWithin(n.box, keptBox, 40));

    // sample repeated siblings of identical size (e.g. an 8-card grid) instead
    // of measuring every one: first two and last, like the session did
    let repeatOk = true;
    if (parentId) {
      const key = `${parentId}|${Math.round(w)}x${Math.round(h)}`;
      const seen = (seenRepeat.get(key) || 0) + 1;
      seenRepeat.set(key, seen);
      repeatOk = seen <= 2;
    }

    const keep = !deep && !tiny && repeatOk && !duplicate && n.depth > 0;
    if (keep) {
      out.push({
        id: n.id,
        name: n.name,
        // where this sits in the design, so a failure can say WHICH section
        section: [...ancestors, n.name].slice(-3).join(" > "),
        box: n.box,
        // a text node's rendered width is layout-driven, not design-driven
        compare: isText ? "position" : "box",
      });
    }
    const nextKept = keep ? n.box : keptBox;
    const kids = n.children || [];
    const nextAncestors = [...ancestors, n.name];
    kids.forEach((c) => walk(c, n.id, nextKept, kids.length === 1, nextAncestors));
  })(tree, null, null, false, []);

  return out;
}

/**
 * Layer names are a hint, never proof — a designer may call a carousel "Pager"
 * or a plain graphic "Slider". So this regex is only ever used to PRESERVE
 * information (don't flatten something that might be a control): being wrong
 * there costs nothing. It is never used on its own to DEMAND that the page
 * contain a control, because a wrong demand is a failure the generator can
 * never satisfy, and those block a run forever.
 */
const CONTROL_NAME =
  /slider|dots?|indicator|bullet|pagination|tabs?\b|toggle|switch|checkbox|radio|dropdown|select|accordion|stepper|rating|stars?\b/i;

/** A repeated row/column of similar small shapes — dots, stars, tabs, steps. */
function isRepeatedSet(n) {
  const kids = (n.children || []).filter((c) => c.visible !== false && c.absoluteBoundingBox);
  if (kids.length < 3) return false;
  const b = kids.map((c) => c.absoluteBoundingBox);
  const w = b[0].width, h = b[0].height;
  if (w > 64 || h > 64) return false;
  return b.every((x) => Math.abs(x.width - w) <= 6 && Math.abs(x.height - h) <= 6);
}

function isControlGroup(n) {
  if (CONTROL_NAME.test(n.name || "")) return true;
  return isRepeatedSet(n);
}

/**
 * Interactive components the design implies. Figma has no notion of "this is a
 * dropdown" — a select and a static label look identical in the node tree — so
 * the generator has to infer it, and silently not building it is invisible to
 * every geometry and pixel check. Naming these explicitly makes the intent part
 * of the contract instead of a guess.
 */
export function detectComponents(tree) {
  const out = [];
  const seen = new Set();

  (function walk(n, parent) {
    const name = n.name || "";
    const kids = (n.children || []).filter((c) => c.visible !== false);

    // text plus a small glyph parked at the right edge = a select or disclosure.
    // The shape and placement are the evidence; the name only raises confidence.
    const textSibling = kids.find((c) => c.type === "TEXT");
    const glyph = kids.find((c) => {
      if (!c.box || c === textSibling) return false;
      const [x, , w, h] = c.box;
      const small = w <= 32 && h <= 32;
      const atRightEdge = n.box && x + w >= n.box[0] + n.box[2] - 12;
      return small && atRightEdge;
    });
    const namedCaret = kids.some((c) => /chevron|caret|arrow-?down|expand/i.test(c.name || ""));
    if (textSibling && (glyph || namedCaret) && !seen.has(n.id)) {
      seen.add(n.id);
      out.push({
        id: n.id, name, box: n.box, kind: "dropdown",
        label: textSibling.text,
        confidence: glyph ? "structural" : "name",
        hint: "text plus a glyph at the right edge — build a real control (a <select>, or a button with aria-expanded + aria-haspopup and a listbox). Static markup with a chevron image is NOT acceptable.",
      });
    }

    const repeated = isRepeatedSet({
      ...n,
      children: kids.map((k) => ({ ...k, absoluteBoundingBox: k.box && { width: k.box[2], height: k.box[3] } })),
    });
    if (!seen.has(n.id) && (repeated || CONTROL_NAME.test(name))) {
      const count = kids.length;
      // A star rating is a repeated set too, but it is a READOUT, not a control.
      // Demanding clickable buttons for it would be an unfixable failure.
      const display = /rating|stars?\b|score|review/i.test(name);
      if (count >= 3) {
        seen.add(n.id);
        out.push(display
          ? {
              id: n.id, name, box: n.box, kind: "display-set", count,
              confidence: "name",
              hint: `${count} repeated shapes ("${name}") — a readout, not a control. Build the ${count} items as real elements (e.g. an inline list) with an accessible label such as aria-label="4 out of 5"; do not use one flat image, and do not make them clickable.`,
            }
          : {
              id: n.id, name, box: n.box, kind: "indicator-group", count,
              confidence: "structural",   // N equally-sized siblings, measured
              hint: `${count} repeated shapes ("${name}") — build ${count} real <button>s (one per slide/step) with aria-selected or aria-current, wired to the content they control. A single image is NOT acceptable.`,
            });
      }
    }

    kids.forEach((c) => walk(c, n));
  })(tree, null);

  // A wrapper and the set inside it both match; keep the richer one so the
  // component is not demanded (and counted) twice.
  const contains = (a, b) =>
    a.box && b.box && a.box[0] <= b.box[0] + 1 && a.box[1] <= b.box[1] + 1 &&
    a.box[0] + a.box[2] >= b.box[0] + b.box[2] - 1 &&
    a.box[1] + a.box[3] >= b.box[1] + b.box[3] - 1;

  return out.filter((c, i) =>
    !out.some((o, j) =>
      j !== i && o.kind === c.kind && contains(c, o) && (o.count || 0) > (c.count || 0)
    )
  );
}

export function normalize(rootDoc) {
  const origin = rootDoc.absoluteBoundingBox || { x: 0, y: 0 };
  const assets = { images: new Map(), vectors: new Map() }; // key -> suggested name

  function box(n) {
    const b = n.absoluteBoundingBox;
    if (!b) return undefined;
    return [r1(b.x - origin.x), r1(b.y - origin.y), r1(b.width), r1(b.height)];
  }

  function fills(n) {
    const out = [];
    for (const f of n.fills || []) {
      if (f.visible === false) continue;
      if (f.type === "SOLID") {
        out.push({ solid: rgbaToCss({ ...f.color, a: f.opacity ?? f.color.a ?? 1 }) });
      } else if (f.type?.startsWith("GRADIENT")) {
        // handles give the gradient its direction; without them every gradient
        // silently becomes top-to-bottom
        const h = f.gradientHandlePositions;
        let angle;
        if (h?.length >= 2) {
          const dx = h[1].x - h[0].x, dy = h[1].y - h[0].y;
          angle = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360) % 360);
        }
        out.push({
          gradient: f.type.replace("GRADIENT_", "").toLowerCase(),
          angleDeg: angle,
          stops: (f.gradientStops || []).map((s) => ({
            at: r1(s.position),
            color: rgbaToCss(s.color),
          })),
        });
      } else if (f.type === "IMAGE" && f.imageRef) {
        // Two very different things wear the same "image fill" hat:
        //
        //  - a LEAF image (a photo in its own frame): render the NODE, so
        //    Figma's crop/pan/zoom is baked into the file. The raw upload is
        //    uncropped and shows a different part of the photo.
        //  - a BACKGROUND on a container that has children: rendering the node
        //    would bake the nav, headings and buttons sitting on top of it into
        //    the picture. Here the raw upload is the right file, and the crop
        //    has to travel separately as CSS.
        const isBackground = (n.children || []).some((c) => c.visible !== false);
        assets.images.set(isBackground ? `fill:${f.imageRef}` : n.id, {
          name: n.name, ref: f.imageRef, isBackground,
        });
        out.push({
          image: isBackground ? `fill:${f.imageRef}` : n.id,
          role: isBackground ? "background" : "content",
          scaleMode: f.scaleMode,
          ...(isBackground ? cropToCss(f) : {}),
        });
      }
    }
    return out.length ? out : undefined;
  }

  function effects(n) {
    const out = [];
    for (const e of n.effects || []) {
      if (e.visible === false) continue;
      if (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") {
        out.push({
          type: e.type === "DROP_SHADOW" ? "shadow" : "innerShadow",
          x: e.offset?.x ?? 0, y: e.offset?.y ?? 0,
          blur: e.radius ?? 0, spread: e.spread ?? 0,
          color: rgbaToCss(e.color || { r: 0, g: 0, b: 0, a: 0.25 }),
        });
      } else if (e.type === "BACKGROUND_BLUR") {
        out.push({ type: "backdropBlur", blur: e.radius ?? 0 });
      } else if (e.type === "LAYER_BLUR") {
        out.push({ type: "blur", blur: e.radius ?? 0 });
      }
    }
    return out.length ? out : undefined;
  }

  function subtreeHasImageFill(n) {
    if (n.visible === false) return false;
    if ((n.fills || []).some((f) => f.visible !== false && f.type === "IMAGE")) return true;
    return (n.children || []).some(subtreeHasImageFill);
  }

  function isVectorArt(n) {
    // A node whose visible content is entirely vector shapes -> export as one SVG.
    // Anything containing an image fill stays structural: flattening it would bake
    // photos into a giant base64-embedding SVG.
    if (subtreeHasImageFill(n)) return false;
    // Controls are made of simple shapes too — carousel dots, star ratings, tab
    // bars, checkboxes. Flattening one into a single <img> silently deletes an
    // interactive component: there is nothing left for the generator to wire up.
    if (isControlGroup(n)) return false;
    if (PURE_VECTOR.has(n.type)) return true;
    if (!n.children?.length) return false;
    if (!["GROUP", "FRAME", "INSTANCE", "COMPONENT"].includes(n.type)) return false;
    const kids = n.children.filter((c) => c.visible !== false);
    return kids.length > 0 && kids.every(
      (c) => VECTOR_TYPES.has(c.type) || isVectorArt(c)
    );
  }

  function walk(n, depth) {
    if (n.visible === false) return undefined;

    const node = { id: n.id, name: n.name, type: n.type, box: box(n), depth };

    if (n.type === "TEXT") {
      const s = n.style || {};
      node.text = n.characters ?? "";
      node.font = {
        family: s.fontFamily,
        weight: s.fontWeight,
        size: s.fontSize,
        lineHeight: s.lineHeightPx ? r1(s.lineHeightPx) : undefined,
        letterSpacing: s.letterSpacing ? r1(s.letterSpacing) : undefined,
        align: s.textAlignHorizontal?.toLowerCase(),
        case: s.textCase && s.textCase !== "ORIGINAL" ? s.textCase.toLowerCase() : undefined,
      };
      node.fills = fills(n);
      return node;
    }

    // Vector art (icons, logos, decorative shapes) becomes ONE exported svg asset;
    // don't recurse into it. Skip plain RECTANGLE/ELLIPSE without image fills —
    // those are reproducible in CSS and stay as structural nodes.
    if (depth > 0 && isVectorArt(n) && !["RECTANGLE", "ELLIPSE"].includes(n.type)) {
      assets.vectors.set(n.id, n.name);
      node.asset = n.id;
      node.fills = fills(n);
      return node;
    }

    node.fills = fills(n);
    node.effects = effects(n);
    if (n.opacity != null && n.opacity < 1) node.opacity = r1(n.opacity);

    const radii = n.rectangleCornerRadii;
    if (radii && radii.some((v) => v > 0)) node.radius = radii;
    else if (n.cornerRadius > 0) node.radius = n.cornerRadius;

    if (n.strokes?.length && n.strokeWeight) {
      const st = n.strokes.find((s) => s.visible !== false && s.type === "SOLID");
      if (st) node.border = { width: n.strokeWeight, color: rgbaToCss(st.color) };
    }

    if (n.layoutMode && n.layoutMode !== "NONE") {
      node.layout = {
        dir: n.layoutMode === "HORIZONTAL" ? "row" : "column",
        gap: n.itemSpacing || 0,
        padding: [n.paddingTop || 0, n.paddingRight || 0, n.paddingBottom || 0, n.paddingLeft || 0],
        mainAlign: n.primaryAxisAlignItems?.toLowerCase(),
        crossAlign: n.counterAxisAlignItems?.toLowerCase(),
        wrap: n.layoutWrap === "WRAP" || undefined,
      };
    }

    // How the designer intended this box to RESIZE. Without it every width
    // becomes a hardcoded pixel value and the layout cannot breathe:
    //   FILL  -> stretch with the parent (width:100% / flex:1)
    //   HUG   -> shrink to content (fit-content / auto)
    //   FIXED -> a real pixel size
    const sizing = [n.layoutSizingHorizontal, n.layoutSizingVertical]
      .map((s) => (s ? s.toLowerCase() : null));
    if (sizing[0] || sizing[1]) node.sizing = { w: sizing[0], h: sizing[1] };
    if (n.layoutGrow) node.grow = n.layoutGrow;
    // constraints say what happens when the PARENT resizes — the closest thing
    // the design gives us to responsive intent
    if (n.constraints && (n.constraints.horizontal !== "LEFT" || n.constraints.vertical !== "TOP"))
      node.pin = `${n.constraints.horizontal}/${n.constraints.vertical}`.toLowerCase();
    if (n.strokeAlign && n.strokes?.length) node.strokeAlign = n.strokeAlign.toLowerCase();

    if (n.clipsContent) node.clips = true;

    if (n.children?.length) {
      node.children = n.children.map((c) => walk(c, depth + 1)).filter(Boolean);

      // What the arrangement IS, not which tool built it. Without this the
      // generator mirrors the designer's habits and a hand-positioned page
      // becomes a wall of position:absolute.
      const flow = inferFlow(node);
      if (flow && flow.dir !== "freeform") node.flow = flow;
    }

    // A band whose fill covers the full canvas width is a section background:
    // on the web it must span the viewport, not stop at the design's 1440px,
    // or wide screens get bars down both sides.
    const stageW = rootDoc.absoluteBoundingBox?.width || 0;
    if (node.box && node.fills?.length && stageW &&
        node.box[2] >= stageW * 0.95 && node.box[3] > 80 && depth > 0)
      node.fullBleed = true;

    return node;
  }

  const tree = walk(rootDoc, 0);

  // fonts the design actually uses, so the render can be checked for them
  const fonts = new Map();
  (function collectFonts(n) {
    if (n.font?.family) {
      const set = fonts.get(n.font.family) || new Set();
      set.add(n.font.weight || 400);
      fonts.set(n.font.family, set);
    }
    (n.children || []).forEach(collectFonts);
  })(tree);

  return {
    tree,
    anchors: selectAnchors(tree),
    components: detectComponents(tree),
    fonts: [...fonts].map(([family, weights]) => ({ family, weights: [...weights].sort() })),
    stage: { width: tree.box?.[2] ?? 1440, height: tree.box?.[3] ?? 0 },
    assets: {
      images: [...assets.images].map(([key, v]) => ({
        key, nodeId: v.isBackground ? null : key, ref: v.ref,
        name: v.name, isBackground: v.isBackground,
      })),
      vectors: [...assets.vectors].map(([id, name]) => ({ id, name })),
    },
  };
}
