/**
 * Minimal MCP client over Streamable HTTP — enough to talk to the Figma
 * desktop app's local Dev Mode MCP server (http://127.0.0.1:3845/mcp),
 * which exposes the same tools the reference session used
 * (get_design_context, get_variable_defs, get_screenshot, get_metadata...).
 */
export class McpClient {
  /**
   * auth (optional):
   *  - { pat: "figd_..." }  -> sent as X-Figma-Token (Figma personal access token)
   *  - { token(): Promise<string>, refresh(): Promise<void> } -> OAuth Bearer
   */
  constructor(url, auth = null) {
    this.url = url;
    this.auth = auth;
    this.id = 0;
    this.sessionId = null;
  }

  async #post(payload) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.auth?.pat) headers["X-Figma-Token"] = this.auth.pat;
    else if (this.auth) headers.Authorization = `Bearer ${await this.auth.token()}`;
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    return res;
  }

  async rpc(method, params = {}) {
    const id = ++this.id;
    let res = await this.#post({ jsonrpc: "2.0", id, method, params });
    if (res.status === 401 && this.auth?.refresh) {
      await this.auth.refresh();
      res = await this.#post({ jsonrpc: "2.0", id, method, params });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`MCP HTTP ${res.status} on ${method}: ${body.slice(0, 300)}`);
    }
    const ct = res.headers.get("content-type") || "";
    let msg;
    if (ct.includes("text/event-stream")) {
      const text = await res.text();
      const events = text
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => {
          try { return JSON.parse(l.slice(5)); } catch { return null; }
        })
        .filter(Boolean);
      msg = events.find((e) => e.id === id) ?? events[events.length - 1];
    } else {
      msg = await res.json();
    }
    if (!msg) throw new Error(`MCP ${method}: empty response`);
    if (msg.error) throw new Error(`MCP ${method}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  async notify(method, params = {}) {
    await this.#post({ jsonrpc: "2.0", method, params }).catch(() => {});
  }

  /** Handshake + tool discovery. Returns the server's tool definitions. */
  async init() {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "figma-to-code-agent", version: "0.1.0" },
    });
    await this.notify("notifications/initialized");
    const { tools } = await this.rpc("tools/list");
    return tools || [];
  }

  /**
   * Call one MCP tool. Returns { text, images } where images are
   * { data (base64), mimeType } entries from the content array.
   */
  async call(name, args = {}) {
    const result = await this.rpc("tools/call", { name, arguments: args });
    const texts = [];
    const images = [];
    for (const c of result.content || []) {
      if (c.type === "text") texts.push(c.text);
      else if (c.type === "image") images.push({ data: c.data, mimeType: c.mimeType });
    }
    return { text: texts.join("\n"), images, isError: !!result.isError };
  }
}
