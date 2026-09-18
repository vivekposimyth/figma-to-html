/**
 * Run cost accounting. OpenRouter reports the real cost per call when the
 * request sets `usage: { include: true }`; if a provider omits it we fall back
 * to the model's published per-token price.
 */
let priceCache = null;

async function modelPrice(model) {
  if (priceCache === null) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      const data = await res.json();
      priceCache = Object.fromEntries(
        (data.data || []).map((m) => [m.id, {
          prompt: parseFloat(m.pricing?.prompt || "0"),
          completion: parseFloat(m.pricing?.completion || "0"),
        }])
      );
    } catch { priceCache = {}; }
  }
  return priceCache[model] || null;
}

export function createCostTracker(model) {
  const calls = [];
  let estimated = false;

  return {
    /** Record one LLM call. label is what shows in the per-call breakdown. */
    async add(label, usage) {
      const prompt = usage?.prompt_tokens || 0;
      const completion = usage?.completion_tokens || 0;
      let cost = typeof usage?.cost === "number" ? usage.cost : null;
      if (cost === null) {
        const p = await modelPrice(model);
        if (p) { cost = prompt * p.prompt + completion * p.completion; estimated = true; }
      }
      calls.push({ label, prompt, completion, cost });
      return cost;
    },

    get totals() {
      return {
        calls: calls.length,
        prompt: calls.reduce((s, c) => s + c.prompt, 0),
        completion: calls.reduce((s, c) => s + c.completion, 0),
        cost: calls.reduce((s, c) => s + (c.cost || 0), 0),
        estimated,
        known: calls.every((c) => c.cost !== null),
      };
    },

    get calls() { return calls; },

    /** Multi-line summary for the end of a run. */
    summary() {
      const t = this.totals;
      const money = (v) => (v == null ? "  —  " : v < 0.01 ? `$${v.toFixed(5)}` : `$${v.toFixed(4)}`);
      const lines = [
        `Cost — ${model}`,
        `  ${"call".padEnd(30)} ${"in".padStart(9)} ${"out".padStart(8)} ${"cost".padStart(10)}`,
      ];
      for (const c of calls)
        lines.push(`  ${c.label.slice(0, 30).padEnd(30)} ${String(c.prompt).padStart(9)} ${String(c.completion).padStart(8)} ${money(c.cost).padStart(10)}`);
      lines.push(`  ${"-".repeat(60)}`);
      lines.push(`  ${`TOTAL (${t.calls} calls)`.padEnd(30)} ${String(t.prompt).padStart(9)} ${String(t.completion).padStart(8)} ${money(t.cost).padStart(10)}`);
      if (!t.known) lines.push(`  (some calls reported no cost and no published price was found — total is a lower bound)`);
      else if (t.estimated) lines.push(`  (some values estimated from published per-token pricing)`);
      return lines.join("\n");
    },
  };
}
