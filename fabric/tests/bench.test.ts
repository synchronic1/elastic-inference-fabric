import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getViewportForBounds } from '@xyflow/react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BenchDiagram from '../src/bench/BenchDiagram';
import {
  BENCH_HANDLES,
  FRAME_ID,
  benchEdges,
  benchNodes,
  laneNodeId,
} from '../src/bench/build';
import {
  ACCEL_W,
  AXIS_X,
  BENCH_PAD,
  CONTENT_W,
  FIRST_LANE_Y,
  GUTTER_W,
  INTAKE_W,
  LANE_H,
  LANE_W,
  LANE_X,
  LANE_GAP,
  NOTE_H,
  MAX_PARTICLES,
  PLOT_W,
  ROW_PITCH,
  STALE_AFTER_MS,
  axisCeiling,
  axisTicks,
  benchCaption,
  benchRows,
  benchTotals,
  benchUnplaced,
  describeBench,
  heartbeatDrain,
  layoutBench,
  rateToLength,
  readRate,
} from '../src/bench/core';
import type { FabricNode, FabricState } from '../src/contracts';

// One clock, passed everywhere: the bench never reads the wall clock itself, so
// every assertion below is exact rather than approximately true.
const NOW = 1_700_000_600_000;

function measuredNode(): FabricNode {
  return {
    node_id: 'native-mac',
    status: 'online',
    connected: true,
    last_seen: NOW - 4_000,
    snapshot: {
      schema_version: '1',
      node_id: 'native-mac',
      observed_at: NOW - 4_000,
      uptime_seconds: 3_720,
      execution_scope: 'local',
      active_requests: 2,
      hardware: {
        os: 'macOS',
        arch: 'arm64',
        hostname: 'studio',
        cpu: 'Apple M4',
        logical_cpus: 12,
        physical_cpus: 8,
        memory_total_bytes: 16 * 1024 ** 3,
        gpus: [{ vendor: 'Apple', name: 'M4 GPU', memory_bytes: null, unified_memory: true }],
      },
      load: { load_average: [3.5, 2, 1], memory_available_bytes: 8 * 1024 ** 3, memory_used_percent: 52 },
      runtimes: [
        {
          id: 'llama',
          kind: 'llama',
          mode: 'native',
          state: 'ready',
          busy: true,
          simulated: false,
          loaded_model: 'qwen3',
          prefix_cache: [
            {
              prefix_sha256: 'a'.repeat(64),
              prefix_bytes: 131_072,
              expires_at: NOW + 90_000,
              runtime_instance: 'r1',
              model_fingerprint: 'fp-qwen3',
              slot_id: 0,
              state: 'candidate',
              portable: false,
              simulated: false,
            },
          ],
          runtime_instance: 'r1',
          model_fingerprint: null,
          supports_model_switch: true,
          supports_cache_transfer: false,
        },
      ],
      models: [
        {
          id: 'qwen3',
          runtime: 'llama',
          capabilities: ['complete'],
          cached_on_disk: true,
          resident: true,
          available: true,
          simulated: false,
        },
      ],
      performance: {
        generation_tokens_per_second: 42.5,
        prompt_tokens_per_second: 310.25,
        samples: 128,
        last_observed_at: NOW - 6_000,
        model_id: 'qwen3',
        runtime_id: 'llama',
      },
    },
  };
}

function quietNode(): FabricNode {
  return {
    node_id: 'quiet-node',
    status: 'offline',
    connected: false,
    last_seen: NOW - 900_000,
    snapshot: {
      schema_version: '1',
      node_id: 'quiet-node',
      observed_at: NOW - 900_000,
      uptime_seconds: 0,
      execution_scope: 'local',
      active_requests: 0,
      hardware: {
        os: 'Linux',
        arch: 'x64',
        hostname: 'quiet',
        cpu: 'x86',
        logical_cpus: 4,
        physical_cpus: 4,
        memory_total_bytes: 8 * 1024 ** 3,
        gpus: [],
      },
      load: { load_average: null, memory_available_bytes: 4 * 1024 ** 3, memory_used_percent: 50 },
      runtimes: [],
      models: [],
    },
  };
}

