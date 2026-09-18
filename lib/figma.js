const API = "https://api.figma.com";

async function api(token, path) {
  const res = await fetch(API + path, { headers: { "X-Figma-Token": token } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Figma API ${res.status} on ${path}: ${body.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Parse a Figma URL into { fileKey, nodeId } ("179-4172" -> "179:4172"). */
export function parseFigmaUrl(url) {
  const m = url.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error(`Not a Figma file URL: ${url}`);
  const fileKey = m[1];
  const nm = url.match(/node-id=([\d]+)[-:]([\d]+)/);
  if (!nm) {
    throw new Error(
      "URL has no node-id. In Figma, right-click the frame -> Copy link to selection."
    );
  }
  return { fileKey, nodeId: `${nm[1]}:${nm[2]}` };
}

/** Fetch the node subtree for one frame. */
export async function fetchNode(token, fileKey, nodeId) {
  const data = await api(
    token,
    `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`
  );
  const entry = data.nodes?.[nodeId];
  if (!entry?.document) throw new Error(`Node ${nodeId} not found in file ${fileKey}`);
  return { document: entry.document, fileName: data.name || "design" };
}

/** Named variables (Enterprise-only endpoint) - returns {} when unavailable. */
export async function fetchVariables(token, fileKey) {
  try {
    const data = await api(token, `/v1/files/${fileKey}/variables/local`);
    const out = {};
    for (const v of Object.values(data.meta?.variables || {})) {
      const val = Object.values(v.valuesByMode || {})[0];
      if (val && typeof val === "object" && "r" in val) {
        out[v.name] = rgbaToCss(val);
      } else if (typeof val === "number" || typeof val === "string") {
        out[v.name] = val;
      }
    }
    return out;
  } catch (e) {
    if (e.status === 403 || e.status === 404) return {}; // plan doesn't include it
    throw e;
  }
}

/** Map of imageRef -> download URL for every image fill in the file. */
export async function fetchImageFills(token, fileKey) {
  const data = await api(token, `/v1/files/${fileKey}/images`);
  return data.meta?.images || {};
}

/**
 * Render nodes to images. ids: string[], format: "svg" | "png".
 * Returns { nodeId: url|null }. Chunked; null entries are Figma-side render failures.
 */
export async function renderNodes(token, fileKey, ids, format, scale = 1) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const q = `ids=${encodeURIComponent(chunk.join(","))}&format=${format}&scale=${scale}`;
    const data = await api(token, `/v1/images/${fileKey}?${q}`);
    Object.assign(out, data.images || {});
  }
  return out;
}

export function rgbaToCss({ r, g, b, a = 1 }) {
  const h = (v) => Math.round(v * 255);
  if (a >= 1) {
    return (
      "#" + [r, g, b].map((v) => h(v).toString(16).padStart(2, "0")).join("")
    );
  }
  return `rgba(${h(r)}, ${h(g)}, ${h(b)}, ${Math.round(a * 100) / 100})`;
}
