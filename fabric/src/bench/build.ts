// React Flow node/edge construction. The `@xyflow/react` import here is
// type-only, so it is erased at run time and this module stays DOM-free and
// unit-testable under `tsx --test` without a browser.
import type { Edge, Node } from '@xyflow/react';
import type { FabricState } from '../contracts';
import {
  AXIS_H,
  AXIS_W,
  AXIS_X,
  AXIS_Y,
  BENCH_PAD,
  CONTENT_W,
  GROUP_H,
  GROUP_Y,
  LANE_H,
  LANE_W,
  LANE_X,
  MAX_PARTICLES,
  NOTE_H,
  axisTicks,
  benchCeiling,
  benchRows,
  benchUnplaced,
  describeBench,
  layoutBench,
  type BenchRow,
} from './core';

export interface BenchAxisData extends Record<string, unknown> {
  ceiling: number;
  ticks: { value: number; x: number; label: string }[];
  empty: boolean;
}

export interface BenchGroupData extends Record<string, unknown> {
  // x offsets are lane-local and match the lane's own column positions, so the
  // captions sit over the readings they name.
  columns: { label: string; x: number }[];
  honesty: string;
}

export interface BenchLaneData extends Record<string, unknown> {
  row: BenchRow;
  // The same tick list the axis draws, so a lane's gridlines and the ruler
  // above it are literally the same numbers.
  ticks: { value: number; x: number; label: string }[];
}

export interface BenchNoteData extends Record<string, unknown> {
  jobs: { id: string; capability: string; status: string; reason: string }[];
}

export interface BenchDemoData extends Record<string, unknown> {
  caption: string;
}

// The frame draws nothing. It records the visible content box, including the
// intake columns and link rails outside the other nodes. Responsive fitting
// uses these same explicit geometry bounds, without waiting for measurement.
export interface BenchFrameData extends Record<string, unknown> {
  label: string;
}

export type BenchNodeData =
  | BenchAxisData
  | BenchGroupData
  | BenchLaneData
  | BenchNoteData
  | BenchDemoData
  | BenchFrameData;

// `role` is what carries the link's identity: BenchEdge has no other way to
// tell a request from a result, since both are drawn by the same component.
export interface BenchEdgeData extends Record<string, unknown> {
  role: 'heartbeat' | 'request' | 'result' | 'return';
  particles: number;
  label: string;
}

// One handle per link, not one per side: the three links into a lane run down
// three parallel rails in the wiring gutter, and a handle's x offset (set in
// bench.css against these ids) is what puts each rail where it belongs.
const HANDLES = {
  groupHeartbeat: 'group-heartbeat',
  groupRequest: 'group-request',
  groupResult: 'group-result',
  groupReturn: 'group-return',
  laneHeartbeat: 'lane-heartbeat',
  laneRequest: 'lane-request',
  laneResult: 'lane-result',
  laneReturn: 'lane-return',
};

export function laneNodeId(nodeId: string): string {
  return `bench:lane:${nodeId}`;
}

export const FRAME_ID = 'bench:frame:content';

// Module scope: React Flow warns and remounts every node when these objects are
// recreated on each render.
export const NODE_TYPES = {
  benchAxis: 'benchAxis',
  benchGroup: 'benchGroup',
  benchLane: 'benchLane',
  benchNote: 'benchNote',
  benchDemo: 'benchDemo',
  benchFrame: 'benchFrame',
} as const;

export const EDGE_TYPES = {
  benchHeartbeat: 'benchHeartbeat',
  benchFlow: 'benchFlow',
  benchReturn: 'benchReturn',
} as const;

export const NOOP_NODES_CHANGE = () => {};
export const NOOP_EDGES_CHANGE = () => {};

const COLUMNS = [
  { label: 'COMPUTE', x: 12 },
  { label: 'MEASURED GENERATION — tok/s, LAST MEASURED SAMPLE', x: 282 },
  { label: 'ACCELERATOR', x: 816 },
];