// A rate is present, but it came out of a simulated runtime, so it is not a
// measurement of anything.
function simulatedNode(): FabricNode {
  const node = measuredNode();
  return {
    ...node,
    node_id: 'sim-node',
    snapshot: {
      ...node.snapshot,
      node_id: 'sim-node',
      runtimes: node.snapshot.runtimes.map((runtime) => ({ ...runtime, simulated: true })),
      performance: { ...node.snapshot.performance!, generation_tokens_per_second: 999.9 },
    },
  };
}

function fabric(nodes: FabricNode[], overrides: Partial<FabricState['summary']> = {}): FabricState {
  return {
    schema_version: '1',
    generated_at: NOW,
    summary: {
      online_nodes: 1,
      total_nodes: nodes.length,
      logical_cpus: 12,
      memory_total_bytes: 16 * 1024 ** 3,
      memory_available_bytes: 8 * 1024 ** 3,
      gpu_count: 1,
      resident_models: 1,
      available_models: 1,
      prefix_candidates: 1,
      active_requests: 2,
      ...overrides,
    },
    capabilities: [],
    jobs: [],
    nodes,
  };
}

const render = (state: FabricState | null, live = true) =>
  renderToStaticMarkup(createElement(BenchDiagram, { fabric: state, now: NOW, live }));

test('an authenticated fabric with no nodes draws no bench at all', () => {
  const markup = render(fabric([]));
  assert.match(markup, /data-view="live"/);
  assert.match(markup, /No node heartbeat has been received/);
  assert.ok(!markup.includes('tok/s'));
  assert.ok(!markup.includes('DEMO · ARCHITECTURE ONLY'));
  assert.ok(!markup.includes('bench-lane'));
  // Nothing has reported, so there is nothing to tabulate either.
  assert.ok(!markup.includes('bench-ledger'));
});

test('the signed-out bench is a demo and invents no node inventory', () => {
  const markup = render(null);
  assert.match(markup, /data-view="demo"/);
  assert.match(markup, /DEMO · ARCHITECTURE ONLY/);
  assert.match(markup, /Sign in to reveal live nodes, models and throughput/);
  assert.ok(!markup.includes('tok/s'));
  assert.ok(!markup.includes('native-mac'));
});

test('a measured rate is printed as a last measured sample, never as capacity', () => {
  const markup = render(fabric([measuredNode(), quietNode()]));
  assert.match(markup, /42\.5 tok\/s/);
  assert.match(markup, /from a 128-token sample/);
  assert.match(markup, /last measured — not a capacity ceiling/);
  assert.match(markup, /tok\/s generated · last measured sample/);
  assert.ok(markup.includes('2 nodes, 1 rate measured, 1 model resident.'));
  assert.ok(markup.includes('Bars share one scale and the ruler runs past the longest bar'));
  assert.ok(markup.includes('Results return through the router — results are not streamed.'));
});

test('a node with no timing reads Not measured and never 0.0 tok/s', () => {
  const markup = render(fabric([measuredNode(), quietNode()]));
  assert.match(markup, /quiet-node/);
  assert.match(markup, /Not measured/);
  assert.match(markup, /no timing has been reported for this node/);
  assert.ok(!markup.includes('0.0 tok/s'));
  assert.ok(!markup.includes('0 tok/s'));
});

test('a rate from a simulated runtime is not a measurement', () => {
  const markup = render(fabric([simulatedNode()]));
  assert.ok(!markup.includes('999.9'));
  assert.match(markup, /Not measured/);
  assert.match(markup, /simulated/);
  assert.ok(markup.includes('1 node, 0 rates measured, 1 model resident.'));
});

test('an interrupted connection is labelled as the last known reading', () => {
  const markup = render(fabric([measuredNode()]), false);
  assert.match(markup, /data-view="stale"/);
  assert.match(markup, /LAST KNOWN THROUGHPUT/);
  assert.match(markup, /Connection interrupted\. Showing the last received snapshot\./);
  assert.match(markup, /42\.5 tok\/s/);
});

