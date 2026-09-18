#!/usr/bin/env node
/**
 * Figma -> HTML/CSS/JS pipeline
 *
 *   node convert.js <figma-frame-url> [--name <output-folder-name>]
 *
 * Extract (Figma REST) -> normalize -> download assets -> generate (OpenRouter LLM)
 * -> validate (Playwright: geometry vs Figma coords, overflow, errors, images)
 * -> automatic fix rounds -> cost summary.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./lib/env.js";
import { parseFigmaUrl, fetchNode, fetchVariables } from "./lib/figma.js";
import { normalize } from "./lib/normalize.js";
import { downloadAssets, frameScreenshot, sectionScreenshots } from "./lib/assets.js";
import { SYSTEM_PROMPT, designContext, filePrompt, fixPrompt } from "./lib/prompts.js";
import {
  chat, withImages, parseFiles, parsePatches, applyPatches, REQUIRED_FILES, GENERATED_FILES,
} from "./lib/llm.js";
import { validate } from "./lib/validate.js";
import { createCostTracker } from "./lib/cost.js";
import { inspectVisually } from "./lib/inspect.js";

const log = (msg) => console.log(`\x1b[36m[pipeline]\x1b[0m ${msg}`);

/**
 * One number for how wrong a render is, so rounds can be compared. Weighted by
 * how much each failure actually hurts the result — a broken image or a JS
 * error matters far more than a 6px drift.
 */
