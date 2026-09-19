// The only module in the bench that imports @xyflow/react as a value. Every
// other bench module is type-only or DOM-only, which is what keeps the logic
// unit-testable without a browser. React Flow's own stylesheet is imported by
// main.tsx rather than here — a `import '...css'` in a module the test runner
// loads would break `tsx --test`, which has no CSS loader.
import { useEffect, useMemo, type CSSProperties } from 'react';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  getSmoothStepPath,
  type EdgeProps,
  type NodeProps,
} from '@xyflow/react';
import type { FabricState } from '../contracts';
import NodeIdentity from '../NodeIdentity';
import { AxisBody, DemoBody, EmptyNote, GroupBody, LaneBody, NoteBody } from './BenchBodies';
import {
  NODE_TYPES,
  EDGE_TYPES,
  NOOP_EDGES_CHANGE,
  NOOP_NODES_CHANGE,
  BENCH_HANDLES,
  benchEdges,
  benchNodes,
  type BenchAxisData,
  type BenchDemoData,
  type BenchFrameData,
  type BenchGroupData,
  type BenchLaneData,
  type BenchNoteData,
} from './build';
import { MAX_PARTICLES, benchRows, describeBench, layoutBench, type BenchRow } from './core';

// Handles are invisible (bench.css collapses them to a 2px point): they exist
// only so every link has a real attachment point. Their offsets are what place
// the three links on their own rails in the wiring gutter left of each lane.
const laneHandles = (
  <>
    <Handle type="target" position={Position.Left} id={BENCH_HANDLES.laneHeartbeat} className="bench-handle" />
    <Handle type="source" position={Position.Left} id={BENCH_HANDLES.laneRequest} className="bench-handle" />
    <Handle type="target" position={Position.Left} id={BENCH_HANDLES.laneResult} className="bench-handle" />
    <Handle type="source" position={Position.Right} id={BENCH_HANDLES.laneReturn} className="bench-handle" />
  </>
);

const groupHandles = (
  <>
    <Handle type="source" position={Position.Left} id={BENCH_HANDLES.groupHeartbeat} className="bench-handle" />
    <Handle type="target" position={Position.Left} id={BENCH_HANDLES.groupRequest} className="bench-handle" />
    <Handle type="source" position={Position.Left} id={BENCH_HANDLES.groupResult} className="bench-handle" />
    <Handle type="target" position={Position.Right} id={BENCH_HANDLES.groupReturn} className="bench-handle" />
  </>
);

function AxisNode({ data }: NodeProps) {
  return <AxisBody data={data as BenchAxisData} />;
}
function GroupNode({ data }: NodeProps) {
  return <GroupBody data={data as BenchGroupData} handles={groupHandles} />;
}
function LaneNode({ data }: NodeProps) {
  return <LaneBody data={data as BenchLaneData} handles={laneHandles} />;
}
function NoteNode({ data }: NodeProps) {
  return <NoteBody data={data as BenchNoteData} />;
}
function DemoNode({ data }: NodeProps) {
  return <DemoBody data={data as BenchDemoData} />;
}
function FrameNode({ data }: NodeProps) {
  // Draws nothing; see BenchFrameData in build.ts for why it is here at all.
  return <div className="bench-frame" aria-hidden="true" title={(data as BenchFrameData).label} />;
}

// Fit the explicit content rectangle, not measured nodes. The intake and
// return rails extend outside node boxes, and the signed-out demo has no frame
// node. Observe dimensions only: heartbeats must not reset a user's pan.
function ResponsiveBenchViewport({ width, height }: { width: number; height: number }) {
  const canvasWidth = useStore((state) => state.width);
  const canvasHeight = useStore((state) => state.height);
  const { fitBounds, viewportInitialized } = useReactFlow();

  useEffect(() => {
    if (!viewportInitialized || canvasWidth <= 0 || canvasHeight <= 0) return;
    void fitBounds({ x: 0, y: 0, width, height }, { padding: 0, duration: 0 });
  }, [canvasWidth, canvasHeight, width, height, viewportInitialized, fitBounds]);

  return null;
}

// Module scope: React Flow remounts every node when these objects change.
const FLOW_NODE_TYPES = {
  [NODE_TYPES.benchAxis]: AxisNode,
  [NODE_TYPES.benchGroup]: GroupNode,
  [NODE_TYPES.benchLane]: LaneNode,
  [NODE_TYPES.benchNote]: NoteNode,
  [NODE_TYPES.benchDemo]: DemoNode,
  [NODE_TYPES.benchFrame]: FrameNode,
};

function BenchEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, borderRadius: 6 });
  const particles = Math.max(0, Math.min(MAX_PARTICLES, Number(data?.particles ?? 0)));
  const role = String(data?.role ?? '');
  const className = `bench-edge${role ? ` bench-edge-${role}` : ''}`;
  return (
    <>
      <BaseEdge id={id} path={path} className={className} />
      {Array.from({ length: particles }, (_, index) => (
        <circle
          key={index}
          className={`bench-particle${role ? ` bench-edge-${role}` : ''}`}
          cx={0}
          cy={0}
          r={3.4}
          // offset-path rides the edge's own geometry, so a particle can only
          // ever travel along the link it belongs to — a translateX dot would
          // sail straight past a corner and read as a link that does not exist.
          style={
            {
              offsetPath: `path("${path}")`,
              animationDelay: `${index * 0.5}s`,
            } as CSSProperties
          }
        />
      ))}
    </>
  );
}