test('the table view carries every lane reading', () => {
  const markup = render(fabric([measuredNode(), quietNode()]));
  assert.match(markup, /Read this bench as a table/);
  for (const heading of ['Node', 'Status', 'Measured gen', 'Sample', 'Age', 'CPU', 'Load', 'Mem', 'Accelerator', 'Models', 'Runtime']) {
    assert.ok(markup.includes(`>${heading}</th>`), `ledger is missing the ${heading} column`);
  }
  const rowHeaders = [...markup.matchAll(/<th scope="row">([\s\S]*?)<\/th>/g)]
    .map((match) => match[1].replace(/<[^>]*>/g, ''));
  assert.deepEqual(rowHeaders, ['native-mac', 'quiet-node']);
  assert.match(markup, /No models reported/);
  assert.match(markup, /Runtime not reported/);
  assert.match(markup, /No accelerator detected/);
});

test('every node gets a lane, including the ones that reported almost nothing', () => {
  const state = fabric([measuredNode(), quietNode(), simulatedNode()]);
  const rows = benchRows(state, NOW);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((row) => row.nodeId), ['native-mac', 'quiet-node', 'sim-node']);
  // Sorted by node id, so a node cannot teleport between polls.
  assert.deepEqual(rows.map((row) => row.y), [
    FIRST_LANE_Y,
    FIRST_LANE_Y + ROW_PITCH,
    FIRST_LANE_Y + ROW_PITCH * 2,
  ]);
});

test('the ruler runs strictly past the longest bar it measures', () => {
  const state = fabric([measuredNode(), simulatedNode()]);
  const rows = benchRows(state, NOW);
  const lengths = rows.map((row) => row.rate.lengthPx).filter((length) => length > 0);
  assert.deepEqual(lengths, [rateToLength(42.5, axisCeiling([42.5]))]);
  assert.ok(Math.max(...lengths) < PLOT_W, 'a bar reached the end of its own track');
  assert.equal(axisCeiling([42.5]), 50);
  assert.equal(axisCeiling([]), 1);
  assert.equal(axisCeiling([0]), 1);
  // Nothing measured means the ruler is present but explicitly empty.
  assert.deepEqual(axisTicks(1), [{ value: 1, x: PLOT_W, label: '1' }]);
  const ticks = axisTicks(50);
  assert.equal(ticks[ticks.length - 1].x, PLOT_W);
  assert.ok(ticks.every((tick, index) => index === 0 || tick.x > ticks[index - 1].x));
  // The rungs that pick the ceiling are not the rungs that label a linear
  // track: 1-2-5 bunches into the left tenth, so the ticks divide it evenly.
  for (const ceiling of [2, 5, 10, 20, 50, 100, 200]) {
    const steps = axisTicks(ceiling);
    assert.ok(steps.length >= 4 && steps.length <= 5, `${ceiling} drew ${steps.length} ticks`);
    assert.equal(steps[steps.length - 1].value, ceiling);
    assert.equal(steps[steps.length - 1].x, PLOT_W);
    const gaps = steps.slice(1).map((tick, index) => tick.x - steps[index].x);
    assert.ok(
      Math.max(...gaps) - Math.min(...gaps) < 0.01,
      `${ceiling} drew an uneven ruler: ${gaps.join(', ')}`,
    );
    assert.ok(steps.every((tick) => tick.label.length <= 4), `${ceiling} drew a long label`);
  }
  assert.equal(rateToLength(25, 50), 260);
  assert.equal(rateToLength(80, 50), PLOT_W);
});

test('a heartbeat drain empties exactly as the staleness window closes', () => {
  const at = (ageMs: number) => heartbeatDrain({ status: 'online', last_seen: NOW - ageMs }, NOW);
  assert.deepEqual(at(0), { filled: 6, total: 6, eligible: true, ageMs: 0 });
  assert.equal(at(STALE_AFTER_MS - 1).filled, 1);
  assert.deepEqual(at(STALE_AFTER_MS), { filled: 0, total: 6, eligible: true, ageMs: STALE_AFTER_MS });
  assert.equal(at(STALE_AFTER_MS + 1).eligible, false);
  assert.ok(at(20_000).filled > at(25_000).filled);
});

test('the bench never widens its own ceiling to make a bar look longer', () => {
  const state = fabric([measuredNode()]);
  const rows = benchRows(state, NOW);
  const ceiling = axisCeiling([42.5]);
  const expected = rateToLength(42.5, ceiling);
  assert.equal(rows[0].rate.lengthPx, expected);
  assert.equal(rows[0].rate.text, '42.5 tok/s');
});

