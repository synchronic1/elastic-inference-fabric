// Pure data layer for the throughput bench: no DOM, no React, no clock.
// `now` is always a parameter, so every reading is byte-identical across runs
// and directly assertable without a browser.
//
// The one rule this module exists to enforce: a node with no measured timing
// reads "Not measured" and never draws a zero-length bar. Lengths come from
// `rateToLength` and nothing else, so no call site can invent a rate.
import type { FabricJob, FabricNode, FabricState } from '../contracts';

// Mirrors worker/domain.ts LIMITS.staleAfterMs; the worker marks a node stale
// when now - last_seen > this, so eligibility is inclusive of the boundary.
export const STALE_AFTER_MS = 30_000;
// A measurement does not expire, but a reading older than this is labelled.
export const STALE_READ_MS = 5 * 60 * 1000;

export const BENCH_PAD = 12;
export const AXIS_H = 44;
export const GROUP_H = 34;
export const INTAKE_W = 140;
// The gutter is the wiring channel between the intake columns and the lane
// boxes; bench.css runs the three link rails down the middle of it.
export const GUTTER_W = 46;
// Room to the right of the lane boxes for the return rail, which
// getSmoothStepPath places 20px out from the last lane's right handle.
export const RIGHT_RAIL_PAD = 40;
export const LANE_W = 1008;
export const LANE_H = 240;
export const LANE_GAP = 10;
export const NOTE_H = 64;
export const MODEL_CHIP_LIMIT = 6;
export const RUNTIME_CHIP_LIMIT = 4;
export const MAX_PARTICLES = 3;

export const LANE_X = BENCH_PAD + INTAKE_W + GUTTER_W; // 198
export const CONTENT_W = LANE_X + LANE_W + BENCH_PAD + RIGHT_RAIL_PAD; // 1258
export const AXIS_X = LANE_X + 282; // 480
export const AXIS_W = 520;
export const AXIS_Y = BENCH_PAD; // 12
export const GROUP_Y = AXIS_Y + AXIS_H + 8; // 64
export const FIRST_LANE_Y = GROUP_Y + GROUP_H + 8; // 106
export const ROW_PITCH = LANE_H + LANE_GAP; // 250
export const BODY_H = 88; // minimum; long hardware/model names may wrap
export const PLOT_Y = 20; // lane-local top of the body band
export const PLOT_W = 520;
// ACCELERATOR runs to the lane's right edge minus the 12px pad, so the three
// lane columns are 256 / 520 / 180 with 14px gaps inside a 984px band.
export const ACCEL_W = 180;
export const NOT_MEASURED = 'Not measured';
export const RATE_DISCLOSURE = 'last measured — not a capacity ceiling';

const DEMO_CAPTION =
  'Sign in to reveal live nodes, measured token rates and accelerator inventory. ' +
  'Nothing on this panel is illustrative of real hardware.';
const EMPTY_CAPTION = 'No nodes have reported yet.';

export type RateReading =
  | {
      kind: 'measured';
      tokPerSecond: number;
      promptTokPerSecond: number | null;
      samples: number;
      observedAt: number | null;
      modelId: string | null;
      runtimeId: string | null;
      stale: boolean;
    }
  | {
      kind: 'unmeasured';
      reason: 'no-performance' | 'null-rate' | 'simulated-runtime' | 'zero-samples';
    };

export type AcceleratorState = 'quantified' | 'unified' | 'unspecified';

export interface BenchMicroBar {
  name: 'CPU' | 'LOAD' | 'MEM';
  value: string;
  // Sub-line, or the full load triple as a title. Null when there is nothing
  // more to say than `value` already says.
  detail: string | null;
  // Null renders a hatched track. It is never flattened to 0: an unmeasured
  // reading and a measured zero are different facts.
  ratio: number | null;
  unifiedWithGpu?: boolean;
}

export interface BenchRateCell {
  kind: RateReading['kind'];
  text: string;
  lengthPx: number;
  stale: boolean;
  modelText: string;
  sampleText: string;
  recencyText: string;
  disclosure: string | null;
}

export interface BenchAccelerator {
  vendor: string;
  name: string;
  state: AcceleratorState;
  caption: string;
}