const FLOW_EDGE_TYPES = {
  [EDGE_TYPES.benchHeartbeat]: BenchEdge,
  [EDGE_TYPES.benchFlow]: BenchEdge,
  [EDGE_TYPES.benchReturn]: BenchEdge,
};

const LEDGER_COLUMNS = [
  'Node',
  'Status',
  'Measured gen',
  'Sample',
  'Age',
  'CPU',
  'Load',
  'Mem',
  'Accelerator',
  'Models',
  'Runtime',
];

// The canvas is a fixed-size diagram: below the width where it stops being
// readable it is replaced by this table rather than shrunk into illegibility.
function Ledger({ rows, caption }: { rows: BenchRow[]; caption: string }) {
  return (
    <details className="bench-ledger">
      <summary>Read this bench as a table</summary>
      <div className="bench-table-wrap">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              {LEDGER_COLUMNS.map((heading) => (
                <th key={heading} scope="col">
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const cpu = row.compute.find((bar) => bar.name === 'CPU');
              const load = row.compute.find((bar) => bar.name === 'LOAD');
              const memory = row.compute.find((bar) => bar.name === 'MEM');
              return (
                <tr key={row.nodeId}>
                  <th scope="row"><NodeIdentity nodeId={row.nodeId} /></th>
                  <td>{row.status}</td>
                  <td>{row.rate.text}</td>
                  <td>{row.rate.sampleText || '—'}</td>
                  <td>{row.rate.recencyText}</td>
                  <td>{cpu?.value ?? '—'}</td>
                  <td>
                    {load?.value ?? '—'} <small>{load?.detail ?? ''}</small>
                  </td>
                  <td>
                    {memory?.value ?? '—'} <small>{memory?.detail ?? ''}</small>
                  </td>
                  <td>
                    {row.accelerators.length === 0
                      ? 'No accelerator detected'
                      : row.accelerators.map((item) => `${item.name} — ${item.caption}`).join('; ')}
                  </td>
                  <td>{listCell(row.modelsEmpty, row.modelChips, row.modelOverflow, 'No models reported', (chip) => `${chip.id} — ${chip.word}`)}</td>
                  <td>{listCell(row.runtimesEmpty, row.runtimeChips, row.runtimeOverflow, 'Runtime not reported', (chip) => `${chip.label}${chip.simulated ? ' (simulated)' : ''}`)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// The canvas caps how many chips it draws. This table is the reader's fallback,
// so it prints the overflow count instead of quietly stopping where the canvas
// stopped.
function listCell<T>(
  empty: boolean,
  chips: T[],
  overflow: number,
  emptyText: string,
  format: (chip: T) => string,
): string {
  if (empty) return emptyText;
  const listed = chips.map(format).join('; ');
  return overflow > 0 ? `${listed} (+${overflow} more)` : listed;
}

export default function BenchDiagram({
  fabric,
  now,
  live = true,
}: {
  fabric: FabricState | null;
  now: number;
  live?: boolean;
}) {
  const nodes = useMemo(() => benchNodes(fabric, now), [fabric, now]);
  const edges = useMemo(() => benchEdges(fabric, now), [fabric, now]);
  const rows = useMemo(() => benchRows(fabric, now), [fabric, now]);
  const geometry = useMemo(() => layoutBench(fabric, now), [fabric, now]);
  const preview = fabric === null;
  const empty = !preview && rows.length === 0;

  return (
    <section
      id="bench"
      className="bench"
      aria-labelledby="bench-heading"
      data-view={preview ? 'demo' : live ? 'live' : 'stale'}
    >
      <header className="bench-heading">
        <div>
          <p className="eyebrow">
            {preview ? 'DEMO · ARCHITECTURE ONLY' : live ? 'LIVE THROUGHPUT BENCH' : 'LAST KNOWN THROUGHPUT'}
          </p>
          <h2 id="bench-heading">Fabric throughput bench</h2>
        </div>
        <p>
          {preview
            ? 'Sign in to reveal live nodes, models and throughput.'
            : live
              ? 'Rates are last measured samples, not capacity guarantees.'
              : 'Connection interrupted. Showing the last received snapshot.'}
        </p>
      </header>

      {empty ? (
        <div className="bench-canvas bench-canvas-empty">
          <EmptyNote text="No node heartbeat has been received." />
        </div>
      ) : (
        <div className="bench-canvas" style={{ height: `${geometry.height}px` }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={FLOW_NODE_TYPES}
            edgeTypes={FLOW_EDGE_TYPES}
            colorMode="dark"
            nodesDraggable={false}
            nodesConnectable={false}
            nodesFocusable={false}
            edgesFocusable={false}
            elementsSelectable={false}
            panOnScroll={false}
            panOnDrag
            zoomOnScroll={false}
            zoomOnPinch={false}
            zoomOnDoubleClick={false}
            preventScrolling={false}
            onNodesChange={NOOP_NODES_CHANGE}
            onEdgesChange={NOOP_EDGES_CHANGE}
            proOptions={{ hideAttribution: true }}
            minZoom={0.05}
            maxZoom={1}
            role="group"
            aria-label={describeBench(fabric, now)}
          >
            <ResponsiveBenchViewport width={geometry.width} height={geometry.height} />
            <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="#1a3037" />
          </ReactFlow>
        </div>
      )}

      <p className="bench-caption">{geometry.caption}</p>
      {!preview && rows.length > 0 && <Ledger rows={rows} caption={geometry.caption} />}
    </section>
  );
}