test('the lane column contract holds, so the shared ruler lines up with every plot', () => {
  // The intake column and its wiring gutter sit outside the lane box, and this
  // is the only place the numbers that put them there are tied together.
  assert.equal(LANE_X, BENCH_PAD + INTAKE_W + GUTTER_W);
  const state = fabric([measuredNode(), quietNode()]);
  const nodes = benchNodes(state, NOW);
  const lanes = nodes.filter((node) => node.id.startsWith('bench:lane:'));
  assert.equal(lanes.length, 2);
  assert.ok(lanes.every((lane) => lane.position.x === LANE_X));
  assert.ok(lanes.every((lane) => lane.style?.width === LANE_W));
  assert.ok(lanes.every((lane) => lane.style?.height === LANE_H));
  const axis = nodes.find((node) => node.id === 'bench:axis:scale');
  const group = nodes.find((node) => node.id === 'bench:group:all');
  assert.ok(axis && group);
  assert.equal(axis.position.x, LANE_X + 282);
  assert.equal(AXIS_X, LANE_X + 282);
  assert.equal(group.position.x, LANE_X);
  const columns = (group.data as { columns: { x: number }[] }).columns.map((column) => column.x);
  assert.deepEqual(columns, [12, 282, 816]);
  assert.equal(816 + ACCEL_W, LANE_W - 12);
});

test('the frame covers the intake columns and the return rail that no node covers', () => {
  const state = fabric([measuredNode(), quietNode()]);
  const geometry = layoutBench(state, NOW);
  const nodes = benchNodes(state, NOW);
  const frame = nodes.find((node) => node.id === FRAME_ID);
  assert.ok(frame, 'missing the frame node');
  assert.equal(frame.position.x, BENCH_PAD);
  assert.equal(frame.style?.width, geometry.width - BENCH_PAD * 2);
  assert.equal(frame.style?.height, geometry.height - BENCH_PAD * 2);
  // The return rail runs 20px out from the last lane's right handle.
  assert.ok(LANE_X + LANE_W + 24 < CONTENT_W);
  assert.equal(geometry.width, CONTENT_W);
  // The frame is scenery: it must not paint, and it must not swallow a drag.
  assert.equal(frame.style?.pointerEvents, 'none');
});

test('responsive fitting keeps the complete visible bench inside narrow and wide canvases', () => {
  for (const count of [1, 4, 7, 32]) {
    const state = fabric(Array.from({ length: count }, (_, i) => ({ ...measuredNode(), node_id: `node-${i}` })));
    const geometry = layoutBench(state, NOW);
    for (const width of [650, 900, 1120, 1800]) {
      const height = geometry.height - 2; // canvas border is not drawing space
      const { x, y, zoom } = getViewportForBounds(
        { x: 0, y: 0, width: geometry.width, height: geometry.height },
        width, height, 0.05, 1, 0,
      );
      assert.ok(zoom <= 1);
      assert.ok(x >= -0.001 && y >= -0.001);
      assert.ok(x + geometry.width * zoom <= width + 0.001);
      const lastVisibleBottom = FIRST_LANE_Y + (geometry.visibleRows - 1) * ROW_PITCH + LANE_H;
      assert.ok(y + lastVisibleBottom * zoom < height);
      assert.ok(x + (LANE_X + LANE_W + 24) * zoom < width, 'return rail is clipped');
    }
  }
  assert.notEqual(layoutBench(null, NOW).height, layoutBench(fabric([measuredNode()]), NOW).height,
    'login must trigger the dimension-based viewport refit');
});

test('custom bodies fill their node boxes and metadata can wrap without fixed-band clipping', () => {
  const css = readFileSync(new URL('../src/bench.css', import.meta.url), 'utf8');
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).split('}')[0];
  const bodies = rule('.bench-axis, .bench-group, .bench-lane, .bench-frame, .bench-note-row, .bench-demo');
  assert.match(bodies, /width: 100%; height: 100%; box-sizing: border-box/);
  for (const selector of ['.bench-models', '.bench-footer']) {
    assert.match(rule(selector), /flex-wrap: wrap/);
    assert.doesNotMatch(rule(selector), /position: absolute|overflow: hidden|[;{]\s*height:/);
  }
  assert.match(rule('.bench-accel-item b'), /overflow-wrap: anywhere/);
  assert.doesNotMatch(rule('.bench-accel-item b'), /ellipsis|nowrap/);
  assert.match(rule('.bench-plot'), /grid-template-rows: 30px auto/);
  assert.match(rule('.bench-lane-content'), /overflow: auto/);
  const markup = render(fabric([measuredNode()]));
  assert.match(markup, /class="bench-lane-content nowheel nopan" tabindex="0" role="region"/);
});

