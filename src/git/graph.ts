export const GRAPH_COLORS = [
  "#38bdf8", // sky-400
  "#34d399", // emerald-400
  "#f59e0b", // amber-500
  "#a78bfa", // violet-400
  "#f43f5e", // rose-500
  "#22d3ee", // cyan-400
  "#fb923c", // orange-400
];

export interface GraphLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  isCurve?: boolean;
}

export interface CommitGraphNode {
  commitHash: string;
  lane: number;
  x: number;
  y: number;
  color: string;
  lines: GraphLine[];
  maxLanes: number;
}

export const LANE_WIDTH = 14;
export const LANE_OFFSET = 10;
export const ROW_HEIGHT = 22;

export function buildCommitGraph(
  commits: { hash: string; parents?: string[] }[]
): CommitGraphNode[] {
  const activeLanes: (string | null)[] = [];
  const laneColors: string[] = [];
  const result: CommitGraphNode[] = [];

  for (let rowIdx = 0; rowIdx < commits.length; rowIdx++) {
    const c = commits[rowIdx];
    const hash = c.hash;
    const parents = c.parents ?? [];

    // Find lane for this commit
    let lane = activeLanes.indexOf(hash);
    const cameFromAbove = lane !== -1;
    if (lane === -1) {
      const emptyIdx = activeLanes.indexOf(null);
      lane = emptyIdx !== -1 ? emptyIdx : activeLanes.length;
      activeLanes[lane] = hash;
      laneColors[lane] = GRAPH_COLORS[lane % GRAPH_COLORS.length];
    }
    const color = laneColors[lane];
    const nodeX = LANE_OFFSET + lane * LANE_WIDTH;
    const nodeY = ROW_HEIGHT / 2;

    const lanesBefore = [...activeLanes];

    // Update active lanes for parents
    const targetParentLanes: { lane: number; color: string }[] = [];
    if (parents.length === 0) {
      activeLanes[lane] = null;
    } else {
      // First parent continues in current lane if possible
      const p0 = parents[0];
      const existingP0 = activeLanes.indexOf(p0);
      if (existingP0 !== -1 && existingP0 !== lane) {
        activeLanes[lane] = null;
        targetParentLanes.push({ lane: existingP0, color: laneColors[existingP0] });
      } else {
        activeLanes[lane] = p0;
        targetParentLanes.push({ lane, color });
      }

      // Merge parents (parent 1, 2, ...)
      for (let i = 1; i < parents.length; i++) {
        const pi = parents[i];
        let pLane = activeLanes.indexOf(pi);
        if (pLane === -1) {
          const emptyIdx = activeLanes.indexOf(null);
          pLane = emptyIdx !== -1 ? emptyIdx : activeLanes.length;
          activeLanes[pLane] = pi;
          laneColors[pLane] = GRAPH_COLORS[pLane % GRAPH_COLORS.length];
        }
        targetParentLanes.push({ lane: pLane, color: laneColors[pLane] });
      }
    }

    const lines: GraphLine[] = [];

    // Pass-through lines for other active lanes
    const maxActive = Math.max(lanesBefore.length, activeLanes.length);
    for (let l = 0; l < maxActive; l++) {
      if (l === lane) continue;
      if (lanesBefore[l] && activeLanes[l]) {
        const lx = LANE_OFFSET + l * LANE_WIDTH;
        lines.push({
          x1: lx,
          y1: 0,
          x2: lx,
          y2: ROW_HEIGHT,
          color: laneColors[l] || GRAPH_COLORS[l % GRAPH_COLORS.length],
        });
      }
    }

    // Line from above into current node
    if (cameFromAbove) {
      lines.push({
        x1: nodeX,
        y1: 0,
        x2: nodeX,
        y2: nodeY,
        color,
      });
    }

    // Lines from current node to parent lanes below
    for (const p of targetParentLanes) {
      const px = LANE_OFFSET + p.lane * LANE_WIDTH;
      if (p.lane === lane) {
        lines.push({
          x1: nodeX,
          y1: nodeY,
          x2: px,
          y2: ROW_HEIGHT,
          color,
        });
      } else {
        lines.push({
          x1: nodeX,
          y1: nodeY,
          x2: px,
          y2: ROW_HEIGHT,
          color: p.color,
          isCurve: true,
        });
      }
    }

    // Clean up trailing nulls from activeLanes
    while (activeLanes.length > 0 && activeLanes[activeLanes.length - 1] === null) {
      activeLanes.pop();
    }

    result.push({
      commitHash: hash,
      lane,
      x: nodeX,
      y: nodeY,
      color,
      lines,
      maxLanes: Math.max(1, maxActive),
    });
  }

  return result;
}
