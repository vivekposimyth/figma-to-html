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
    maxFixRounds: parseInt(process.env.MAX_FIX_ROUNDS ?? "3", 10),
    geoTolerance: parseFloat(process.env.GEO_TOLERANCE ?? "4"),
    visualTolerance: parseFloat(process.env.VISUAL_TOLERANCE ?? "18"),
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? "96000", 10),
    // A fix round should be a handful of patches. A ceiling this low makes a
    // whole-file rewrite physically impossible, which is the only thing that
    // reliably stops one — the instruction alone does not.
    fixMaxTokens: parseInt(process.env.FIX_MAX_TOKENS ?? "12000", 10),
    reasoningMaxTokens: parseInt(process.env.REASONING_MAX_TOKENS ?? "24000", 10),
    root: ROOT,
  };

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
