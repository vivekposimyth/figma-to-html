import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { runDeclared, findDeadControls } from "./interactions.js";
import { checkResponsiveQuality } from "./responsive.js";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function startServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split("?")[0]);
      if (rel === "/") rel = "/index.html";
      const file = path.join(rootDir, path.normalize(rel).replace(/^[/\\]+/, ""));
      if (!file.startsWith(rootDir)) { res.writeHead(403); res.end(); return; }
      fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); res.end("Not found"); return; }
        res.writeHead(200, {
          "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
        });
        res.end(buf);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` })
    );
  });
}

/**
 * Compare the rendered page against the Figma frame render, pixel by pixel, in
 * horizontal bands — so a failure says WHERE the page stops looking like the
 * design, not just that it does. Both images are scaled to a common width and
 * compared over their overlapping height. Runs in the page via canvas, so no
 * image library is needed.
 */
async function checkVisualDiff(page, serverUrl, figmaRel, renderRel, designH) {
  return page.evaluate(async ({ a, b, designH }) => {
    const load = (src) => new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("load failed: " + src));
      im.src = src;
    });
    let figma, render;
    try { [figma, render] = await Promise.all([load(a), load(b)]); }
    catch (e) { return { skipped: e.message }; }

    const W = 480;                       // compare at a modest width: layout, not hinting
    const H = Math.round((figma.height / figma.width) * W);
    if (!H) return { skipped: "zero height" };

    // Both images are normalised into the SAME box. A page a few percent taller
    // than the design would otherwise shift every band and drown the real
    // differences in noise; the height gap is reported separately instead.
    const draw = (im) => {
      const c = document.createElement("canvas");
      c.width = W; c.height = H;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(im, 0, 0, W, H);
      return x.getImageData(0, 0, W, H).data;
    };
    const dF = draw(figma), dR = draw(render);

    const pageH = document.documentElement.scrollHeight;
    const BANDS = 12;
    const bandH = Math.max(1, Math.floor(H / BANDS));
    const bands = [];
    let diffTotal = 0, nTotal = 0;
    for (let bi = 0; bi < BANDS; bi++) {
      let diff = 0, n = 0;
      for (let y = bi * bandH; y < Math.min((bi + 1) * bandH, H); y++) {
        for (let x = 0; x < W; x += 2) {        // every 2nd pixel is plenty
          const i = (y * W + x) * 4;
          const d =
            Math.abs(dF[i] - dR[i]) + Math.abs(dF[i + 1] - dR[i + 1]) + Math.abs(dF[i + 2] - dR[i + 2]);
          if (d > 90) diff++;                   // ignore antialiasing / minor tone shifts
          n++;
        }
      }
      if (!n) continue;
      diffTotal += diff; nTotal += n;
      // Average colour of each band in both images: a model with no image input
      // can still act on "the design here is orange, your page is white".
      const avg = (data) => {
        let r = 0, g = 0, b = 0, c = 0;
        for (let y = bi * bandH; y < Math.min((bi + 1) * bandH, H); y += 2)
          for (let x = 0; x < W; x += 4) {
            const i = (y * W + x) * 4;
            r += data[i]; g += data[i + 1]; b += data[i + 2]; c++;
          }
        if (!c) return null;
        const hex = (v) => Math.round(v / c).toString(16).padStart(2, "0");
        return `#${hex(r)}${hex(g)}${hex(b)}`;
      };
      bands.push({
        band: bi + 1,
        designY: [Math.round((bi * bandH / H) * designH), Math.round(((bi + 1) * bandH / H) * designH)],
        diffPct: Math.round((diff / n) * 1000) / 10,
        designAvgColor: avg(dF),
        renderAvgColor: avg(dR),
      });
    }
    const heightDiffPct = designH ? Math.round(((pageH - designH) / designH) * 100) : null;
    const worstBands = bands.sort((x, y) => y.diffPct - x.diffPct).slice(0, 4);

    // Crop the worst bands out of BOTH source images at native resolution and
    // put them side by side (design | render). A full-page screenshot of a
    // 4000px page is unreadable once a model downscales it; these crops show
    // the actual difference at a legible size.
    const crops = [];
    for (const b of worstBands.slice(0, 3)) {
      if (b.diffPct < 6) continue;
      const bi = b.band - 1;
      const CW = 560, GAP = 16;
      const cut = (im) => ({
        sy: (bi / BANDS) * im.height,
        sh: im.height / BANDS,
      });
      const cF = cut(figma), cR = cut(render);
      const hOut = Math.max(
        60,
        Math.round(Math.min(360, (cF.sh / figma.width) * CW))
      );
      const c = document.createElement("canvas");
      c.width = CW * 2 + GAP; c.height = hOut + 22;
      const x = c.getContext("2d");
      x.fillStyle = "#111"; x.fillRect(0, 0, c.width, c.height);
      x.drawImage(figma, 0, cF.sy, figma.width, cF.sh, 0, 22, CW, hOut);
      x.drawImage(render, 0, cR.sy, render.width, cR.sh, CW + GAP, 22, CW, hOut);
      x.fillStyle = "#fff"; x.font = "13px monospace";
      x.fillText(`FIGMA  y ${b.designY[0]}-${b.designY[1]}`, 4, 15);
      x.fillText(`YOUR RENDER  (${b.diffPct}% different)`, CW + GAP + 4, 15);
      crops.push({ band: b.band, designY: b.designY, dataUrl: c.toDataURL("image/png") });
    }

    return {
      overallDiffPct: Math.round((diffTotal / nTotal) * 1000) / 10,
      pageHeight: pageH,
      designHeight: designH,
      heightDiffPct,
      // bands only line up when the page is roughly as tall as the design
      bandsReliable: heightDiffPct === null || Math.abs(heightDiffPct) <= 12,
      worstBands,
      crops,
    };
  }, { a: serverUrl + figmaRel, b: serverUrl + renderRel, designH });
}

