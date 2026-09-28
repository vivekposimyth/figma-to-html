import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv({ requireFigmaToken = true } = {}) {
  const file = path.join(ROOT, ".env");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }

  const cfg = {
    figmaToken: process.env.FIGMA_TOKEN,
    openrouterKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL || "minimax/minimax-m2",
    vision: (process.env.MODEL_SUPPORTS_VISION || "false").toLowerCase() === "true",
    // A ceiling, not a target: the loop stops itself once two rounds in a row
    // fail to move the score meaningfully, so a page that converges in two
    // rounds still costs two, and one that keeps improving is allowed to.
    maxFixRounds: parseInt(process.env.MAX_FIX_ROUNDS ?? "8", 10),
    geoTolerance: parseFloat(process.env.GEO_TOLERANCE ?? "4"),
    visualTolerance: parseFloat(process.env.VISUAL_TOLERANCE ?? "18"),
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "96000", 10),
    // A fix round should be a handful of patches. A ceiling this low makes a
    // whole-file rewrite physically impossible, which is the only thing that
    // reliably stops one — the instruction alone does not.
    fixMaxTokens: parseInt(process.env.FIX_MAX_TOKENS ?? "12000", 10),
    // Reasoning for fix rounds only. A fix round is not a puzzle: the failures
    // arrive already diagnosed, with the element, the delta and the CSS rule to
    // change. The trace buys nothing there and is billed and timed out of the
    // same budget as the patches, so it is off by default even when generation
    // reasons. Set FIX_REASONING to match REASONING if you want it back.
    fixReasoning: (process.env.FIX_REASONING || "off").toLowerCase(),
    // off | minimal | low | medium | high | on. Anything but "off"/"on" is sent
    // as an effort level, which only some models honour — see lib/llm.js for
    // which, and what happens on the ones that ignore it.
    reasoning: (process.env.REASONING || "low").toLowerCase(),
    root: ROOT,
  };

  // Fix rounds may run on a different model from generation. They are a
  // different job: generation writes a whole stylesheet from a spec, a fix round
  // makes a handful of surgical patches against failures that arrive already
  // diagnosed. A model that follows the patch format exactly and reasons briefly
  // beats a stronger, slower one here. Both default to the generation model, so
  // leaving FIX_MODEL unset changes nothing.
  cfg.fixModel = process.env.FIX_MODEL || cfg.model;
  cfg.fixVision = process.env.FIX_MODEL_SUPPORTS_VISION
    ? process.env.FIX_MODEL_SUPPORTS_VISION.toLowerCase() === "true"
    : (cfg.fixModel === cfg.model ? cfg.vision : false);

  const missing = [];
  if (requireFigmaToken && !cfg.figmaToken) missing.push("FIGMA_TOKEN");
  if (!cfg.openrouterKey) missing.push("OPENROUTER_API_KEY");
  if (missing.length) {
    console.error(
      `Missing ${missing.join(", ")}.\n` +
        `Copy .env.example to .env in ${ROOT} and fill in your keys.`
    );
    process.exit(1);
  }
  return cfg;
}
