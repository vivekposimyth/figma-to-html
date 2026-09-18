/**
 * What the arrangement of children actually IS, regardless of how the designer
 * built it. Figma's auto-layout flag records which tool was used, not what the
 * layout is: three evenly spaced cards are a row whether or not anyone switched
 * auto-layout on, and plenty of designers never switch it on at all. Reading the
 * flag instead of the geometry is what turns a whole page into position:absolute.
 */
export function inferFlow(node) {
  const kids = (node.children || []).filter((c) => c.box && c.box[2] > 2 && c.box[3] > 2);
  if (kids.length < 2) return null;

  const box = (c) => ({ x: c.box[0], y: c.box[1], w: c.box[2], h: c.box[3] });
  const b = kids.map(box);

  const overlap1d = (a1, a2, b1, b2) =>
    Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

  // a row: every pair shares most of its vertical extent and none share horizontal
  const rowish = b.every((p, i) =>
    b.every((q, j) => {
      if (i === j) return true;
      const vOverlap = overlap1d(p.y, p.y + p.h, q.y, q.y + q.h);
      const hOverlap = overlap1d(p.x, p.x + p.w, q.x, q.x + q.w);
      return vOverlap > Math.min(p.h, q.h) * 0.6 && hOverlap < Math.min(p.w, q.w) * 0.2;
    })
  );
  const colish = b.every((p, i) =>
    b.every((q, j) => {
      if (i === j) return true;
      const hOverlap = overlap1d(p.x, p.x + p.w, q.x, q.x + q.w);
      const vOverlap = overlap1d(p.y, p.y + p.h, q.y, q.y + q.h);
      return hOverlap > Math.min(p.w, q.w) * 0.6 && vOverlap < Math.min(p.h, q.h) * 0.2;
    })
  );

  const gaps = (sorted, startKey, sizeKey) =>
    sorted.slice(1).map((c, i) => c[startKey] - (sorted[i][startKey] + sorted[i][sizeKey]));
  const consistent = (g) =>
    g.length === 0 || Math.max(...g) - Math.min(...g) <= Math.max(4, Math.max(...g) * 0.25);
  const round = (n) => Math.round(n * 10) / 10;

  if (rowish) {
    const sorted = [...b].sort((p, q) => p.x - q.x);
    const g = gaps(sorted, "x", "w");
    return { dir: "row", gap: round(g.length ? g.reduce((a, c) => a + c, 0) / g.length : 0),
      evenGaps: consistent(g), count: kids.length };
  }
  if (colish) {
    const sorted = [...b].sort((p, q) => p.y - q.y);
    const g = gaps(sorted, "y", "h");
    return { dir: "column", gap: round(g.length ? g.reduce((a, c) => a + c, 0) / g.length : 0),
      evenGaps: consistent(g), count: kids.length };
  }

  // a grid: the children fall into repeated rows of equal count
  const rows = new Map();
  b.forEach((p) => {
    const key = [...rows.keys()].find((k) => Math.abs(k - p.y) < Math.max(8, p.h * 0.3));
    rows.set(key ?? p.y, [...(rows.get(key ?? p.y) || []), p]);
  });
  const sizes = [...rows.values()].map((r) => r.length);
  if (rows.size >= 2 && sizes.every((s) => s === sizes[0]) && sizes[0] >= 2)
    return { dir: "grid", columns: sizes[0], rows: rows.size, count: kids.length };

  return { dir: "freeform", count: kids.length };
}
