import { fetchNode, fetchVariables, fetchImageFills, renderNodes } from "./figma.js";
import { normalize } from "./normalize.js";

/**
 * REST-backed stand-ins for the Figma MCP tools, so the agent loop runs with
 * the exact same tool names and data when no MCP server is reachable.
 * Powered by the user's FIGMA_TOKEN — no OAuth, no desktop app needed.
 */
export function createRestFigmaTools(cfg, fileKey, defaultNodeId) {
  return [
    {
      name: "figma_get_design_context",
      description:
        "Get the full design context for a Figma node: normalized design tree (coordinates [x,y,w,h] relative to the frame, text verbatim, fills/effects resolved) plus downloadable asset URLs (download them with download_url — they expire). Same data the Figma MCP provides.",
      parameters: { type: "object", properties: {
        nodeId: { type: "string", description: "e.g. 565:6713 (defaults to the target node)" },
      }, required: [] },
      run: async ({ nodeId = defaultNodeId } = {}) => {
        const { document } = await fetchNode(cfg.figmaToken, fileKey, nodeId);
        const design = normalize(document);

        const assets = [];
        if (design.assets.images.length) {
          const fillUrls = await fetchImageFills(cfg.figmaToken, fileKey);
          for (const { ref, name } of design.assets.images)
            if (fillUrls[ref]) assets.push({ kind: "image(png)", name, url: fillUrls[ref] });
        }
        if (design.assets.vectors.length) {
          const urls = await renderNodes(cfg.figmaToken, fileKey,
            design.assets.vectors.map((v) => v.id), "svg");
          for (const { id, name } of design.assets.vectors)
            if (urls[id]) assets.push({ kind: "vector(svg)", name, url: urls[id] });
        }

        return [
          `STAGE: ${design.stage.width} x ${design.stage.height} px (frame "${document.name}")`,
          ``,
          `ASSETS (download each with download_url into assets/ using a semantic kebab-case filename):`,
          ...assets.map((a) => `- [${a.kind}] "${a.name}" -> ${a.url}`),
          ``,
          `DESIGN TREE:`,
          JSON.stringify(design.tree),
        ].join("\n");
      },
    },
    {
      name: "figma_get_variable_defs",
      description: "Get the file's named design variables/tokens (colors etc.). May be empty on non-Enterprise plans — then use the resolved colors from the design tree.",
      parameters: { type: "object", properties: {}, required: [] },
      run: async () => {
        const vars = await fetchVariables(cfg.figmaToken, fileKey);
        return Object.keys(vars).length
          ? JSON.stringify(vars, null, 1)
          : "(no named variables available — use resolved colors from the design tree)";
      },
    },
    {
      name: "figma_get_screenshot",
      description: "Render a node to a PNG and get its temporary URL (download with download_url into refs/ if you need to keep it).",
      parameters: { type: "object", properties: {
        nodeId: { type: "string", description: "defaults to the target node" },
      }, required: [] },
      run: async ({ nodeId = defaultNodeId } = {}) => {
        const urls = await renderNodes(cfg.figmaToken, fileKey, [nodeId], "png", 1);
        return urls[nodeId] ? `screenshot URL: ${urls[nodeId]}` : "Figma could not render this node";
      },
    },
  ];
}