export function benchNodes(fabric: FabricState | null, now: number): Node<BenchNodeData>[] {
  if (fabric === null) {
    return [
      {
        id: 'bench:demo:fabric',
        type: NODE_TYPES.benchDemo,
        position: { x: BENCH_PAD, y: AXIS_Y },
        style: { width: CONTENT_W - BENCH_PAD * 2, height: 216 },
        draggable: false,
        data: { caption: describeBench(null, now) } satisfies BenchDemoData,
      },
    ];
  }
  const rows = benchRows(fabric, now);
  // An authenticated fabric with no nodes draws no canvas at all: an axis with
  // no readings implies a measurement that does not exist.
  if (!rows.length) return [];
  const geometry = layoutBench(fabric, now);
  const ceiling = benchCeiling(fabric, now);
  const ticks = axisTicks(ceiling);

  const nodes: Node<BenchNodeData>[] = [
    {
      id: FRAME_ID,
      type: NODE_TYPES.benchFrame,
      position: { x: BENCH_PAD, y: AXIS_Y },
      style: {
        width: geometry.width - BENCH_PAD * 2,
        height: geometry.height - BENCH_PAD * 2,
        pointerEvents: 'none',
      },
      draggable: false,
      selectable: false,
      data: { label: 'content frame' } satisfies BenchFrameData,
    },
    {
      id: 'bench:axis:scale',
      type: NODE_TYPES.benchAxis,
      position: { x: AXIS_X, y: AXIS_Y },
      style: { width: AXIS_W, height: AXIS_H },
      draggable: false,
      data: {
        ceiling,
        ticks,
        empty: ceiling <= 1,
      } satisfies BenchAxisData,
    },
    {
      id: 'bench:group:all',
      type: NODE_TYPES.benchGroup,
      position: { x: LANE_X, y: GROUP_Y },
      style: { width: LANE_W, height: GROUP_H },
      draggable: false,
      data: {
        columns: COLUMNS,
        honesty: 'Bars share one scale. Length is the measurement; nothing here is capacity.',
      } satisfies BenchGroupData,
    },
  ];

  for (const row of rows) {
    nodes.push({
      id: laneNodeId(row.nodeId),
      type: NODE_TYPES.benchLane,
      position: { x: LANE_X, y: row.y },
      style: { width: LANE_W, height: LANE_H },
      draggable: false,
      data: { row, ticks } satisfies BenchLaneData,
    });
  }

  if (geometry.note) {
    nodes.push({
      id: 'bench:note:unplaced',
      type: NODE_TYPES.benchNote,
      position: { x: geometry.note.x, y: geometry.note.y },
      style: { width: geometry.note.w, height: NOTE_H },
      draggable: false,
      data: {
        jobs: benchUnplaced(fabric.jobs ?? [], fabric.nodes).map((job) => ({
          id: job.id,
          capability: job.capability,
          status: job.status,
          reason: job.placement_reason,
        })),
      } satisfies BenchNoteData,
    });
  }

  return nodes;
}

export function benchEdges(fabric: FabricState | null, now: number): Edge<BenchEdgeData>[] {
  if (fabric === null) return [];
  const rows = benchRows(fabric, now);
  if (!rows.length) return [];

  const edges: Edge<BenchEdgeData>[] = [];
  for (const row of rows) {
    edges.push({
      id: `bench:heartbeat:${row.nodeId}`,
      type: EDGE_TYPES.benchHeartbeat,
      source: 'bench:group:all',
      sourceHandle: HANDLES.groupHeartbeat,
      target: laneNodeId(row.nodeId),
      targetHandle: HANDLES.laneHeartbeat,
      data: { role: 'heartbeat', particles: 0, label: 'heartbeat' },
    });
    // In-flight work is reported directly by the snapshot, so it is drawn even
    // when no timing has been measured yet — suppressing it would hide real
    // activity and make the diagram lie by omission.
    if (row.status === 'online' && row.inFlight > 0) {
      const particles = Math.min(row.inFlight, MAX_PARTICLES);
      edges.push({
        id: `bench:flow:request:${row.nodeId}`,
        type: EDGE_TYPES.benchFlow,
        source: laneNodeId(row.nodeId),
        sourceHandle: HANDLES.laneRequest,
        target: 'bench:group:all',
        targetHandle: HANDLES.groupRequest,
        data: { role: 'request', particles, label: `request · ${row.inFlightText}` },
      });
      edges.push({
        id: `bench:flow:result:${row.nodeId}`,
        type: EDGE_TYPES.benchFlow,
        source: 'bench:group:all',
        sourceHandle: HANDLES.groupResult,
        target: laneNodeId(row.nodeId),
        targetHandle: HANDLES.laneResult,
        data: { role: 'result', particles, label: `result · ${row.inFlightText}` },
      });
    }
  }

  const last = rows[rows.length - 1];
  edges.push({
    id: 'bench:return:all',
    type: EDGE_TYPES.benchReturn,
    source: laneNodeId(last.nodeId),
    sourceHandle: HANDLES.laneReturn,
    target: 'bench:group:all',
    targetHandle: HANDLES.groupReturn,
    data: { role: 'return', particles: 0, label: 'results are not streamed' },
  });
  return edges;
}

export const BENCH_CONTENT_WIDTH = CONTENT_W;
export { HANDLES as BENCH_HANDLES };
