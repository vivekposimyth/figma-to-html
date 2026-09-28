import fs from "node:fs";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/**
 * One OpenRouter chat call. userContent: string, or array of {type,...} parts.
 *
 * Reasoning is billed and timed out of the same max_tokens budget as the answer,
 * so a model that cannot be told to reason less will expand its trace to fill
 * whatever budget it is given and only then start writing — or run out first and
 * return nothing at all.
 *
 * Whether it can be told depends entirely on the model. Measured with one hard
 * CSS prompt at a 4-6k budget:
 *   deepseek-v4.1-flash  every documented control ignored — reasoning.max_tokens,
 *                        reasoning.effort (minimal/low/medium), exclude, the
 *                        top-level reasoning_effort, thinking.budget_tokens and
 *                        provider require_parameters all produced a full-budget
 *                        trace and zero content. Only effort "none" / enabled
 *                        false worked, i.e. off.
 *   claude-sonnet-5      reasoning.max_tokens:2000 -> 5999 tokens, no content.
 *   gpt-5.6-luna         effort "low" ->   308 reasoning tokens + full answer
 *                        effort "medium" -> 1552 reasoning tokens + full answer
 *
 * So REASONING is an effort level here, honoured by models that support it and
 * ignored by those that do not; "off" is the one setting every model respects.
 */
const MAX_ATTEMPTS = 3;

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
    body.reasoning = cfg.reasoning === "off"
      ? { enabled: false }
      : cfg.reasoning === "on"
        ? {}                                   // model's own default effort
        : { effort: cfg.reasoning };           // minimal | low | medium | high

    // A model can be served by many providers and OpenRouter picks one per
    // request. They differ enough to look like bugs in our own code: for
    // deepseek-v4.1-flash the output ceilings ranged from 32,768 to 943,718
    // tokens, so the same prompt was truncated mid-file on one call and fine on
    // the next. Sorting by throughput pins a consistent fast route; the ignore
    // list drops the ceilings too low to hold a large stylesheet (a no-op for
    // models those providers do not serve).
    body.provider = {
      sort: "throughput",
      ignore: ["BaseTen", "DeepInfra", "Venice"],
    };

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
    const finish = choice?.finish_reason;

    // A provider that errors or returns nothing is the case retrying was made
    // for. Previously only "length" was retried, so one flaky response threw
    // away a run that had already spent half an hour and produced good files.
    if (attempt < MAX_ATTEMPTS - 1) {
      if (finish === "length" && !cfg.noBudgetRetry) {
        maxTokens *= 2;
        console.log(`\x1b[33m[llm]\x1b[0m truncated with no content — retrying with max_tokens=${maxTokens}`);
      } else {
        const backoff = 2000 * (attempt + 1);
        console.log(
          `\x1b[33m[llm]\x1b[0m empty reply (finish: ${finish}, ${reasoningLen} chars of reasoning) — ` +
            `retry ${attempt + 1}/${MAX_ATTEMPTS - 1} in ${backoff / 1000}s`
        );
        await new Promise((r) => setTimeout(r, backoff));
      }
      continue;
    }
    throw new Error(
      `Empty completion after ${MAX_ATTEMPTS} attempts (finish: ${finish}, reasoning: ${reasoningLen} chars). ` +
        `If reasoning is large the model is thinking instead of answering — keep REASONING=off, ` +
        `raise LLM_MAX_TOKENS, or try another model.`
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
