import fs from "node:fs";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * One OpenRouter chat call. userContent: string, or array of {type,...} parts.
 *
 * Reasoning models (MiniMax M3, DeepSeek R1, o-series...) burn max_tokens on an
 * internal "reasoning" trace BEFORE emitting content. Uncapped, a hard prompt can
 * consume the whole budget reasoning and return content:null with finish "length".
 * So: cap reasoning via OpenRouter's unified `reasoning.max_tokens`, and if the
 * content still comes back empty at the length ceiling, retry once with double
 * the budget.
 */
export async function chat(cfg, { system, userContent }) {
  let maxTokens = cfg.maxTokens;

  for (let attempt = 0; ; attempt++) {
    const body = {
      model: cfg.model,
      max_tokens: maxTokens,
      // ask OpenRouter to report what this call actually cost
      usage: { include: true },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    };
    if (cfg.reasoningMaxTokens > 0) body.reasoning = { max_tokens: cfg.reasoningMaxTokens };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://localhost/figma-to-code-pipeline",
        "X-Title": "figma-to-code-pipeline",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 500)}`);
    }
    const data = await res.json();
    const choice = data.choices?.[0];
    const msg = choice?.message;
    const text = typeof msg?.content === "string"
      ? msg.content
      : (msg?.content || []).map((p) => p.text || "").join("");

    if (text) return { text, usage: data.usage, finish: choice?.finish_reason };

    const reasoningLen = (msg?.reasoning || "").length;
    if (choice?.finish_reason === "length" && attempt === 0) {
      maxTokens *= 2;
      console.log(
        `\x1b[33m[llm]\x1b[0m model spent the whole budget on reasoning ` +
          `(${reasoningLen} chars of reasoning, no content) — retrying once with max_tokens=${maxTokens}`
      );
      continue;
    }
    throw new Error(
      `Empty completion (finish: ${choice?.finish_reason}, reasoning: ${reasoningLen} chars). ` +
        `The model reasons past its output budget — raise LLM_MAX_TOKENS and/or lower ` +
        `REASONING_MAX_TOKENS in .env, or switch to a less reasoning-heavy model.`
    );
  }
}

/** Build a user message that optionally carries screenshots (vision models only). */
export function withImages(cfg, text, imagePaths = []) {
  if (!cfg.vision || !imagePaths.length) return text;
  const parts = [{ type: "text", text }];
  let budget = 4 * 1024 * 1024;   // keep a request from becoming a multi-MB upload
  for (const p of imagePaths) {
    if (!p || !fs.existsSync(p)) continue;
    const buf = fs.readFileSync(p);
    if (buf.length > budget) continue;
    budget -= buf.length;
    const mime = p.toLowerCase().endsWith(".jpg") || p.toLowerCase().endsWith(".jpeg")
      ? "image/jpeg" : "image/png";
    parts.push({
      type: "image_url",
      image_url: { url: `data:${mime};base64,${buf.toString("base64")}` },
    });
  }
  return parts;
}

/** Parse ===FILE: name=== ... ===END=== blocks into { name: content }. */
export function parseFiles(text) {
  const out = {};
  const re = /===FILE:\s*([\w.\-/]+)\s*===\r?\n([\s\S]*?)\r?\n===END===/g;
  let m;
  while ((m = re.exec(text))) {
    let content = m[2];
    // strip accidental markdown fences wrapping the whole file
    content = content.replace(/^```[a-z]*\r?\n/i, "").replace(/\r?\n```\s*$/, "");
    out[m[1]] = content;
  }
  return out;
}

/**
 * Parse surgical patch blocks:
 *   ===PATCH: style.css===
 *   <<<<<<< OLD
 *   ...old...
 *   =======
 *   ...new...
 *   >>>>>>> NEW
 *   ===END===
 */
export function parsePatches(text) {
  const out = [];
  const re =
    /===PATCH:\s*([\w.\-/]+)\s*===\r?\n<{5,}\s*OLD\r?\n([\s\S]*?)\r?\n={5,}\r?\n([\s\S]*?)\r?\n>{5,}\s*NEW\r?\n===END===/g;
  let m;
  while ((m = re.exec(text))) out.push({ file: m[1], old: m[2], new: m[3] });
  return out;
}

/** Apply patches to { name: content }. Returns { files, applied, failed }. */
export function applyPatches(files, patches) {
  const next = { ...files };
  const applied = [];
  const failed = [];
  for (const p of patches) {
    const src = next[p.file];
    if (src == null) { failed.push({ ...p, why: "unknown file" }); continue; }
    const hits = src.split(p.old).length - 1;
    if (hits === 0) { failed.push({ ...p, why: "OLD text not found" }); continue; }
    if (hits > 1) { failed.push({ ...p, why: `OLD text occurs ${hits} times (not unique)` }); continue; }
    next[p.file] = src.replace(p.old, p.new);
    applied.push(p);
  }
  return { files: next, applied, failed };
}

export const REQUIRED_FILES = ["index.html", "style.css", "script.js"];
export const GENERATED_FILES = [...REQUIRED_FILES, "interactions.json"];

export function assertComplete(files) {
  const missing = REQUIRED_FILES.filter((f) => !files[f] || files[f].trim().length < 40);
  if (missing.length) {
    throw new Error(
      `LLM response missing/empty file(s): ${missing.join(", ")}. ` +
        `Got: ${Object.keys(files).join(", ") || "none"}`
    );
  }
}