export interface BenchRow {
  nodeId: string;
  status: FabricNode['status'];
  y: number;
  working: boolean;
  inFlight: number;
  inFlightText: string;
  rate: BenchRateCell;
  compute: BenchMicroBar[];
  accelerators: BenchAccelerator[];
  modelChips: { id: string; state: 'resident' | 'cached' | 'unprovisioned'; word: string }[];
  modelOverflow: number;
  modelsEmpty: boolean;
  runtimeChips: { id: string; label: string; busy: boolean; simulated: boolean }[];
  runtimeOverflow: number;
  runtimesEmpty: boolean;
  heartbeatText: string;
  uptimeText: string;
  prefixText: string;
  prefixDisclosure: string | null;
  promptRateText: string;
  cacheTransferText: string;
  drain: { filled: number; total: number; eligible: boolean; ageMs: number };
}

export interface BenchGeometry {
  width: number;
  height: number;
  rows: { nodeId: string; y: number }[];
  axis: { x: number; y: number; w: number; h: number };
  group: { x: number; y: number; w: number; h: number };
  note: { x: number; y: number; w: number; h: number } | null;
  visibleRows: number;
  caption: string;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// `performance` is optional on the wire but always present in the type; read it
// through one accessor so no call site has to remember that.
function performance(node: FabricNode): NonNullable<FabricNode['snapshot']['performance']> | null {
  return node.snapshot.performance ?? null;
}

export function readRate(node: FabricNode, now: number): RateReading {
  const p = performance(node);
  if (!p) return { kind: 'unmeasured', reason: 'no-performance' };
  if (!finite(p.generation_tokens_per_second)) return { kind: 'unmeasured', reason: 'null-rate' };
  if (!finite(p.samples) || p.samples <= 0) return { kind: 'unmeasured', reason: 'zero-samples' };
  const runtime = p.runtime_id
    ? node.snapshot.runtimes.find((item) => item.id === p.runtime_id)
    : undefined;
  if (runtime?.simulated) return { kind: 'unmeasured', reason: 'simulated-runtime' };
  const observedAt = finite(p.last_observed_at) ? p.last_observed_at : null;
  return {
    kind: 'measured',
    tokPerSecond: p.generation_tokens_per_second,
    promptTokPerSecond: finite(p.prompt_tokens_per_second) ? p.prompt_tokens_per_second : null,
    samples: p.samples,
    observedAt,
    modelId: p.model_id ?? null,
    runtimeId: p.runtime_id ?? null,
    stale: observedAt !== null && now - observedAt > STALE_READ_MS,
  };
}

// The only function permitted to produce a generation-rate string, so an
// unmeasured node can never render as "0.0 tok/s".
export function formatRate(reading: RateReading): string {
  return reading.kind === 'measured' ? `${reading.tokPerSecond.toFixed(1)} tok/s` : NOT_MEASURED;
}

// The prompt rate is formatted separately so prefill and decode can never be
// printed as one summed figure.
export function formatTokensPerSecond(value: number | null): string {
  return finite(value) ? `${value.toFixed(1)} tok/s` : 'prompt not measured';
}

export function formatSampleCount(samples: number): string {
  if (!finite(samples)) return 'sample count not reported';
  const noun = `${samples}-token sample`;
  return samples < 4 ? `from a ${noun} (single request)` : `from a ${noun}`;
}

export function formatRecency(at: number | null, now: number): string {
  if (!finite(at)) return 'time not reported';
  const seconds = Math.floor((now - at) / 1000);
  if (!Number.isFinite(seconds) || seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function formatUptime(seconds: number): string {
  if (!finite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days}d`;
  const hours = Math.floor(total / 3600);
  if (hours > 0) return `${hours}h ${Math.floor((total % 3600) / 60)}m`;
  return `${Math.floor(total / 60)}m`;
}

// Matches App.tsx bytes() so both surfaces print bytes the same way, except
// that an absent capacity reads as words rather than a dash.
export function formatBytes(value: number | null): string {
  if (!finite(value) || value < 0) return 'not reported';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let unit = 0;
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024;
    unit += 1;
  }
  return `${n >= 10 || unit === 0 ? n.toFixed(0) : n.toFixed(1)} ${units[unit]}`;
}

export function formatCount(value: number | null | undefined): string {
  return finite(value) ? String(value) : 'none reported';
}

export function statusTone(status: FabricNode['status']): 'online' | 'stale' | 'offline' {
  return status;
}

export interface HeartbeatDrain {
  filled: number;
  total: number;
  eligible: boolean;
  ageMs: number;
}

// Six segments over the 30s eligibility window: each elapsed 5s consumes one,
// so an empty drain and an ineligible node are the same fact. The segments
// reinforce the printed age; they never carry it alone.
export function heartbeatDrain(
  node: { status: FabricNode['status']; last_seen: number },
  now: number,
  segments = 6,
): HeartbeatDrain {
  const ageMs = Math.max(0, now - node.last_seen);
  const filled = Math.min(segments, Math.max(0, segments - Math.floor(ageMs / (STALE_AFTER_MS / segments))));
  return { filled, total: segments, eligible: ageMs <= STALE_AFTER_MS, ageMs };
}

export function drainSegments(drain: HeartbeatDrain, segments = 6): boolean[] {
  return Array.from({ length: segments }, (_, index) => index < drain.filled);
}

export function computeScales(nodes: FabricNode[]): {
  maxLogicalCpus: number;
  maxMemoryUsedPercent: number;
} {
  const cpus = nodes.map((node) => node.snapshot.hardware.logical_cpus).filter(finite);
  const percents = nodes.map((node) => node.snapshot.load.memory_used_percent).filter(finite);
  return {
    maxLogicalCpus: Math.max(1, ...cpus),
    maxMemoryUsedPercent: Math.max(1, ...percents),
  };
}

export function cpuBar(
  node: FabricNode,
  scales: { maxLogicalCpus: number },
): { ratio: number; label: string } | null {
  const cpus = node.snapshot.hardware.logical_cpus;
  if (!finite(cpus) || cpus <= 0) return null;
  return { ratio: Math.min(1, cpus / scales.maxLogicalCpus), label: `${cpus} threads` };
}

export function loadBar(
  node: FabricNode,
): { ratio: number; label: string; detail: string } | null {
  const average = node.snapshot.load.load_average;
  if (!Array.isArray(average) || !average.length || !finite(average[0])) return null;
  const cpus = node.snapshot.hardware.logical_cpus;
  const denominator = finite(cpus) && cpus > 0 ? cpus : 1;
  return {
    ratio: Math.max(0, Math.min(1, average[0] / denominator)),
    label: `${average[0].toFixed(2)}x`,
    detail: average.map((value) => (finite(value) ? value.toFixed(2) : '—')).join(' · '),
  };
}

export function memoryBar(node: FabricNode): {
  ratio: number;
  label: string;
  detail: string;
  unifiedWithGpu: boolean;
} {
  const percent = node.snapshot.load.memory_used_percent;
  const unifiedWithGpu = node.snapshot.hardware.gpus.some((gpu) => gpu.unified_memory === true);
  return {
    ratio: finite(percent) ? Math.max(0, Math.min(1, percent / 100)) : 0,
    label: finite(percent) ? `${percent.toFixed(0)}%` : '—',
    detail: `${formatBytes(node.snapshot.load.memory_available_bytes)} free of ${formatBytes(node.snapshot.hardware.memory_total_bytes)}`,
    unifiedWithGpu,
  };
}

// Absent accelerator memory is ambiguous on the wire, so the three states are
// read apart: pooled with system RAM is a fact, not an absence.
export function acceleratorMemoryState(gpu: {
  memory_bytes: number | null;
  unified_memory?: boolean;
}): AcceleratorState {
  if (finite(gpu.memory_bytes)) return 'quantified';
  return gpu.unified_memory === true ? 'unified' : 'unspecified';
}

export function acceleratorCaption(state: AcceleratorState, memoryBytes: number | null): string {
  if (state === 'quantified') return `${formatBytes(memoryBytes)} reported`;
  if (state === 'unified') return 'shared with the system RAM pool (unified memory)';
  return 'capacity not reported';
}

export function acceleratorRead(node: FabricNode): BenchAccelerator[] {
  return node.snapshot.hardware.gpus.map((gpu) => {
    const state = acceleratorMemoryState(gpu);
    return {
      vendor: gpu.vendor,
      name: gpu.name,
      state,
      caption: acceleratorCaption(state, gpu.memory_bytes),
    };
  });
}

// `cached_on_disk` is not residency, so it gets its own words rather than
// borrowing "available".
export function modelChips(
  node: FabricNode,
  limit = MODEL_CHIP_LIMIT,
): {
  chips: { id: string; state: 'resident' | 'cached' | 'unprovisioned'; word: string }[];
  overflow: number;
  empty: boolean;
} {
  const models = node.snapshot.models;
  const chips = models.slice(0, limit).map((model) => {
    if (model.resident) return { id: model.id, state: 'resident' as const, word: 'resident' };
    if (model.cached_on_disk) {
      return { id: model.id, state: 'cached' as const, word: 'on disk, not loaded' };
    }
    return { id: model.id, state: 'unprovisioned' as const, word: 'not provisioned' };
  });
  return { chips, overflow: Math.max(0, models.length - limit), empty: models.length === 0 };
}

export function runtimeChips(
  node: FabricNode,
  limit = RUNTIME_CHIP_LIMIT,
): {
  chips: { id: string; label: string; busy: boolean; simulated: boolean }[];
  overflow: number;
  empty: boolean;
} {
  const runtimes = node.snapshot.runtimes;
  return {
    chips: runtimes.slice(0, limit).map((runtime) => ({
      id: runtime.id,
      label: `${runtime.kind} · ${runtime.state}`,
      busy: runtime.busy,
      simulated: runtime.simulated,
    })),
    overflow: Math.max(0, runtimes.length - limit),
    empty: runtimes.length === 0,
  };
}

// Counts only unexpired candidates, matching the worker's own summary, and the
// disclosure only appears when there is a number to disclaim.
export function prefixNote(
  node: FabricNode,
  now: number,
): { count: number; newestExpiresInSeconds: number | null; disclosure: string | null } {
  const live = node.snapshot.runtimes
    .flatMap((runtime) => runtime.prefix_cache)
    .filter((candidate) => finite(candidate.expires_at) && candidate.expires_at > now);
  if (!live.length) return { count: 0, newestExpiresInSeconds: null, disclosure: null };
  const newest = Math.max(...live.map((candidate) => candidate.expires_at));
  return {
    count: live.length,
    newestExpiresInSeconds: Math.max(0, Math.round((newest - now) / 1000)),
    disclosure: 'hashes/locality hints — not portable KV state and not measured cache hits',
  };
}

// The smallest 1-2-5 rung STRICTLY greater than the largest rate, so no bar can
// ever reach the end of its own track and read as a capacity ceiling.
export function axisCeiling(rates: number[]): number {
  const max = Math.max(...rates.filter((rate) => finite(rate) && rate >= 0), 0);
  if (!(max > 0)) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  for (const step of [1, 2, 5, 10]) {
    const rung = step * magnitude;
    if (rung > max) return Number(rung.toFixed(10));
  }
  return max * 2;
}

export function axisTicks(
  ceiling: number,
  plotPx = PLOT_W,
): { value: number; x: number; label: string }[] {
  // A ceiling of 1 is what axisCeiling returns when nothing was measured, so
  // the ruler is present but explicitly empty rather than scaled to a guess.
  if (!finite(ceiling) || ceiling <= 1) return [{ value: 1, x: plotPx, label: '1' }];
  // The ruler is read by eye, so it is divided into at most five evenly spaced
  // steps. The 1-2-5 rungs that pick the CEILING are the wrong ticks: on a
  // linear axis 1, 2, 5, 10, 20 … bunch into the left tenth of the track and
  // the rest of the ruler carries no labels at all. The step is the first
  // round number at or above a fifth of the ceiling, so every label is short.
  const target = ceiling / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const step = [1, 2, 2.5, 5, 10].map((nice) => nice * magnitude).find((nice) => nice >= target) ?? ceiling;
  const values: number[] = [];
  for (let value = step; value <= ceiling * 1.0000001; value += step) {
    values.push(Number(value.toFixed(10)));
  }
  if (!values.length) values.push(ceiling);
  return values.map((value) => ({
    value,
    x: Number(((value / ceiling) * plotPx).toFixed(2)),
    label: String(Number(value.toFixed(4))),
  }));
}

export function rateToLength(rate: number, ceiling: number, plotPx = PLOT_W): number {
  if (!finite(rate) || rate <= 0 || !finite(ceiling) || ceiling <= 0) return 0;
  return Math.min(plotPx, (rate / ceiling) * plotPx);
}

// The shared ruler's ceiling, derived from the readings the rows will draw, so
// the axis and the bars can never be computed from different numbers.
export function benchCeiling(fabric: FabricState | null, now: number): number {
  if (!fabric) return 1;
  return axisCeiling(
    fabric.nodes.map((node) => {
      const reading = readRate(node, now);
      return reading.kind === 'measured' ? reading.tokPerSecond : NaN;
    }),
  );
}

export function benchUnplaced(jobs: FabricJob[], nodes: FabricNode[]): FabricJob[] {
  const known = new Set(nodes.map((node) => node.node_id));
  return jobs.filter((job) => !known.has(job.node_id));
}

export function benchFlags(reading: RateReading): {
  notMeasured: boolean;
  smallSample: boolean;
  stale: boolean;
  disclosure: string | null;
} {
  if (reading.kind === 'unmeasured') {
    return { notMeasured: true, smallSample: false, stale: false, disclosure: null };
  }
  return {
    notMeasured: false,
    smallSample: reading.samples < 4,
    stale: reading.stale,
    disclosure: RATE_DISCLOSURE,
  };
}

function sortedNodes(fabric: FabricState | null): FabricNode[] {
  // The same total order the worker uses, so a node can never teleport between
  // polls; a node appearing shifts everything below it down by one row.
  return [...(fabric?.nodes ?? [])].sort((a, b) => a.node_id.localeCompare(b.node_id));
}

function rateCell(reading: RateReading, ceiling: number, now: number): BenchRateCell {
  if (reading.kind === 'unmeasured') {
    return {
      kind: 'unmeasured',
      text: NOT_MEASURED,
      lengthPx: 0,
      stale: false,
      modelText: 'no timing has been reported for this node',
      sampleText: '',
      recencyText: 'time not reported',
      disclosure: null,
    };
  }
  return {
    kind: 'measured',
    text: formatRate(reading),
    lengthPx: rateToLength(reading.tokPerSecond, ceiling),
    stale: reading.stale,
    modelText: `generated · ${reading.modelId ?? 'model not reported'}`,
    sampleText: formatSampleCount(reading.samples),
    recencyText: formatRecency(reading.observedAt, now),
    disclosure: RATE_DISCLOSURE,
  };
}

export function benchRows(fabric: FabricState | null, now: number): BenchRow[] {
  if (!fabric || !fabric.nodes.length) return [];
  const nodes = sortedNodes(fabric);
  const scales = computeScales(nodes);
  const ceiling = benchCeiling(fabric, now);

  return nodes.map((node, index) => {
    const snapshot = node.snapshot;
    const reading = readRate(node, now);
    const cpu = cpuBar(node, scales);
    const load = loadBar(node);
    const memory = memoryBar(node);
    const models = modelChips(node);
    const runtimes = runtimeChips(node);
    const prefix = prefixNote(node, now);
    const drain = heartbeatDrain(node, now);

    const compute: BenchMicroBar[] = [
      {
        name: 'CPU',
        value: cpu ? cpu.label : 'none reported',
        detail: null,
        ratio: cpu ? cpu.ratio : null,
      },
      {
        name: 'LOAD',
        value: load ? load.label : NOT_MEASURED,
        detail: load ? load.detail : null,
        ratio: load ? load.ratio : null,
      },
      {
        name: 'MEM',
        value: memory.label,
        detail: memory.detail,
        ratio: memory.ratio,
        unifiedWithGpu: memory.unifiedWithGpu,
      },
    ];

    return {
      nodeId: node.node_id,
      status: statusTone(node.status),
      y: FIRST_LANE_Y + index * ROW_PITCH,
      working: node.status === 'online' && snapshot.active_requests > 0,
      inFlight: snapshot.active_requests,
      inFlightText: `${snapshot.active_requests} in flight`,
      rate: rateCell(reading, ceiling, now),
      compute,
      accelerators: acceleratorRead(node),
      modelChips: models.chips,
      modelOverflow: models.overflow,
      modelsEmpty: models.empty,
      runtimeChips: runtimes.chips,
      runtimeOverflow: runtimes.overflow,
      runtimesEmpty: runtimes.empty,
      heartbeatText: `last heartbeat ${formatRecency(node.last_seen, now)}`,
      uptimeText: `up ${formatUptime(snapshot.uptime_seconds)}`,
      prefixText: runtimes.empty
        ? 'prefix candidates not reported'
        : `${prefix.count} prefix candidates${prefix.newestExpiresInSeconds === null ? '' : ` · newest expires in ${prefix.newestExpiresInSeconds}s`}`,
      prefixDisclosure: prefix.disclosure,
      promptRateText: `prompt ${formatTokensPerSecond(
        reading.kind === 'measured' ? reading.promptTokPerSecond : null,
      )}`,
      cacheTransferText: snapshot.runtimes.some((runtime) => runtime.supports_cache_transfer)
        ? 'cache transfer supported'
        : 'cache transfer not supported',
      drain,
    };
  });
}

export function benchTotals(
  fabric: FabricState | null,
  now: number,
): { nodes: number; measuredRates: number; residentModels: number; liveCandidates: number } {
  const nodes = fabric?.nodes ?? [];
  let measuredRates = 0;
  let residentModels = 0;
  let liveCandidates = 0;
  for (const node of nodes) {
    if (readRate(node, now).kind === 'measured') measuredRates += 1;
    residentModels += node.snapshot.models.filter((model) => model.resident).length;
    liveCandidates += prefixNote(node, now).count;
  }
  return { nodes: nodes.length, measuredRates, residentModels, liveCandidates };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function layoutBench(fabric: FabricState | null, now: number): BenchGeometry {
  const axis = { x: AXIS_X, y: AXIS_Y, w: AXIS_W, h: AXIS_H };
  const group = { x: LANE_X, y: GROUP_Y, w: LANE_W, h: GROUP_H };
  const base: BenchGeometry = {
    width: CONTENT_W,
    height: 240,
    rows: [],
    axis,
    group,
    note: null,
    visibleRows: 0,
    caption: DEMO_CAPTION,
  };
  if (!fabric) return base;
  if (!fabric.nodes.length) return { ...base, caption: EMPTY_CAPTION };

  const rows = benchRows(fabric, now);
  const count = rows.length;
  const note = benchUnplaced(fabric.jobs ?? [], fabric.nodes).length
    ? { x: LANE_X, y: FIRST_LANE_Y + count * ROW_PITCH, w: LANE_W, h: NOTE_H }
    : null;
  const natural =
    FIRST_LANE_Y + count * LANE_H + (count - 1) * LANE_GAP + BENCH_PAD + (note ? NOTE_H + LANE_GAP : 0);
  // Grow the page with the inventory. Every reported node gets a complete
  // lane; joining nodes must not disappear behind a fixed-height pan window.
  const geometry: BenchGeometry = {
    ...base,
    height: natural,
    rows: rows.map((row) => ({ nodeId: row.nodeId, y: row.y })),
    note,
    visibleRows: count,
    caption: EMPTY_CAPTION,
  };
  return { ...geometry, caption: benchCaption(fabric, now) };
}

export function benchCaption(fabric: FabricState | null, now: number): string {
  if (!fabric) return DEMO_CAPTION;
  if (!fabric.nodes.length) return EMPTY_CAPTION;
  const totals = benchTotals(fabric, now);
  const parts = [
    `${plural(totals.nodes, 'node')}, ${plural(totals.measuredRates, 'rate')} measured, ` +
      `${plural(totals.residentModels, 'model')} resident.`,
    'Bars share one scale and the ruler runs past the longest bar: length is the measurement, ' +
      'and every reading is last measured — not a capacity ceiling.',
    'Results return through the router — results are not streamed.',
  ];
  if (fabric.summary.resident_models !== totals.residentModels) {
    parts.push(
      `summary says ${fabric.summary.resident_models} resident models, rows draw ${totals.residentModels}.`,
    );
  }
  if (fabric.summary.prefix_candidates !== totals.liveCandidates) {
    parts.push(
      `summary says ${fabric.summary.prefix_candidates} prefix candidates, rows draw ${totals.liveCandidates}.`,
    );
  }
  return parts.join(' ');
}

export function describeBench(fabric: FabricState | null, now: number): string {
  if (!fabric) return `Throughput bench. ${DEMO_CAPTION}`;
  const totals = benchTotals(fabric, now);
  return (
    `Throughput bench. ${plural(totals.nodes, 'node')}. ` +
    `${plural(totals.measuredRates, 'rate')} measured. ` +
    `${plural(totals.residentModels, 'model')} resident.`
  );
}
