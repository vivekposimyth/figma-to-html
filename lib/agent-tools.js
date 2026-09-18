import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { chromium } from "playwright";

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
};

/**
 * Local tools for the agent loop — the same capabilities the reference session
 * had: write/edit/read files, download assets, serve the page, and drive a
 * real browser (navigate, resize, evaluate JS, screenshot, console errors).
 * All file paths are sandboxed inside the output directory.
 */
export function createLocalTools(outDir) {
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "refs"), { recursive: true });

  let server = null, serverUrl = null;
  let browser = null, page = null;
  const consoleErrors = [];
  let shotCount = 0;

  const safe = (rel) => {
    const p = path.resolve(outDir, rel);
    if (!p.startsWith(path.resolve(outDir))) throw new Error(`path escapes output dir: ${rel}`);
    return p;
  };

  const ensurePage = async () => {
    if (!browser) browser = await chromium.launch();
    if (!page) {
      page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
      page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300)); });
      page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));
    }
    return page;
  };

  const defs = [
    {
      name: "write_file",
      description: "Create or overwrite a file in the output directory (e.g. index.html, style.css, script.js).",
      parameters: { type: "object", properties: {
        path: { type: "string", description: "relative path inside the output dir" },
        content: { type: "string" },
      }, required: ["path", "content"] },
      run: ({ path: rel, content }) => {
        const p = safe(rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content);
        return `wrote ${rel} (${content.split("\n").length} lines)`;
      },
    },
    {
      name: "str_replace",
      description: "Edit a file by replacing an exact unique string. Fails if the string is missing or ambiguous — then read_file and retry with more context.",
      parameters: { type: "object", properties: {
        path: { type: "string" }, old: { type: "string" }, new: { type: "string" },
      }, required: ["path", "old", "new"] },
      run: ({ path: rel, old, new: nw }) => {
        const p = safe(rel);
        const s = fs.readFileSync(p, "utf8");
        const n = s.split(old).length - 1;
        if (n === 0) throw new Error(`old string not found in ${rel}`);
        if (n > 1) throw new Error(`old string occurs ${n} times in ${rel} — make it unique`);
        fs.writeFileSync(p, s.replace(old, nw));
        return `edited ${rel}`;
      },
    },
    {
      name: "read_file",
      description: "Read a file from the output directory (optionally a line range).",
      parameters: { type: "object", properties: {
        path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" },
      }, required: ["path"] },
      run: ({ path: rel, offset = 0, limit = 400 }) => {
        const lines = fs.readFileSync(safe(rel), "utf8").split("\n");
        return lines.slice(offset, offset + limit).map((l, i) => `${offset + i + 1}\t${l}`).join("\n");
      },
    },
    {
      name: "list_dir",
      description: "List files in a directory of the output dir with sizes (use to verify downloaded assets).",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: [] },
      run: ({ path: rel = "." }) => {
        const dir = safe(rel);
        return fs.readdirSync(dir).map((f) => {
          const st = fs.statSync(path.join(dir, f));
          return `${st.isDirectory() ? "d" : " "} ${String(st.size).padStart(9)}  ${f}`;
        }).join("\n") || "(empty)";
      },
    },
    {
      name: "download_url",
      description: "Download a URL (e.g. a Figma asset URL from get_design_context) to a file. Give assets semantic kebab-case names under assets/.",
      parameters: { type: "object", properties: {
        url: { type: "string" }, path: { type: "string", description: "e.g. assets/hero-cup.png" },
      }, required: ["url", "path"] },
      run: async ({ url, path: rel }) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url.slice(0, 100)}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) throw new Error("zero-byte download");
        const p = safe(rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, buf);
        return `downloaded ${rel} (${buf.length} bytes)`;
      },
    },
    {
      name: "serve_start",
      description: "Serve the output directory on localhost (idempotent) and return the URL. Always preview via this URL, never file://.",
      parameters: { type: "object", properties: {}, required: [] },
      run: () => new Promise((resolve) => {
        if (serverUrl) return resolve(`already serving at ${serverUrl}`);
        server = http.createServer((req, res) => {
          let rel = decodeURIComponent(req.url.split("?")[0]);
          if (rel === "/") rel = "/index.html";
          let p;
          try { p = safe("." + path.normalize(rel)); } catch { res.writeHead(403).end(); return; }
          fs.readFile(p, (err, buf) => {
            if (err) { res.writeHead(404).end("Not found"); return; }
            res.writeHead(200, { "Content-Type": MIME[path.extname(p).toLowerCase()] || "application/octet-stream" });
            res.end(buf);
          });
        });
        server.listen(0, "127.0.0.1", () => {
          serverUrl = `http://127.0.0.1:${server.address().port}/`;
          resolve(`serving at ${serverUrl}`);
        });
      }),
    },
    {
      name: "browser_goto",
      description: "Navigate the test browser to a URL (use the serve_start URL). Reload after every file change.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      run: async ({ url }) => {
        const pg = await ensurePage();
        await pg.goto(url, { waitUntil: "networkidle" });
        return `at ${url}`;
      },
    },
    {
      name: "browser_resize",
      description: "Set the browser viewport (e.g. stage width 1440/1920, tablet 768, mobile 375).",
      parameters: { type: "object", properties: {
        width: { type: "number" }, height: { type: "number" },
      }, required: ["width"] },
      run: async ({ width, height = 950 }) => {
        const pg = await ensurePage();
        await pg.setViewportSize({ width, height });
        return `viewport ${width}x${height}`;
      },
    },
    {
      name: "browser_eval",
      description: "Execute JavaScript in the page body of an async function and return the result as JSON — your code MUST end with `return <value>`. `await` is allowed. Use this for geometry probes (getBoundingClientRect vs Figma coords), overflow hunting, and driving interactions (click, dispatch events, assert state). Batch several measurements into one call.",
      parameters: { type: "object", properties: { js: { type: "string" } }, required: ["js"] },
      run: async ({ js }) => {
        const pg = await ensurePage();
        const value = await pg.evaluate(
          `(async () => { try { ${js} } catch (e) { return "EVAL_ERROR: " + e.message } })()`
        );
        const s = JSON.stringify(value, null, 1) ?? "undefined (did you forget `return`?)";
        return s.length > 20000 ? s.slice(0, 20000) + "\n...(truncated)" : s;
      },
    },
    {
      name: "browser_screenshot",
      description: "Screenshot the current page (viewport, or fullPage). Saved under refs/; returned to you as an image if your model supports vision, otherwise rely on browser_eval numeric probes.",
      parameters: { type: "object", properties: { fullPage: { type: "boolean" } }, required: [] },
      run: async ({ fullPage = false }) => {
        const pg = await ensurePage();
        const rel = `refs/agent-shot-${++shotCount}.png`;
        await pg.screenshot({ path: safe(rel), fullPage });
        return { text: `saved ${rel}`, imagePath: safe(rel) };
      },
    },
    {
      name: "read_console",
      description: "Return browser console/page errors collected since the last call, then clear them.",
      parameters: { type: "object", properties: {}, required: [] },
      run: () => {
        const out = consoleErrors.length ? consoleErrors.join("\n") : "no console errors";
        consoleErrors.length = 0;
        return out;
      },
    },
    {
      name: "done",
      description: "Finish the conversion. Call ONLY after geometry, overflow (375/768/stage), interactions and console are all verified clean. Include a short fidelity summary.",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      run: ({ summary }) => summary,
    },
  ];

  const cleanup = async () => {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  };

  return { defs, cleanup };
}