test('lane links are drawn only for nodes that are actually connected and busy', () => {
  const state = fabric([measuredNode(), quietNode()]);
  const edges = benchEdges(state, NOW);
  const roles = edges.map((edge) => (edge.data as { role: string }).role);
  assert.equal(roles.filter((role) => role === 'heartbeat').length, 2);
  assert.equal(roles.filter((role) => role === 'request').length, 1);
  assert.equal(roles.filter((role) => role === 'result').length, 1);
  assert.equal(roles.filter((role) => role === 'return').length, 1);
  const request = edges.find((edge) => (edge.data as { role: string }).role === 'request');
  assert.equal(request?.source, laneNodeId('native-mac'));
  assert.equal((request?.data as { particles: number }).particles, Math.min(2, MAX_PARTICLES));
  const returns = edges.find((edge) => (edge.data as { role: string }).role === 'return');
  // Results return through the router; they are not streamed back down a lane.
  assert.equal(returns?.target, 'bench:group:all');
  assert.equal((returns?.data as { label: string }).label, 'results are not streamed');
});

test('the offline lane is left out of the in-flight animation', () => {
  const state = fabric([quietNode()]);
  const edges = benchEdges({ ...state, nodes: [{ ...quietNode(), status: 'online' }] }, NOW);
  assert.equal(edges.filter((edge) => (edge.data as { role: string }).role === 'request').length, 0);
});

test('every handle an edge attaches to is a handle the canvas actually renders', () => {
  const state = fabric([measuredNode(), quietNode()]);
  const markup = render(state);
  const known = new Set(Object.values(BENCH_HANDLES));
  const used = new Set<string>();
  for (const edge of benchEdges(state, NOW)) {
    assert.ok(known.has(edge.sourceHandle ?? ''), `unknown source handle ${edge.sourceHandle}`);
    assert.ok(known.has(edge.targetHandle ?? ''), `unknown target handle ${edge.targetHandle}`);
    used.add(edge.sourceHandle!);
    used.add(edge.targetHandle!);
  }
  // React Flow drops an edge whose handle is missing, so this is the difference
  // between a link that is drawn and a link that silently is not.
  for (const handle of used) {
    assert.ok(markup.includes(`data-handleid="${handle}"`), `${handle} is not rendered`);
  }
});

test('jobs with no reported node get their own note, not a lane', () => {
  const state: FabricState = {
    ...fabric([measuredNode()]),
    jobs: [
      {
        id: 'job-1',
        status: 'failed',
        capability: 'complete',
        node_id: 'gone-node',
        model_id: 'qwen3',
        runtime_id: 'llama',
        created_at: NOW - 60_000,
        placement_reason: 'no eligible node reported this capability',
      },
    ],
  };
  assert.equal(benchUnplaced(state.jobs, state.nodes).length, 1);
  const nodes = benchNodes(state, NOW);
  const note = nodes.find((node) => node.id === 'bench:note:unplaced');
  assert.ok(note, 'unplaced job was dropped from the bench');
  const markup = render(state);
  assert.match(markup, /Jobs with no reported node/);
  assert.match(markup, /no eligible node reported this capability/);
  assert.ok(!nodes.some((node) => node.id === laneNodeId('gone-node')));
});

