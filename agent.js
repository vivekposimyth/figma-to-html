#!/usr/bin/env node
/**
 * AGENT MODE — replicates the reference session's flow exactly:
 * the LLM itself drives Figma MCP tools + file tools + a real browser in a
 * multi-turn loop (extract -> assets -> write -> serve -> measure -> fix ->
 * interactions -> done), instead of the fixed-step convert.js pipeline.
 *
 *   node agent.js <figma-frame-url> [--name <output-folder>]
 *
 * Requires the Figma DESKTOP app running with the Dev Mode MCP server enabled
 * (Figma menu -> Preferences -> "Enable local MCP Server"), which serves the
 * same tools the reference session used at http://127.0.0.1:3845/mcp.
 */
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./lib/env.js";
import { parseFigmaUrl } from "./lib/figma.js";
import { McpClient } from "./lib/mcp-client.js";
import { FigmaAuth } from "./lib/figma-oauth.js";
import { createRestFigmaTools } from "./lib/figma-rest-tools.js";
import { createCostTracker } from "./lib/cost.js";
import { createLocalTools } from "./lib/agent-tools.js";
import { agentSystemPrompt } from "./lib/agent-prompt.js";

const log = (m) => console.log(`\x1b[35m[agent]\x1b[0m ${m}`);
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_TOOL_RESULT = 100_000; // chars per tool result fed back to the model

