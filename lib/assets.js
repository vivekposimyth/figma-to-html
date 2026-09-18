import fs from "node:fs";
import path from "node:path";
import { fetchImageFills, renderNodes } from "./figma.js";

function slugify(name, ext, taken) {
  let base =
    name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) ||
    "asset";
  let file = `${base}.${ext}`;
  let i = 2;
  while (taken.has(file)) file = `${base}-${i++}.${ext}`;
  taken.add(file);
  return file;
}

/**
 * Figma exports plenty of "vectors" that are not artwork at all: divider lines,
 * plain rounded rectangles used as masks, and the frosted-glass card shells that
 * are really a gradient plus a backdrop blur. Those belong in CSS on the real
 * element — using them as <img> produces a stretched, unstyleable layer.
 * Genuine icon paths (arrows, checkmarks, logos) are left alone.
 */
function cssShapeKind(svg) {
  const paths = (svg.match(/<path/g) || []).length;
  const hasBlur = /backdrop-filter|data-figma-bg-blur-radius/.test(svg);
  const hasGradient = /<(linear|radial)Gradient/.test(svg);
  const shapesOnly = paths === 0 && /<(rect|line|circle|ellipse)/.test(svg);

  if (hasBlur) return "frosted-glass shell (gradient + backdrop blur)";
  if (shapesOnly && /<line/.test(svg)) return "plain line — use a border or a 1px block";
  if (shapesOnly) return "plain rect/ellipse — use background + border-radius";
  if (hasGradient && paths <= 1) return "gradient panel — use a CSS gradient background";
  return null;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`zero-byte download: ${dest}`);
  fs.writeFileSync(dest, buf);
  return buf.length;
}

/**
 * Download every asset the normalizer flagged, with semantic names.
 * Figma asset URLs expire, so bytes are always committed locally.
 * Returns manifest: [{ file, kind, ref?, nodeId?, name, bytes }]
 */
export async function downloadAssets(cfg, fileKey, design, assetsDir) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const taken = new Set();
  const manifest = [];
  const failures = [];

  // 1. images. A leaf photo is exported as a NODE render so Figma's crop is
  // baked in; a container's background fill must come from the raw upload,
  // because rendering that node would bake its own children into the picture.
  if (design.assets.images.length) {
    const leafIds = design.assets.images.filter((i) => i.nodeId).map((i) => i.nodeId);
    const urls = leafIds.length
      ? await renderNodes(cfg.figmaToken, fileKey, leafIds, "png", 2)
      : {};
    const needFills = design.assets.images.some((i) => i.isBackground || !urls[i.nodeId]);
    const fills = needFills
      ? await fetchImageFills(cfg.figmaToken, fileKey).catch(() => ({}))
      : {};

    for (const img of design.assets.images) {
      const url = img.isBackground ? fills[img.ref] : (urls[img.nodeId] || fills[img.ref]);
      if (!url) { failures.push(`no image URL for ${img.name} (${img.key})`); continue; }
      const file = slugify(img.name, "png", taken);
      try {
        const bytes = await download(url, path.join(assetsDir, file));
        manifest.push({
          file, kind: img.isBackground ? "background-image" : "image",
          key: img.key, name: img.name, bytes,
        });
      } catch (e) { failures.push(`${file}: ${e.message}`); }
    }
  }

  // 2. vector art (icons/logos/shapes) -> rendered svg by node id
  if (design.assets.vectors.length) {
    const ids = design.assets.vectors.map((v) => v.id);
    const urls = await renderNodes(cfg.figmaToken, fileKey, ids, "svg");
    for (const { id, name } of design.assets.vectors) {
      const url = urls[id];
      if (!url) { failures.push(`Figma could not render svg for ${name} (${id})`); continue; }
      const file = slugify(name, "svg", taken);
      try {
        const dest = path.join(assetsDir, file);
        const bytes = await download(url, dest);
        const entry = { file, kind: "vector", nodeId: id, name, bytes };
        // A small exported "vector" is often not artwork at all but a plain
        // rounded rect, a gradient panel or a blur shell — things that belong in
        // CSS, not an <img>. Read it so the generator can tell the difference.
        if (bytes < 6000) {
          const svg = fs.readFileSync(dest, "utf8");
          const kind = cssShapeKind(svg);
          if (kind) {
            entry.cssShape = kind;
            entry.source = svg.replace(/\s+/g, " ").trim().slice(0, 700);
          }
        }
        manifest.push(entry);
      } catch (e) { failures.push(`${file}: ${e.message}`); }
    }
  }

  return { manifest, failures };
}

/**
 * Render each top-level section of the frame on its own. A full-page render of
 * a 3500px design has to be scaled to ~1/2 before a model can take it, which is
 * exactly when the details that matter — icon shapes, small text, borders —
 * stop being legible. Per-section images stay close to native size.
 */
export async function sectionScreenshots(cfg, fileKey, design, refsDir, max = 6) {
  const sections = (design.tree.children || [])
    .filter((n) => n.box && n.box[3] > 120)
    .slice(0, max);
  if (!sections.length) return [];

  // These ride along in a prompt as base64 (+33%), so size is a latency budget,
  // not a detail budget. PNG is out — a photo-heavy section costs megabytes.
  // ~1000px wide is past what a vision model tiles at anyway, and the design
  // tree (not the picture) is where exact numbers come from; the images only
  // have to convey what the section LOOKS like.
  const TARGET_W = 1000;
  const PER_IMAGE_MAX = 700 * 1024;
  const TOTAL_MAX = 2.5 * 1024 * 1024;

  const scale = Math.min(1, TARGET_W / (design.stage.width || TARGET_W));
  const urls = await renderNodes(cfg.figmaToken, fileKey, sections.map((s) => s.id), "jpg", scale);
  const out = [];
  let total = 0;
  for (const [i, s] of sections.entries()) {
    const url = urls[s.id];
    if (!url) continue;
    const file = path.join(refsDir, `section-${i + 1}-${slugify(s.name, "jpg", new Set())}`);
    try {
      const bytes = await download(url, file);
      // skip an outsized section rather than break, so one heavy hero does not
      // starve every section after it
      if (bytes > PER_IMAGE_MAX || total + bytes > TOTAL_MAX) { fs.unlinkSync(file); continue; }
      total += bytes;
      out.push({ file, name: s.name, box: s.box, bytes });
    } catch { /* a section image is a nice-to-have, never fatal */ }
  }
  return out;
}

/** Full-frame reference screenshot (scaled to keep max dimension sane). */
export async function frameScreenshot(cfg, fileKey, nodeId, stage, dest) {
  const maxDim = Math.max(stage.width || 1, stage.height || 1);
  const scale = Math.min(1, 2000 / maxDim);
  const urls = await renderNodes(cfg.figmaToken, fileKey, [nodeId], "png", scale);
  if (!urls[nodeId]) return null;
  await download(urls[nodeId], dest);
  return dest;
}
