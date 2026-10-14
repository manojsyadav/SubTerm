import { describe, it, expect } from "vitest";
import { buildCommitGraph, LANE_OFFSET, LANE_WIDTH } from "./graph";

describe("buildCommitGraph", () => {
  it("builds a single linear history on lane 0", () => {
    const commits = [
      { hash: "c3", parents: ["c2"] },
      { hash: "c2", parents: ["c1"] },
      { hash: "c1", parents: [] },
    ];
    const nodes = buildCommitGraph(commits);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].lane).toBe(0);
    expect(nodes[1].lane).toBe(0);
    expect(nodes[2].lane).toBe(0);
    expect(nodes[0].x).toBe(LANE_OFFSET);
    // c3 connects down to c2
    expect(nodes[0].lines).toContainEqual(
      expect.objectContaining({ x1: LANE_OFFSET, y1: 11, x2: LANE_OFFSET, y2: 22 })
    );
    // c2 receives from above and connects down
    expect(nodes[1].lines).toContainEqual(
      expect.objectContaining({ x1: LANE_OFFSET, y1: 0, x2: LANE_OFFSET, y2: 11 })
    );
    expect(nodes[1].lines).toContainEqual(
      expect.objectContaining({ x1: LANE_OFFSET, y1: 11, x2: LANE_OFFSET, y2: 22 })
    );
    // c1 (root) receives from above and does not connect down
    expect(nodes[2].lines).toContainEqual(
      expect.objectContaining({ x1: LANE_OFFSET, y1: 0, x2: LANE_OFFSET, y2: 11 })
    );
    expect(nodes[2].lines.some(l => l.y2 === 22)).toBe(false);
  });

  it("handles a merge commit with 2 parents spanning 2 lanes", () => {
    const commits = [
      { hash: "m1", parents: ["c2", "b1"] },
      { hash: "b1", parents: ["c1"] },
      { hash: "c2", parents: ["c1"] },
      { hash: "c1", parents: [] },
    ];
    const nodes = buildCommitGraph(commits);
    expect(nodes).toHaveLength(4);
    // m1 is at lane 0
    expect(nodes[0].lane).toBe(0);
    // m1 connects to c2 on lane 0 and b1 on lane 1 with a curve
    const m1Curves = nodes[0].lines.filter(l => l.isCurve);
    expect(m1Curves).toHaveLength(1);
    expect(m1Curves[0].x2).toBe(LANE_OFFSET + LANE_WIDTH);
    // b1 is at lane 1
    expect(nodes[1].lane).toBe(1);
    // lane 0 passes through row 1 (b1) for c2
    const passLines = nodes[1].lines.filter(l => l.x1 === LANE_OFFSET && l.y1 === 0 && l.y2 === 22);
    expect(passLines).toHaveLength(1);
  });
});
