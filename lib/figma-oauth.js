/**
 * OAuth 2.1 (PKCE + dynamic client registration) for Figma's remote MCP server
 * (https://mcp.figma.com/mcp), per the MCP authorization spec:
 * discovery -> register client -> browser consent -> localhost callback ->
 * token exchange -> tokens cached in .figma-mcp-auth.json (gitignored).
 * Credentials are never handled here — the user logs in in their own browser.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const RESOURCE = "https://mcp.figma.com/mcp";
const CALLBACK_PORT = 8976;
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function discover() {
  // protected resource metadata names its authorization server
  let asBase = "https://www.figma.com";
  let scopes;
  try {
    const pr = await getJson("https://mcp.figma.com/.well-known/oauth-protected-resource");
    if (pr.authorization_servers?.length) asBase = pr.authorization_servers[0];
    scopes = pr.scopes_supported;
  } catch { /* fall back to figma.com */ }
  const asUrl = asBase.replace(/\/$/, "");
  let meta;
  try {
    meta = await getJson(`${asUrl}/.well-known/oauth-authorization-server`);
  } catch {
    meta = await getJson(`${asUrl}/.well-known/openid-configuration`);
  }
  return { meta, scopes };
}

function waitForCallback(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      if (u.pathname !== "/callback") { res.writeHead(404).end(); return; }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Figma MCP authorized — you can close this tab and return to the terminal.</h2>");
      server.close();
      if (err) return reject(new Error(`OAuth error: ${err}`));
      if (state !== expectedState) return reject(new Error("OAuth state mismatch"));
      resolve(code);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");
    setTimeout(() => { server.close(); reject(new Error("OAuth timed out after 5 minutes")); }, 300_000);
  });
}

async function tokenRequest(tokenEndpoint, params) {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`token endpoint: ${data.error || res.status} ${data.error_description || ""}`);
  return data;
}

export class FigmaAuth {
  constructor(rootDir) {
    this.file = path.join(rootDir, ".figma-mcp-auth.json");
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : null;
  }

  #save() { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1)); }

  async token() {
    if (!this.state) await this.login();
    if (this.state.expires_at && Date.now() > this.state.expires_at - 60_000) await this.refresh();
    return this.state.access_token;
  }

  async refresh() {
    if (!this.state?.refresh_token) return this.login();
    try {
      const t = await tokenRequest(this.state.token_endpoint, {
        grant_type: "refresh_token",
        refresh_token: this.state.refresh_token,
        client_id: this.state.client_id,
        ...(this.state.client_secret ? { client_secret: this.state.client_secret } : {}),
        resource: RESOURCE,
      });
      this.state.access_token = t.access_token;
      if (t.refresh_token) this.state.refresh_token = t.refresh_token;
      this.state.expires_at = t.expires_in ? Date.now() + t.expires_in * 1000 : undefined;
      this.#save();
    } catch {
      await this.login(); // refresh token expired -> full flow again
    }
  }

  async login() {
    const { meta, scopes } = await discover();
    if (!meta.authorization_endpoint || !meta.token_endpoint)
      throw new Error("Figma OAuth discovery failed — no authorization/token endpoint");

    // A manually created Figma OAuth app (figma.com/developers/apps) beats dynamic
    // registration, which Figma currently blocks (403) for unknown clients.
    let clientId = process.env.FIGMA_OAUTH_CLIENT_ID || this.state?.client_id;
    let clientSecret = process.env.FIGMA_OAUTH_CLIENT_SECRET || this.state?.client_secret;
    if (!clientId) {
      if (!meta.registration_endpoint)
        throw new Error("Figma OAuth: no dynamic registration endpoint available");
      const reg = await fetch(meta.registration_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: "figma-to-code-agent",
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const regData = await reg.json().catch(() => ({}));
      if (!reg.ok || !regData.client_id)
        throw new Error(`client registration failed: ${reg.status} ${JSON.stringify(regData).slice(0, 200)}`);
      clientId = regData.client_id;
      clientSecret = regData.client_secret; // Figma's token endpoint wants secret_post
    }

    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource: RESOURCE,
      scope: scopes?.length ? scopes.join(" ") : "mcp:connect",
    }).toString();

    console.log(`\n\x1b[35m[figma-auth]\x1b[0m opening browser for Figma authorization...\nIf it doesn't open, visit:\n${authUrl}\n`);
    spawn("open", [authUrl.toString()], { stdio: "ignore", detached: true }).unref();

    const code = await waitForCallback(state);
    const t = await tokenRequest(meta.token_endpoint, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      code_verifier: verifier,
      resource: RESOURCE,
    });

    this.state = {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
      token_endpoint: meta.token_endpoint,
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_in ? Date.now() + t.expires_in * 1000 : undefined,
    };
    this.#save();
    console.log(`\x1b[35m[figma-auth]\x1b[0m authorized — tokens cached in ${path.basename(this.file)}`);
  }
}