async function main() {
  const args = process.argv.slice(2);
  const url = args.find((a) => a.includes("figma.com"));
  if (!url) {
    console.error("Usage: node agent.js <figma-frame-url> [--name <folder>]");
    process.exit(1);
  }
  const cfg = loadEnv({ requireFigmaToken: false });
  const { fileKey, nodeId } = parseFigmaUrl(url);

  const nameIdx = args.indexOf("--name");
  const pageName = nameIdx > -1 ? args[nameIdx + 1] : `agent-${nodeId.replace(":", "-")}`;
  const outDir = path.join(cfg.root, "output", pageName);
  fs.mkdirSync(outDir, { recursive: true });

  // ---- Figma MCP (same tools as the reference session) ----
  // Prefer the desktop app's local server; fall back to Figma's remote MCP
  // (https://mcp.figma.com/mcp) with a one-time browser OAuth.
  const localUrl = process.env.FIGMA_MCP_URL || "http://127.0.0.1:3845/mcp";
  let mcp = new McpClient(localUrl);
  let mcpTools;
  try {
    mcpTools = await mcp.init();
    log(`Figma MCP connected (local: ${localUrl})`);
  } catch (localErr) {
    log(`local Figma MCP not reachable (${localErr.message.split("\n")[0]}) — using remote mcp.figma.com`);
    const REMOTE = "https://mcp.figma.com/mcp";
    // Try PAT, then OAuth (only if app creds provided); otherwise fall back to
    // REST-backed figma_* tools — same data, no MCP needed.
    mcpTools = null;
    if (cfg.figmaToken) {
      try {
        mcp = new McpClient(REMOTE, { pat: cfg.figmaToken });
        mcpTools = await mcp.init();
        log("Figma MCP connected (remote, personal access token)");
      } catch { /* fall through */ }
    }
    if (!mcpTools && process.env.FIGMA_OAUTH_CLIENT_ID) {
      try {
        const auth = new FigmaAuth(cfg.root);
        mcp = new McpClient(REMOTE, auth);
        mcpTools = await mcp.init();
        log("Figma MCP connected (remote, OAuth)");
      } catch (e) { log(`remote OAuth failed (${e.message.split("\n")[0]})`); }
    }
    if (!mcpTools) {
      if (!cfg.figmaToken) {
        console.error("No Figma access: set FIGMA_TOKEN in .env (personal access token).");
        process.exit(1);
      }
      mcp = null;
      log("no MCP reachable — using REST-backed figma_* tools (same data, zero setup)");
    }
  }
  // ---- local tools (files, downloads, server, browser) ----
  const { defs: localDefs, cleanup } = createLocalTools(outDir);
  const restFigmaDefs = mcp ? [] : createRestFigmaTools(cfg, fileKey, nodeId);

  const toolSpecs = [
    ...(mcp
      ? mcpTools.map((t) => ({
          type: "function",
          function: {
            name: `figma_${t.name}`,
            description: (t.description || "").slice(0, 1000),
            parameters: t.inputSchema || { type: "object", properties: {} },
          },
        }))
      : restFigmaDefs.map((t) => ({
          type: "function",
          function: { name: t.name, description: t.description, parameters: t.parameters },
        }))),
    ...localDefs.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
  ];
  const localByName = Object.fromEntries(
    [...localDefs, ...restFigmaDefs].map((t) => [t.name, t])
  );
  log(`tools: ${toolSpecs.map((t) => t.function.name).join(", ")}`);

  const execTool = async (name, argsObj) => {
    if (name.startsWith("figma_") && mcp) {
      const r = await mcp.call(name.slice(6), {
        ...argsObj,
        // the Figma MCP infers file/node from the desktop selection unless given
        fileKey: argsObj.fileKey ?? fileKey,
        nodeId: argsObj.nodeId ?? nodeId,
      });
      return { text: r.isError ? `MCP tool error: ${r.text}` : r.text, images: r.images };
    }
    const tool = localByName[name];
    if (!tool) return { text: `unknown tool: ${name}` };
    const out = await tool.run(argsObj);
    if (out && typeof out === "object" && out.imagePath) {
      const img = cfg.vision
        ? [{ data: fs.readFileSync(out.imagePath).toString("base64"), mimeType: "image/png" }]
        : [];
      return { text: out.text, images: img };
    }
    return { text: String(out) };
  };

  // ---- the loop ----
  const system = agentSystemPrompt({ fileKey, nodeId, vision: cfg.vision });
  const messages = [
    { role: "system", content: system },
    { role: "user", content: `Convert ${url} now. Output folder is already set up (assets/, refs/). Begin with Phase 1.` },
  ];
  const usage = { prompt: 0, completion: 0 };
  const cost = createCostTracker(cfg.model);
  const startedAt = Date.now();
  const maxTurns = parseInt(process.env.AGENT_MAX_TURNS ?? "80", 10);
  let doneSummary = null;
  const recentCalls = [];

  // History pruning: old tool results get elided so the resent context stays
  // small — without this, an 80-turn run compounds into millions of input tokens.
  const KEEP_RECENT = 24; // last N messages stay untouched
  const pruneHistory = () => {
    for (let i = 2; i < messages.length - KEEP_RECENT; i++) {
      const m = messages[i];
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > 500 && !m._elided) {
        m.content = m.content.slice(0, 500) + `\n...(elided ${m.content.length - 500} chars of an older result — re-run the tool if you truly need it again)`;
        m._elided = true;
      }
    }
  };

  for (let turn = 1; turn <= maxTurns && !doneSummary; turn++) {
    pruneHistory();
    if (turn === Math.floor(maxTurns * 0.5))
      messages.push({ role: "user", content: `NOTE: half the turn budget is used (${turn}/${maxTurns}). Be economical: batch measurements, finish the geometry pass, then responsive (375/768 overflow) and interactions.` });
    if (turn === Math.floor(maxTurns * 0.8))
      messages.push({ role: "user", content: `NOTE: only ${maxTurns - turn} turns left. Wrap up NOW: fix any horizontal overflow at 375/768, run the final checks, and call done with the summary.` });
    const t0 = Date.now();
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.openrouterKey}`,
        "Content-Type": "application/json",
        "X-Title": "figma-to-code-agent",
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        usage: { include: true },
        ...(cfg.reasoningMaxTokens > 0 ? { reasoning: { max_tokens: cfg.reasoningMaxTokens } } : {}),
        messages,
        tools: toolSpecs,
      }),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 400)}`);
    const data = await res.json();
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error(`empty choice: ${JSON.stringify(data).slice(0, 300)}`);
    usage.prompt += data.usage?.prompt_tokens || 0;
    usage.completion += data.usage?.completion_tokens || 0;
    await cost.add(`turn ${turn}`, data.usage);

    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });

    if (!msg.tool_calls?.length) {
      // no tool call: nudge once, otherwise accept as final answer
      const text = (typeof msg.content === "string" ? msg.content : "").trim();
      log(`turn ${turn}: model replied without tool call (${Math.round((Date.now() - t0) / 1000)}s)`);
      if (text && /done|complete|finished/i.test(text) === false && turn < maxTurns) {
        messages.push({ role: "user", content: "Continue with the workflow using tool calls. When everything is verified, call the done tool." });
        continue;
      }
      doneSummary = text || "(model stopped without summary)";
      break;
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      let argsObj = {};
      try { argsObj = JSON.parse(tc.function.arguments || "{}"); } catch {}
      // loop breaker: three identical consecutive calls -> tell it to change approach
      const sig = name + JSON.stringify(argsObj);
      recentCalls.push(sig);
      if (recentCalls.length > 3) recentCalls.shift();
      if (recentCalls.length === 3 && recentCalls.every((s) => s === sig)) {
        messages.push({ role: "tool", tool_call_id: tc.id, content: "LOOP DETECTED: you made this exact call 3 times. The result will not change — take a different approach or move to the next phase." });
        continue;
      }
      let result;
      try {
        result = await execTool(name, argsObj);
      } catch (e) {
        result = { text: `TOOL ERROR: ${e.message}` };
      }
      let text = result.text ?? "";
      if (text.length > MAX_TOOL_RESULT) text = text.slice(0, MAX_TOOL_RESULT) + "\n...(truncated — use read_file for the rest)";
      log(`turn ${turn}: ${name}(${JSON.stringify(argsObj).slice(0, 110)}) -> ${text.split("\n")[0].slice(0, 110)}`);
      messages.push({ role: "tool", tool_call_id: tc.id, content: text || "(no output)" });
      // vision models get images as a follow-up user message (tool results are text-only)
      if (cfg.vision && result.images?.length) {
        messages.push({
          role: "user",
          content: result.images.map((im) => ({
            type: "image_url",
            image_url: { url: `data:${im.mimeType};base64,${im.data}` },
          })),
        });
      }
      if (name === "done") doneSummary = argsObj.summary || "done";
    }
  }

  await cleanup();
  fs.writeFileSync(
    path.join(outDir, "refs", "agent-log.json"),
    JSON.stringify({
      url, model: cfg.model,
      turns: messages.filter((m) => m.role === "assistant").length,
      usage, cost: cost.totals, doneSummary,
    }, null, 1)
  );
  fs.writeFileSync(
    path.join(outDir, "refs", "transcript.json"),
    JSON.stringify(messages.map(({ _elided, ...m }) => m), null, 1)
  );

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log("");
  log(doneSummary ? `FINISHED: ${doneSummary.slice(0, 600)}` : "stopped at max turns without done()");
  log(`page:   output/${pageName}/index.html`);
  log(`time:   ${Math.floor(elapsed / 60)}m ${elapsed % 60}s`);
  log("");
  console.log(cost.summary());
}

main().catch((e) => {
  console.error(`\x1b[31m[agent] fatal:\x1b[0m ${e.message}`);
  process.exit(1);
});