/**
 * Drive every interactive pattern the generated page declares and assert that
 * it actually does something — the reference session found two real carousel
 * bugs exactly this way. Each check only runs when its pattern is present, so
 * a page without a carousel is never penalised for not having one.
 */
async function checkInteractions(page) {
  await page.evaluate(() => window.scrollTo(0, 0));
  return page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const fails = [];
    const label = (e) =>
      e.tagName.toLowerCase() + (e.className ? "." + String(e.className).trim().split(/\s+/)[0] : "");

    // 1. aria-expanded controls (nav toggle, accordions, dropdowns)
    for (const btn of [...document.querySelectorAll("[aria-expanded]")].slice(0, 6)) {
      const before = btn.getAttribute("aria-expanded");
      btn.click(); await wait(150);
      const after = btn.getAttribute("aria-expanded");
      if (before === after)
        fails.push({ what: "aria-expanded control does not toggle", el: label(btn), state: before });
      else { btn.click(); await wait(150); } // restore
    }

    // 2. aria-pressed / role=tab groups — exactly one active after a click
    const groups = new Map();
    for (const el of document.querySelectorAll("[aria-pressed], [role='tab']")) {
      const key = el.parentElement;
      if (!key) continue;
      groups.set(key, [...(groups.get(key) || []), el]);
    }
    for (const [parent, items] of [...groups].slice(0, 4)) {
      if (items.length < 2) continue;
      const target = items[items.length - 1];
      target.click(); await wait(150);
      const attr = target.hasAttribute("aria-pressed") ? "aria-pressed" : "aria-selected";
      const on = items.filter((i) => i.getAttribute(attr) === "true");
      if (on.length !== 1 || on[0] !== target)
        fails.push({
          what: `clicking one item in a ${attr} group must leave exactly that one active`,
          el: label(parent), active: on.length, expected: 1,
        });
    }

    // 3. carousel / slider indicators — different dots must move the track
    for (const box of [...document.querySelectorAll("*")].filter((e) =>
      /dot|bullet|indicator|slider-nav|carousel__nav|pagination/i.test(String(e.className))
    ).slice(0, 3)) {
      const dots = [...box.querySelectorAll("button, [role='button']")];
      if (dots.length < 2) continue;
      const track =
        document.querySelector("[class*='track'], [class*='slides'], [class*='carousel'] > ul, [class*='carousel'] > div") ||
        box.closest("[class*='carousel'], [class*='slider']")?.querySelector("ul, div");
      const state = () => {
        if (!track) return null;
        const cs = getComputedStyle(track);
        return `${cs.transform}|${track.scrollLeft}`;
      };
      const first = (dots[0].click(), await wait(500), state());
      const last = (dots[dots.length - 1].click(), await wait(500), state());
      if (track && first === last)
        fails.push({
          what: "carousel indicators do not move the track (first and last dot produce identical transform/scroll)",
          el: label(box), dots: dots.length, state: first,
        });
    }

    // 4. forms must handle their own submit (no page navigation) and validate
    for (const form of [...document.querySelectorAll("form")].slice(0, 3)) {
      const email = form.querySelector("input[type='email'], input[name*='mail' i]");
      const textBefore = form.textContent;
      let navigated = false;
      const onSubmit = (e) => { if (!e.defaultPrevented) navigated = true; };
      form.addEventListener("submit", onSubmit);
      if (email) email.value = "not-an-email";
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      await wait(200);
      form.removeEventListener("submit", onSubmit);
      if (navigated)
        fails.push({ what: "form submit is not handled (would reload the page) — preventDefault and show feedback", el: label(form) });
      else if (email && form.textContent === textBefore && email.getAttribute("aria-invalid") !== "true")
        fails.push({ what: "invalid email submit produced no visible feedback and no aria-invalid", el: label(form) });
    }

    // 5. sticky/scrolled header state
    const header = document.querySelector("header, [class*='header']");
    if (header) {
      const before = header.className;
      window.scrollTo(0, 600); await wait(300);
      const after = header.className;
      window.scrollTo(0, 0); await wait(300);
      const restored = header.className;
      if (before !== after && after === restored)
        fails.push({ what: "header gains a scrolled state but never loses it when scrolled back to top", el: label(header) });
    }

    return fails;
  });
}