function score(result) {
  const f = result.failures;
  const n = (x) => (Array.isArray(x) ? x.length : x ? 1 : 0);
  return (
    n(f.pageErrors) * 40 + n(f.consoleErrors) * 20 + n(f.brokenImages) * 30 +
    n(f.overflow) * 25 + n(f.fontsNotLoaded) * 20 +
    n(f.declaredInteractions) * 15 + n(f.interactions) * 15 + n(f.missingComponents) * 25 +
    n(f.geometry) * 6 + n(f.deadControls) * 3 + n(f.clippedElements) * 20 + n(f.visualFindings) * 10 +
    n(f.responsive) * 22 +
    Math.round((result.stats.visualDiffPct || 0) * 2)
  );
}

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.includes("figma.com"));
  if (!url) {
    console.error("Usage: node convert.js <figma-frame-url> [--name <folder>]");
    process.exit(1);
  }
  const cfg = loadEnv();
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const startedAt = Date.now();

  // ---------- 1. extract ----------
  log(`fetching node ${nodeId} from file ${fileKey} ...`);
  const { document, fileName } = await fetchNode(cfg.figmaToken, fileKey, nodeId);
  const variables = await fetchVariables(cfg.figmaToken, fileKey);
  if (!Object.keys(variables).length)
    log("no named variables available (Enterprise-only endpoint) — using resolved colors from nodes");

  const design = normalize(document);
  const nameIdx = args.indexOf("--name");
  const pageName =
    nameIdx > -1
      ? args[nameIdx + 1]
      : (document.name || fileName).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  const outDir = path.join(cfg.root, "output", pageName);
  const assetsDir = path.join(outDir, "assets");
  const refsDir = path.join(outDir, "refs");
  fs.mkdirSync(refsDir, { recursive: true });

  const designJson = JSON.stringify(design.tree);
  fs.writeFileSync(path.join(refsDir, "design.json"), JSON.stringify(design, null, 1));
  log(`design tree: ${(designJson.length / 1024).toFixed(0)}KB, stage ${design.stage.width}x${design.stage.height}px, ${design.anchors.length} measured anchors`);
  if (designJson.length > 400_000)
    log("WARNING: very large design tree — expect high token cost; consider converting section frames separately");

  // ---------- 2. assets ----------
  log(`downloading ${design.assets.images.length} images + ${design.assets.vectors.length} vectors ...`);
  const { manifest, failures: assetFails } = await downloadAssets(cfg, fileKey, design, assetsDir);
  log(`assets: ${manifest.length} ok${assetFails.length ? `, ${assetFails.length} FAILED` : ""}`);
  assetFails.forEach((f) => log(`  asset failure: ${f}`));
  fs.writeFileSync(path.join(refsDir, "assets-manifest.json"), JSON.stringify(manifest, null, 1));

  const figmaShot = await frameScreenshot(
    cfg, fileKey, nodeId, design.stage, path.join(refsDir, "figma-frame.png")
  ).catch((e) => { log(`frame screenshot failed: ${e.message}`); return null; });

  // near-native section renders, so the generator can actually see the details
  const sections = cfg.vision
    ? await sectionScreenshots(cfg, fileKey, design, refsDir)
        .catch((e) => { log(`section screenshots failed: ${e.message}`); return []; })
    : [];
  if (sections.length) log(`section references: ${sections.map((s) => s.name).join(", ")}`);

  // ---------- 3. generate ----------
  const usage = { prompt: 0, completion: 0 };
  const cost = createCostTracker(cfg.model);
  let res;
  let files;

  const system = SYSTEM_PROMPT.replaceAll("STAGE_WIDTH", String(Math.round(design.stage.width)));
  const timedChat = async (c, opts, label) => {
    const t0 = Date.now();
    log(`${label} — waiting for ${c.model} (large pages can take a few minutes) ...`);
    const r = await chat(c, opts);
    usage.prompt += r.usage?.prompt_tokens || 0;
    usage.completion += r.usage?.completion_tokens || 0;
    const spent = await cost.add(label, r.usage);
    log(`${label} — done in ${Math.round((Date.now() - t0) / 1000)}s (${r.usage?.completion_tokens || "?"} tokens out${spent != null ? `, ${spent < 0.01 ? "$" + spent.toFixed(5) : "$" + spent.toFixed(4)}` : ""}, finish: ${r.finish})`);
    return r;
  };

  const canResume =
    args.includes("--resume") &&
    REQUIRED_FILES.every((f) => fs.existsSync(path.join(outDir, f)));
  if (canResume) {
    files = Object.fromEntries(
      REQUIRED_FILES.map((f) => [f, fs.readFileSync(path.join(outDir, f), "utf8")])
    );
    log(`--resume: reusing existing files in output/${pageName}/, skipping generation`);
  } else {
    if (args.includes("--resume")) log("--resume requested but no previous files found — generating fresh");
    // One file per call: a big page's three files rarely fit in a single completion.
    files = {};
    const ctx = designContext({
      designJson, variables, manifest, stage: design.stage, pageName,
      anchors: design.anchors, fonts: design.fonts, components: design.components,
    });
    const generate = async (target) => {
      const prompt = filePrompt({ target, ctx, files });
      const images = target === "index.html"
        ? [figmaShot, ...sections.map((s) => s.file)].filter(Boolean)
        : [];
      let r = await timedChat(cfg, { system, userContent: withImages(cfg, prompt, images) }, `generate ${target}`);
      let got = parseFiles(r.text)[target];
      if (!got && r.finish === "length") {
        r = await timedChat(
          { ...cfg, maxTokens: cfg.maxTokens * 2 },
          { system, userContent: withImages(cfg, prompt, images) },
          `generate ${target} (retry, double budget)`
        );
        got = parseFiles(r.text)[target];
      }
      if (!got || got.trim().length < 40) {
        if (REQUIRED_FILES.includes(target))
          throw new Error(
            `model failed to produce ${target} (finish: ${r.finish}). ` +
              `Raise LLM_MAX_TOKENS in .env or try a different model.`
          );
        log(`no ${target} produced — declared-interaction tests will be skipped this run`);
        return;
      }
      files[target] = got;
      fs.writeFileSync(path.join(outDir, target), got);
      log(`wrote output/${pageName}/${target} (${got.split("\n").length} lines)`);
    };

    // index.html first — everything else is written against it. style.css and
    // script.js depend only on that markup, not on each other, so they run
    // together; interactions.json needs the finished script.
    await generate("index.html");
    await Promise.all([generate("style.css"), generate("script.js")]);
    await generate("interactions.json");
  }

  // ---------- 4. validate + fix loop ----------
  // Coded checks find what we thought to look for; the inspector looks at the
  // design next to the render and reports what we did not.
  const inspectRound = async (r, round) => {
    if (!cfg.vision) return;
    const seen = await inspectVisually(cfg, {
      crops: r.comparisonShots, figmaShot, renderShot: r.screenshotPath,
      mobileShot: r.mobileShotPath,
    });
    if (!seen) return;
    await cost.add(`inspect round ${round}`, seen.usage);
    if (seen.error) { log(`  inspector failed: ${seen.error}`); return; }
    const notable = seen.findings.filter((f) => f.severity !== "low");
    log(`  inspector: ${seen.findings.length} finding(s)${notable.length ? ` (${notable.length} notable)` : ""}`);
    notable.slice(0, 3).forEach((f) => log(`    - ${f.where}: ${f.render}`));
    if (notable.length) r.failures.visualFindings = notable;
    fs.writeFileSync(path.join(refsDir, `inspect-round${round}.json`), JSON.stringify(seen.findings, null, 1));
  };

  let result = await validate(cfg, { outDir, design, refsDir, round: 0, figmaShotPath: figmaShot });
  await inspectRound(result, 0);
  log(`round 0 (generate): ${result.pass ? "PASS" : "fail — " + Object.keys(result.failures).join(", ")} (max geometry delta ${result.stats.maxDelta}px over ${result.stats.measured} anchors)`);

  let failedPatches = [];
  let stalled = 0;
  for (let round = 1; !result.pass && round <= cfg.maxFixRounds; round++) {
    log(`fix round ${round} ...`);
    fs.writeFileSync(path.join(refsDir, `validation-round${round - 1}.json`), JSON.stringify(result.failures, null, 1));
    try {
      res = await timedChat({ ...cfg, maxTokens: cfg.fixMaxTokens }, {
        system,
        userContent: withImages(
          cfg,
          fixPrompt({ validation: result.failures, files, round, failedPatches,
                      hasCrops: (result.comparisonShots || []).length > 0 }),
          // side-by-side crops of the worst regions beat a downscaled full-page
          // shot; fall back to the whole page when nothing differed enough
          (result.comparisonShots || []).length
            ? result.comparisonShots
            : [figmaShot, result.screenshotPath]
        ),
      }, `fix round ${round}`);
    } catch (e) {
      log(`fix round ${round} LLM call failed (${e.message}) — keeping round ${round - 1} files and stopping`);
      break;
    }
    if (res.finish === "length") log("WARNING: fix completion hit max_tokens — truncated output is ignored");

    // Preferred: surgical patches (fast). Fallback: a complete file block.
    let patches = parsePatches(res.text);
    // A whole-file answer costs minutes; ask once for the format that was
    // requested before accepting it.
    if (!patches.length && !Object.keys(parseFiles(res.text)).length) {
      log(`  no patches and no complete file in the reply — asking once more`);
      try {
        res = await timedChat({ ...cfg, maxTokens: cfg.fixMaxTokens }, {
          system,
          userContent:
            fixPrompt({ validation: result.failures, files, round, failedPatches, hasCrops: false }) +
            `\n\nYour previous reply contained no ===PATCH:=== block and no ===FILE:=== block, so nothing could be applied. Reply with patch blocks in exactly the documented format and nothing else.`,
        }, `fix round ${round} (reformat)`);
        patches = parsePatches(res.text);
      } catch (e) { log(`  reformat attempt failed: ${e.message}`); }
    }
    const changed = new Set();
    if (patches.length) {
      const { files: patched, applied, failed } = applyPatches(files, patches);
      files = patched;
      applied.forEach((p) => changed.add(p.file));
      log(`fix round ${round}: ${applied.length}/${patches.length} patches applied` +
          (failed.length ? ` — ${failed.length} failed (${failed[0].why})` : ""));
      failedPatches = failed;
    } else {
      failedPatches = [];
    }
    const whole = parseFiles(res.text);
    for (const f of Object.keys(whole)) {
      if (GENERATED_FILES.includes(f) && whole[f].trim().length >= 40) {
        files[f] = whole[f];
        changed.add(f);
      }
    }
    if (!changed.size) {
      log(`fix round ${round} produced no usable change — keeping previous version and stopping`);
      break;
    }
    for (const f of changed) fs.writeFileSync(path.join(outDir, f), files[f]);
    log(`fix round ${round} updated: ${[...changed].join(", ")}`);
    const previous = { result, files: { ...files } };
    result = await validate(cfg, {
      outDir, design, refsDir, round, figmaShotPath: figmaShot,
      changed, previous: previous.result,
    });
    // the inspector only earns its call when the picture actually moved
    const visualMoved =
      Math.abs((result.stats.visualDiffPct || 0) - (previous.result.stats.visualDiffPct || 0)) > 0.5;
    if (visualMoved || round === 1) await inspectRound(result, round);
    else if (previous.result.failures.visualFindings)
      result.failures.visualFindings = previous.result.failures.visualFindings;
    log(`round ${round}: ${result.pass ? "PASS" : "fail — " + Object.keys(result.failures).join(", ")} ` +
        `(score ${score(result)}, was ${score(previous.result)}; max delta ${result.stats.maxDelta}px)`);

    // A fix can fix one thing and break two. Never let the run end on a state
    // that is worse than one it already reached.
    if (!result.pass && score(result) > score(previous.result)) {
      log(`  regression — round ${round} is worse than round ${round - 1}; rolling back`);
      files = previous.files;
      for (const f of GENERATED_FILES) if (files[f]) fs.writeFileSync(path.join(outDir, f), files[f]);
      result = previous.result;
      failedPatches = [];
      stalled++;
    } else if (score(result) === score(previous.result)) {
      stalled++;
    } else stalled = 0;

    if (stalled >= 2) {
      log(`  no progress for 2 rounds — stopping instead of burning more calls`);
      break;
    }
  }

  // ---------- 5. summary ----------
  const totals = cost.totals;
  fs.writeFileSync(path.join(refsDir, "cost.json"), JSON.stringify({ model: cfg.model, calls: cost.calls, totals }, null, 1));

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const heavy = manifest.filter((a) => a.bytes > 300 * 1024);
  log("");
  log(`DONE — ${result.pass ? "all checks passed" : "failures remain"}`);
  log(`  page:    ${path.join("output", pageName, "index.html")}`);
  log(`  time:    ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  if (!result.pass) {
    const f = result.failures;
    log(`  left:    ${f.geometry?.length || 0} geometry, ${(f.overflow || []).length} overflow width(s), ` +
        `${(f.consoleErrors?.length || 0) + (f.pageErrors?.length || 0)} console errors, ${f.brokenImages?.length || 0} broken images` +
        `  (details: output/${pageName}/refs/validation-round*.json)`);
  }
  if (heavy.length) log(`  assets:  ${heavy.length} file(s) over 300KB — consider compressing`);
  log(`  preview: npx serve output/${pageName}`);
  log("");
  console.log(cost.summary());
  process.exit(result.pass ? 0 : 2);
}

main().catch((e) => {
  console.error(`\x1b[31m[pipeline] fatal:\x1b[0m ${e.message}`);
  process.exit(1);
});