test('the canvas includes the unplaced-job note below every reported lane', () => {
  const state: FabricState = {
    ...fabric(Array.from({ length: 12 }, (_, index) => ({ ...measuredNode(), node_id: `node-${index}` }))),
    jobs: [
      {
        id: 'job-1',
        status: 'failed',
        capability: 'complete',
        node_id: 'gone-node',
        model_id: 'qwen3',
        runtime_id: 'llama',
        created_at: NOW - 60_000,
        placement_reason: 'no eligible node reported this capability',
      },
    ],
  };
  const geometry = layoutBench(state, NOW);
  assert.equal(geometry.rows.length, 12);
  assert.equal(geometry.visibleRows, 12);
  assert.ok(geometry.note);
  assert.ok(
    geometry.note.y + NOTE_H + BENCH_PAD <= geometry.height,
    'the unplaced-job note was pushed off its own canvas',
  );
  assert.ok(!geometry.caption.includes('pan to see the rest'));
});

test('the bench expands for joining nodes and contracts when inventory is removed', () => {
  const nodes = Array.from({ length: 32 }, (_, index) => ({ ...measuredNode(), node_id: `node-${index}` }));
  let previousCount = 0;
  let previousHeight = 0;
  for (const count of [1, 4, 5, 7, 32, 3]) {
    const state = fabric(nodes.slice(0, count));
    const geometry = layoutBench(state, NOW);
    assert.equal(geometry.rows.length, count);
    assert.equal(geometry.visibleRows, count);
    assert.equal(geometry.height, FIRST_LANE_Y + count * ROW_PITCH - LANE_GAP + BENCH_PAD);
    if (previousCount) {
      assert.equal(geometry.height - previousHeight, (count - previousCount) * ROW_PITCH);
    }
    assert.ok(!geometry.caption.includes('pan to see the rest'));
    assert.ok(geometry.rows.every((row) => row.y + LANE_H + BENCH_PAD <= geometry.height));
    const markup = render(state);
    assert.ok(markup.includes(`class="bench-canvas" style="height:${geometry.height}px"`));
    assert.equal((markup.match(/class="bench-lane /g) ?? []).length, count);
    previousCount = count;
    previousHeight = geometry.height;
  }
});

test('the bench says out loud when the summary and the lanes disagree', () => {
  const state = fabric([measuredNode()], { resident_models: 0, prefix_candidates: 9 });
  const totals = benchTotals(state, NOW);
  assert.deepEqual(totals, { nodes: 1, measuredRates: 1, residentModels: 1, liveCandidates: 1 });
  const caption = benchCaption(state, NOW);
  assert.ok(caption.includes('summary says 0 resident models, rows draw 1.'));
  assert.ok(caption.includes('summary says 9 prefix candidates, rows draw 1.'));
  assert.equal(describeBench(state, NOW), 'Throughput bench. 1 node. 1 rate measured. 1 model resident.');
});

test('bench lanes and the table share demo labels without changing node identity', () => {
  const nodes = [measuredNode(), quietNode()].map((node, index) => {
    const nodeId = index === 0 ? 'peter-mac-cpu' : 'ubuntu-desktop-node';
    return { ...node, node_id: nodeId, snapshot: { ...node.snapshot, node_id: nodeId } };
  });
  const state = fabric(nodes);
  const markup = render(state);
  assert.equal(markup.match(/Portable · Local/g)?.length, 2);
  assert.equal(markup.match(/Remote · Sweden/g)?.length, 2);
  assert.deepEqual(benchRows(state, NOW).map((row) => row.nodeId), nodes.map((node) => node.node_id));
});

test('an unreadable timing block is not treated as a slow node', () => {
  const node = measuredNode();
  const bare = { ...node, snapshot: { ...node.snapshot, performance: undefined } };
  assert.deepEqual(readRate(bare, NOW), { kind: 'unmeasured', reason: 'no-performance' });
  const nulled = {
    ...node,
    snapshot: { ...node.snapshot, performance: { ...node.snapshot.performance!, generation_tokens_per_second: null } },
  };
  assert.deepEqual(readRate(nulled, NOW), { kind: 'unmeasured', reason: 'null-rate' });
  const unmeasured = benchRows(fabric([bare]), NOW)[0];
  assert.equal(unmeasured.rate.text, 'Not measured');
  assert.equal(unmeasured.rate.lengthPx, 0);
  // A reported load is still a reported load; only an absent one hatches.
  assert.ok(unmeasured.compute[1].ratio !== null);
  const absent = benchRows(fabric([quietNode()]), NOW)[0];
  assert.equal(absent.compute[1].value, 'Not measured');
  assert.equal(absent.compute[1].ratio, null);
});