/**
 * Elements that drifted together almost always share one cause — a single
 * spacing property above them. Reporting 12 separate failures invites 12
 * separate patches that fight each other; reporting the cluster invites the
 * one fix that is actually needed.
 */
function groupGeometry(fails) {
  const clusters = new Map();
  const singles = [];

  for (const f of fails) {
    const [dx, dy] = f.delta;
    // same section + same vertical drift (to the nearest 2px) = same cause
    const key = `${f.section}|${Math.round(dy / 2) * 2}`;
    if (Math.abs(dy) > Math.abs(dx)) {
      clusters.set(key, [...(clusters.get(key) || []), f]);
    } else singles.push(f);
  }

  const out = [];
  for (const [, group] of clusters) {
    if (group.length < 3) { singles.push(...group); continue; }
    const dy = group[0].delta[1];
    out.push({
      sharedCause: `${group.length} elements in "${group[0].section}" are all ${Math.abs(dy)}px too ${dy > 0 ? "LOW" : "HIGH"} — almost certainly ONE spacing property above them, not ${group.length} separate fixes`,
      fix: `find the margin/padding that creates that gap and ${dy > 0 ? "SUBTRACT" : "ADD"} ${Math.abs(dy)}px`,
      elements: group.slice(0, 4).map((f) => ({ el: f.el, name: f.name, delta: f.delta })),
      parentOfFirst: group[0].parent,
      cssRulesOfFirst: group[0].cssRules,
    });
  }
  singles.sort((a, b) => Math.max(...b.delta.map(Math.abs)) - Math.max(...a.delta.map(Math.abs)));
  out.push(...singles.slice(0, 12));
  return out;
}

/**
 * Anchors to compare: the design's structural landmarks (see selectAnchors).
 * Falls back to every boxed node for designs normalized before anchors existed.
 */
export function collectBoxes(design) {
  const tree = design.tree || design;
  if (design.anchors?.length) {
    return Object.fromEntries(
      design.anchors.map((a) => [a.id, { box: a.box, compare: a.compare, name: a.name }])
    );
  }
  const map = {};
  (function walk(n) {
    if (n.box) map[n.id] = { box: n.box, compare: "box", name: n.name };
    (n.children || []).forEach(walk);
  })(tree);
  return map;
}

/**
 * Load the generated page in a real browser and run the reference-session checks:
 * console/page errors, broken images, [data-fig] geometry vs design boxes at
 * stage width, horizontal overflow (with offender hunt) at stage/768/375.
 * Returns { pass, failures, stats, screenshotPath }.
 */
/**
 * `changed` (optional) is the set of files a fix round actually touched. Checks
 * that cannot possibly have changed are skipped and their previous result is
 * carried over — replaying 12 declared interactions and clicking 40 controls
 * after a round that only edited style.css is pure waiting.
 */
export async function validate(cfg, { outDir, design, refsDir, round, figmaShotPath, changed, previous }) {
  const touchesBehaviour = !changed || changed.has("script.js") ||
    changed.has("index.html") || changed.has("interactions.json");
  const boxes = collectBoxes(design);
  const stageW = Math.round(design.stage.width);
  const { server, url } = await startServer(outDir);
  const browser = await chromium.launch();

  const failures = {};
  const stats = { measured: 0, maxDelta: 0 };
  let screenshotPath = null;
  const comparisonShots = [];
  let mobileShotPath = null;

  try {
    const consoleErrors = [];
    const pageErrors = [];
    const context = await browser.newContext({
      viewport: { width: stageW, height: 950 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

    const neutralize = async (p) => {
      await p.addStyleTag({
        content: "*{animation:none!important;transition:none!important;scroll-behavior:auto!important}",
      });
      await p.evaluate(() =>
        document.querySelectorAll("[class*='reveal'],[class*='fade'],[class*='animate']")
          .forEach((e) => { e.style.opacity = "1"; e.style.transform = "none"; })
      );
      await p.waitForTimeout(400);
    };

    // ---- stage-width pass: errors, images, fonts, geometry ----
    await page.goto(url, { waitUntil: "networkidle" });
    await neutralize(page);

    const brokenImages = await page.evaluate(() =>
      [...document.images]
        .filter((i) => !i.complete || i.naturalWidth === 0)
        .map((i) => i.getAttribute("src"))
    );

    const geo = await page.evaluate(() => {
      // The CSS rules that actually target an element — so a failure can name
      // the rule to patch instead of making the model hunt for it.
      const rulesFor = (el) => {
        const out = [];
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          for (const r of rules) {
            try {
              if (r.type === 1 && el.matches(r.selectorText)) {
                out.push(`${r.selectorText} { ${r.style.cssText} }`);
              } else if (r.type === 4) {
                for (const mr of r.cssRules)
                  if (mr.type === 1 && el.matches(mr.selectorText))
                    out.push(`@media ${r.conditionText} { ${mr.selectorText} { ${mr.style.cssText} } }`);
              }
            } catch { /* invalid selector for matches() */ }
          }
        }
        return out.slice(-4); // the last ones win the cascade
      };

      return [...document.querySelectorAll("[data-fig]")].map((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        const parent = e.parentElement;
        return {
          id: e.getAttribute("data-fig"),
          tag: e.tagName.toLowerCase() + (e.className ? "." + String(e.className).split(" ")[0] : ""),
          rect: [r.left + window.scrollX, r.top + window.scrollY, r.width, r.height],
          // everything needed to reason about WHY it sits where it sits
          box: {
            position: cs.position,
            display: cs.display,
            margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
            padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
            offsets: cs.position !== "static" ? `top:${cs.top} left:${cs.left}` : null,
          },
          parent: parent && parent !== document.body
            ? {
                tag: parent.tagName.toLowerCase() + (parent.className ? "." + String(parent.className).split(" ")[0] : ""),
                display: getComputedStyle(parent).display,
                paddingTop: getComputedStyle(parent).paddingTop,
                gap: getComputedStyle(parent).gap,
              }
            : null,
          rules: rulesFor(e),
        };
      });
    });
    const innerW = await page.evaluate(() => window.innerWidth);
    const off = (stageW - innerW) / 2; // centering correction if viewport clamps

    const geoFails = [];
    for (const g of geo) {
      const anchor = boxes[g.id];
      if (!anchor) continue;
      const { box, compare } = anchor;
      stats.measured++;
      const delta = [
        g.rect[0] + off - box[0], g.rect[1] - box[1],
        g.rect[2] - box[2], g.rect[3] - box[3],
      ].map((v) => Math.round(v * 10) / 10);
      // text nodes: only position is design-driven, size follows the layout
      const judged = compare === "position" ? delta.slice(0, 2) : delta;
      const worst = Math.max(...judged.map(Math.abs));
      stats.maxDelta = Math.max(stats.maxDelta, worst);
      if (worst > cfg.geoTolerance)
        geoFails.push({
          id: g.id, el: g.tag, name: anchor.name, section: anchor.section,
          design: box, delta, checked: compare === "position" ? "x,y only" : "x,y,w,h",
          computed: g.box, parent: g.parent, cssRules: g.rules,
        });
    }
    // report worst offenders first, capped so the fix prompt stays digestible
    geoFails.sort((a, b) => Math.max(...b.delta.map(Math.abs)) - Math.max(...a.delta.map(Math.abs)));
    if (geoFails.length) {
      failures.geometry = groupGeometry(geoFails);
    }
    if (stats.measured < 5) failures.missingDataFig = `only ${stats.measured} [data-fig] elements matched design nodes — add data-fig attributes`;

    // ---- fonts the design uses must actually be loaded ----
    if (design.fonts?.length) {
      const missing = await page.evaluate(async (fonts) => {
        await document.fonts.ready;
        // document.fonts.check() reports true for unavailable families (the
        // fallback counts as "available"), so measure instead: render a string
        // in <family>, monospace and in monospace alone — identical widths mean
        // the family never loaded and the fallback is being used.
        const probe = (css) => {
          const s = document.createElement("span");
          s.textContent = "AWMwmil1080 quick brown fox";
          s.style.cssText = `position:absolute;left:-9999px;top:0;white-space:nowrap;font-size:72px;${css}`;
          document.body.appendChild(s);
          const w = s.getBoundingClientRect().width;
          s.remove();
          return w;
        };
        const bad = [];
        for (const f of fonts) {
          for (const w of f.weights) {
            // browsers fetch a weight only when something uses it, so ask for it
            // explicitly before measuring (a no-op when no @font-face matches)
            try { await document.fonts.load(`${w} 72px "${f.family}"`); } catch {}
            const base = probe(`font-weight:${w};font-family:monospace`);
            const test = probe(`font-weight:${w};font-family:"${f.family}",monospace`);
            if (Math.abs(base - test) < 0.5) bad.push(`${f.family} ${w}`);
          }
        }
        return bad;
      }, design.fonts.slice(0, 6));
      if (missing.length)
        failures.fontsNotLoaded = {
          missing,
          hint: "the design uses these families/weights but the browser could not resolve them — add the right @font-face or Google Fonts <link> and use the family name in font-family",
        };
    }

    screenshotPath = path.join(refsDir, `render-round${round}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    // ---- elements silently cut off by a clipping ancestor ----
    // Designs constantly place things that overhang their container: an avatar
    // straddling a card's top edge, a badge on a button, a tag over an image.
    // The moment an ancestor clips (often from `overflow-x:auto`, which forces
    // the other axis to stop being visible), that part is just gone — and it is
    // invisible to geometry, because clipping does not change an element's rect.
    const clipped = await page.evaluate(() => {
      const out = [];
      const label = (e) =>
        e.tagName.toLowerCase() + (e.className ? "." + String(e.className).trim().split(/\s+/)[0] : "");
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        let p = el.parentElement;
        while (p && p !== document.body) {
          const cs = getComputedStyle(p);
          const clipsX = cs.overflowX !== "visible";
          const clipsY = cs.overflowY !== "visible";
          if (clipsX || clipsY) {
            const pr = p.getBoundingClientRect();
            // content beyond a genuinely scrollable axis is reachable; content
            // beyond a non-scrollable clipped axis is lost
            const scrollsX = p.scrollWidth > p.clientWidth + 1;
            const scrollsY = p.scrollHeight > p.clientHeight + 1;
            const lostTop = clipsY && !scrollsY && pr.top - r.top > 4;
            const lostBottom = clipsY && !scrollsY && r.bottom - pr.bottom > 4;
            const lostLeft = clipsX && !scrollsX && pr.left - r.left > 4;
            const lostRight = clipsX && !scrollsX && r.right - pr.right > 4;
            if (lostTop || lostBottom || lostLeft || lostRight) {
              out.push({
                el: label(el),
                clippedBy: label(p),
                lost: [
                  lostTop && `${Math.round(pr.top - r.top)}px off the top`,
                  lostBottom && `${Math.round(r.bottom - pr.bottom)}px off the bottom`,
                  lostLeft && `${Math.round(pr.left - r.left)}px off the left`,
                  lostRight && `${Math.round(r.right - pr.right)}px off the right`,
                ].filter(Boolean).join(", "),
                ancestorOverflow: `${cs.overflowX}/${cs.overflowY}`,
              });
              break;
            }
          }
          p = p.parentElement;
        }
        if (out.length >= 12) break;
      }
      return out;
    });
    if (clipped.length)
      failures.clippedElements = {
        elements: clipped,
        hint: "these elements are cut off by a clipping ancestor and the hidden part is simply not rendered. Usually the ancestor has overflow:hidden for a border-radius, or overflow-x:auto for a carousel (which forces the vertical axis to clip too). Give the scroll container padding on that axis and pull the row back with an equal negative margin, or move the overhanging element out of the clipped container.",
      };

    // ---- does it still LOOK like the design? ----
    if (figmaShotPath && fs.existsSync(figmaShotPath)) {
      const visual = await checkVisualDiff(
        page, url,
        `refs/${path.basename(figmaShotPath)}`,
        `refs/${path.basename(screenshotPath)}`,
        Math.round(design.stage.height)
      );
      stats.visualDiffPct = visual.overallDiffPct ?? null;

      // save the side-by-side crops as real files so they can be attached to
      // the fix prompt (and eyeballed later)
      for (const c of visual.crops || []) {
        const file = path.join(refsDir, `diff-round${round}-band${c.band}.png`);
        fs.writeFileSync(file, Buffer.from(c.dataUrl.split(",")[1], "base64"));
        comparisonShots.push(file);
      }
      delete visual.crops;

      // A page-wide average hides a single ruined section: eleven good bands
      // drag a 67%-wrong hero down to a passing 15%. Gate on the worst band too.
      const tol = cfg.visualTolerance ?? 18;
      const worst = visual.worstBands?.[0]?.diffPct ?? 0;
      const localised = worst > tol * 2.5 && visual.bandsReliable;
      if (localised)
        visual.localisedProblem =
          `band ${visual.worstBands[0].band} (design y ${visual.worstBands[0].designY.join("-")}) is ${worst}% different while the page averages ${visual.overallDiffPct}% — one region is wrong, not the whole page. Fix that region.`;
      if (!visual.skipped && (visual.overallDiffPct > tol || localised))
        failures.visual = {
          ...visual,
          hint: visual.bandsReliable
            ? "bands are horizontal slices of the page; designY is the design-coordinate range each covers. Look at the worst bands — usually a wrong background, a missing/misplaced image, wrong colors, or a section that drifted."
            : `the page is ${visual.heightDiffPct}% ${visual.heightDiffPct > 0 ? "taller" : "shorter"} than the design, so every band is shifted and the per-band numbers are unreliable. FIX THE TOTAL HEIGHT FIRST (section paddings / element heights); the visual comparison becomes meaningful once the page is within ~12% of ${visual.designHeight}px.`,
        };
    }

    // ---- interactions must actually work ----
    // (a) generic patterns, (b) the model's own declared contract, (c) controls
    // that do nothing at all. Together these cover behaviours no fixed rule
    // could anticipate.
    const interaction = touchesBehaviour
      ? await checkInteractions(page)
      : (previous?.failures?.interactions || []);
    if (interaction.length) failures.interactions = interaction;
    if (!touchesBehaviour && previous?.failures?.declaredInteractions)
      failures.declaredInteractions = previous.failures.declaredInteractions;

    let spec = null;
    const specPath = touchesBehaviour ? path.join(outDir, "interactions.json") : null;
    if (specPath && fs.existsSync(specPath)) {
      try { spec = JSON.parse(fs.readFileSync(specPath, "utf8")); }
      catch (e) { failures.interactionsSpecInvalid = `interactions.json is not valid JSON: ${e.message}`; }
    }
    if (spec) {
      const declared = await runDeclared(page, spec, url, stageW);
      stats.declaredTests = spec.interactions?.length || 0;
      if (declared.length) failures.declaredInteractions = declared;
    }

    // (d) the design's interactive components must exist as real controls.
    // Nothing else catches a carousel that was rendered as one flat image:
    // it measures right, it looks right, and there is simply nothing to click.
    if (design.components?.some((c) => c.confidence === "structural")) {
      // Only components whose evidence is structural (measured repetition, a
      // glyph at the edge) are DEMANDED. Ones recognised only by layer name are
      // passed to the generator as hints but never failed on — a wrong demand
      // is a failure nothing can satisfy, and those stall a run forever.
      const demanded = design.components.filter((c) => c.confidence === "structural");
      const missing = await page.evaluate((comps) => {
        const out = [];
        for (const c of comps) {
          // look for controls inside the component's design region
          const controls = [...document.querySelectorAll(
            'button, [role="button"], [role="tab"], select, input, summary, a[href]'
          )].filter((e) => {
            const r = e.getBoundingClientRect();
            const y = r.top + window.scrollY, x = r.left + window.scrollX;
            return x >= c.box[0] - 40 && x <= c.box[0] + c.box[2] + 40 &&
                   y >= c.box[1] - 40 && y <= c.box[1] + c.box[3] + 40;
          });
          if (c.kind === "display-set") continue;   // a readout, not a control
          if (c.kind === "indicator-group") {
            const want = Math.max(2, c.count || 2);
            if (controls.length < want)
              out.push({ id: c.id, name: c.name, kind: c.kind,
                found: controls.length, expected: want,
                problem: `the design has ${want} indicators here but the page has ${controls.length} clickable control(s) in that region` });
          } else if (c.kind === "dropdown") {
            const real = controls.some((e) =>
              e.tagName === "SELECT" || e.hasAttribute("aria-expanded") || e.hasAttribute("aria-haspopup"));
            if (!real)
              out.push({ id: c.id, name: c.name, kind: c.kind,
                problem: "no <select> and no aria-expanded/aria-haspopup control in that region — the dropdown was rendered as static markup" });
          }
        }
        return out;
      }, demanded);
      if (missing.length)
        failures.missingComponents = {
          components: missing,
          hint: "these interactive components exist in the design but not as working controls in the page. Build them from real elements (buttons/select) and wire them in script.js, then declare them in interactions.json.",
        };
    }

    await page.setViewportSize({ width: stageW, height: 950 });
    const dead = touchesBehaviour
      ? await findDeadControls(page, url)
      : (previous?.failures?.deadControls?.controls || []);
    if (dead.length) failures.deadControls = { controls: dead,
      hint: "clicking these produced no DOM change, no scroll and no navigation. Wire the behaviour the design implies, or if the element is purely decorative make it a real link (<a href=\"#section\">) or non-interactive markup." };

    // ---- overflow + responsive quality passes ----
    const overflow = [];
    const responsive = {};
    for (const width of [stageW, 768, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(url, { waitUntil: "networkidle" });
      await neutralize(page);
      const result = await page.evaluate(() => {
        const d = document.documentElement;
        if (d.scrollWidth <= d.clientWidth + 1) return null;
        const vw = d.clientWidth;
        const offenders = [];
        document.querySelectorAll("body *").forEach((e) => {
          const r = e.getBoundingClientRect();
          if (r.width === 0 || (r.right <= vw + 2 && r.left >= -2)) return;
          let p = e.parentElement, clipped = false;
          while (p && p !== document.body) {
            const o = getComputedStyle(p).overflowX;
            if (o === "hidden" || o === "clip" || o === "auto" || o === "scroll") { clipped = true; break; }
            p = p.parentElement;
          }
          if (!clipped)
            offenders.push({
              el: e.tagName + "." + String(e.className).slice(0, 40),
              left: Math.round(r.left), right: Math.round(r.right),
            });
        });
        return { scrollW: d.scrollWidth, clientW: d.clientWidth, offenders: offenders.slice(0, 10) };
      });
      if (result) overflow.push({ width, ...result });

      // Overflow is only the loudest way a narrow layout breaks. Squeezed
      // columns, collisions, edge-to-edge text and wrapped labels never widen
      // the page, so nothing else in the pipeline can see them.
      const rq = await checkResponsiveQuality(page, width);
      for (const [kind, items] of Object.entries(rq))
        if (items.length) (responsive[kind] ||= []).push({ width, items });

      // The reviewer has only ever been shown desktop crops, which is why the
      // mobile defects above went unseen by it as well as by the checks.
      if (width === 375) {
        mobileShotPath = path.join(refsDir, `mobile-round${round}.png`);
        await page.screenshot({ path: mobileShotPath, fullPage: false });
      }
    }
    if (overflow.length) failures.overflow = overflow;
    if (Object.keys(responsive).length)
      failures.responsive = {
        ...responsive,
        hint: "the design has no mobile frame, so these layouts are your own decisions and nothing else checks them. squeezed: a flex/grid row shrank instead of collapsing — give its children flex-basis:100% (or one column) at that breakpoint, since flexbox shrinks by default rather than wrapping. overlaps: two pieces of TEXT sit on top of each other. edgeTouch: text runs to the viewport edge with no gutter. cramped: a control is narrower than its own label, so the label wrapped.",
      };

    if (consoleErrors.length) failures.consoleErrors = [...new Set(consoleErrors)].slice(0, 10);
    if (pageErrors.length) failures.pageErrors = [...new Set(pageErrors)].slice(0, 10);
    if (brokenImages.length) failures.brokenImages = brokenImages;

    await context.close();
  } finally {
    await browser.close();
    server.close();
  }

  return { pass: Object.keys(failures).length === 0, failures, stats, screenshotPath, comparisonShots, mobileShotPath };
}
