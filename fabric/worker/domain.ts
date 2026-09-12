import type {
  FabricJob,
  FabricNode,
  FabricState,
  ModelSnapshot,
  NodeSnapshot,
  PrefixCandidate,
  RuntimeSnapshot,
  TaskRequest,
} from '../src/contracts';

export const LIMITS = {
  requestBytes: 160 * 1024,
  promptCharacters: 65_536,
  prefixCharacters: 65_536,
  snapshotBytes: 512 * 1024,
  resultBytes: 1024 * 1024,
  socketMessageBytes: 1100 * 1024,
  jobsReturned: 100,
  jobRetentionMs: 24 * 60 * 60 * 1000,
  nodeRetentionMs: 7 * 24 * 60 * 60 * 1000,
  staleAfterMs: 30_000,
  jobTimeoutMs: 180_000,
} as const;

export class InputError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type JsonObject = Record<string, unknown>;

export interface StoredNodeView {
  node_id: string;
  last_seen: number;
  snapshot: NodeSnapshot;
  connected: boolean;
}

export interface Placement {
  node_id: string;
  runtime_id: string;
  model_id: string;
  connection_id: string;
  reservation_key: string;
  placement_reason: string;
  prefix_match: boolean;
  resident: boolean;
  simulated: boolean;
}

export interface SchedulableNode extends StoredNodeView {
  connection_id: string;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new InputError(`${label} must be ${allowEmpty ? 'at most' : 'between 1 and'} ${max} characters`);
  }
  if (/\p{Cc}/u.test(value)) throw new InputError(`${label} contains control characters`);
  return value;
}

function promptText(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new InputError(`${label} must be ${allowEmpty ? 'at most' : 'between 1 and'} ${max} characters`);
  }
  return value;
}

function number(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new InputError(`${label} must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new InputError(`${label} must be boolean`);
  return value;
}

function optionalString(value: unknown, label: string, max: number): string | undefined {
  return value === undefined ? undefined : string(value, label, max);
}

function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new InputError(`${label} must be an array with at most ${max} entries`);
  return value;
}

function epochMilliseconds(value: unknown, label: string): number {
  const timestamp = number(value, label, 0);
  // Dendrite's current Python snapshot uses time.time(); normalize that handoff.
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

export function validNodeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function validJobId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
}

export function parseTaskRequest(raw: unknown): TaskRequest {
  const value = object(raw, 'request');
  const allowed = new Set(['capability', 'prompt', 'prefix', 'model_id', 'max_tokens', 'temperature', 'allow_simulated']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new InputError(`unknown request field: ${key}`);
  }
  const request: TaskRequest = {
    capability: string(value.capability, 'capability', 128),
    prompt: promptText(value.prompt, 'prompt', LIMITS.promptCharacters),
  };
  if (value.prefix !== undefined) request.prefix = promptText(value.prefix, 'prefix', LIMITS.prefixCharacters, true);
  if (value.model_id !== undefined) request.model_id = string(value.model_id, 'model_id', 256);
  if (value.max_tokens !== undefined) {
    const amount = number(value.max_tokens, 'max_tokens', 1, 4096);
    if (!Number.isInteger(amount)) throw new InputError('max_tokens must be an integer');
    request.max_tokens = amount;
  }
  if (value.temperature !== undefined) request.temperature = number(value.temperature, 'temperature', 0, 2);
  if (value.allow_simulated !== undefined) request.allow_simulated = boolean(value.allow_simulated, 'allow_simulated');
  return request;
}

function sanitizePrefix(raw: unknown): PrefixCandidate {
  const value = object(raw, 'prefix candidate');
  const digest = string(value.prefix_sha256, 'prefix_sha256', 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new InputError('prefix_sha256 must be a SHA-256 hex digest');
  if (value.state !== 'candidate' || value.portable !== false) throw new InputError('unsupported prefix candidate state');
  return {
    prefix_sha256: digest,
    prefix_bytes: number(value.prefix_bytes, 'prefix_bytes', 0, LIMITS.prefixCharacters * 4),
    expires_at: epochMilliseconds(value.expires_at, 'expires_at'),
    runtime_instance: string(value.runtime_instance, 'runtime_instance', 256),
    model_fingerprint: string(value.model_fingerprint, 'model_fingerprint', 512),
    slot_id: number(value.slot_id, 'slot_id', 0, 1024),
    state: 'candidate',
    portable: false,
    simulated: boolean(value.simulated, 'simulated'),
  };
}

function sanitizeRuntime(raw: unknown): RuntimeSnapshot {
  const value = object(raw, 'runtime');
  return {
    id: string(value.id, 'runtime.id', 256),
    kind: string(value.kind, 'runtime.kind', 64),
    mode: string(value.mode, 'runtime.mode', 64),
    state: string(value.state, 'runtime.state', 64),
    busy: boolean(value.busy, 'runtime.busy'),
    simulated: boolean(value.simulated, 'runtime.simulated'),
    loaded_model: value.loaded_model === null ? null : string(value.loaded_model, 'runtime.loaded_model', 256),
    prefix_cache: array(value.prefix_cache, 'runtime.prefix_cache', 8).map(sanitizePrefix),
    runtime_instance: string(value.runtime_instance, 'runtime.runtime_instance', 256),
    model_fingerprint: value.model_fingerprint === null ? null : string(value.model_fingerprint, 'runtime.model_fingerprint', 512),
    supports_model_switch: boolean(value.supports_model_switch, 'runtime.supports_model_switch'),
    supports_cache_transfer: boolean(value.supports_cache_transfer, 'runtime.supports_cache_transfer'),
  };
}

function sanitizeModel(raw: unknown): ModelSnapshot {
  const value = object(raw, 'model');
  const model: ModelSnapshot = {
    id: string(value.id, 'model.id', 256),
    runtime: string(value.runtime, 'model.runtime', 256),
    capabilities: array(value.capabilities, 'model.capabilities', 32).map((item) => string(item, 'model.capability', 128)),
    cached_on_disk: boolean(value.cached_on_disk, 'model.cached_on_disk'),
    resident: boolean(value.resident, 'model.resident'),
    available: boolean(value.available, 'model.available'),
    simulated: boolean(value.simulated, 'model.simulated'),
  };
  if (value.size_bytes !== undefined) model.size_bytes = number(value.size_bytes, 'model.size_bytes');
  if (value.fingerprint !== undefined) {
    model.fingerprint = value.fingerprint === null ? null : string(value.fingerprint, 'model.fingerprint', 512);
  }
  return model;
}

function sanitizePerformance(raw: unknown): NonNullable<NodeSnapshot['performance']> {
  const value = object(raw, 'performance');
  const generation = value.generation_tokens_per_second;
  const prompt = value.prompt_tokens_per_second;
  const samples = number(value.samples, 'performance.samples', 0, 1_000_000_000);
  if (!Number.isInteger(samples)) throw new InputError('performance.samples must be an integer');
  return {
    generation_tokens_per_second: generation === null
      ? null
      : number(generation, 'performance.generation_tokens_per_second', 0, 1_000_000_000),
    prompt_tokens_per_second: prompt === null
      ? null
      : number(prompt, 'performance.prompt_tokens_per_second', 0, 1_000_000_000),
    samples,
    last_observed_at: value.last_observed_at === null
      ? null
      : epochMilliseconds(value.last_observed_at, 'performance.last_observed_at'),
    model_id: value.model_id === null ? null : string(value.model_id, 'performance.model_id', 256),
    runtime_id: value.runtime_id === null ? null : string(value.runtime_id, 'performance.runtime_id', 256),
  };
}

export function sanitizeNodeSnapshot(raw: unknown, expectedNodeId: string): NodeSnapshot {
  const value = object(raw, 'snapshot');
  if (!validNodeId(value.node_id) || value.node_id !== expectedNodeId) throw new InputError('snapshot node_id does not match connection');
  const hardware = object(value.hardware, 'hardware');
  const load = object(value.load, 'load');
  const loadAverage = load.load_average === null
    ? null
    : array(load.load_average, 'load.load_average', 3).map((item) => number(item, 'load average', 0, 1_000_000));
  return {
    schema_version: string(value.schema_version, 'schema_version', 16),
    node_id: value.node_id,
    observed_at: epochMilliseconds(value.observed_at, 'observed_at'),
    uptime_seconds: number(value.uptime_seconds, 'uptime_seconds'),
    execution_scope: string(value.execution_scope, 'execution_scope', 64),
    active_requests: number(value.active_requests, 'active_requests', 0, 1024),
    ...(value.performance === undefined ? {} : { performance: sanitizePerformance(value.performance) }),
    hardware: {
      os: string(hardware.os, 'hardware.os', 128),
      arch: string(hardware.arch, 'hardware.arch', 128),
      hostname: string(hardware.hostname, 'hardware.hostname', 256),
      cpu: string(hardware.cpu, 'hardware.cpu', 512, true),
      logical_cpus: number(hardware.logical_cpus, 'hardware.logical_cpus', 0, 65_536),
      physical_cpus: hardware.physical_cpus === null ? null : number(hardware.physical_cpus, 'hardware.physical_cpus', 0, 65_536),
      memory_total_bytes: number(hardware.memory_total_bytes, 'hardware.memory_total_bytes'),
      gpus: array(hardware.gpus, 'hardware.gpus', 16).map((rawGpu) => {
        const gpu = object(rawGpu, 'gpu');
        const result: NodeSnapshot['hardware']['gpus'][number] = {
          vendor: string(gpu.vendor, 'gpu.vendor', 128),
          name: string(gpu.name, 'gpu.name', 256),
          memory_bytes: gpu.memory_bytes === null ? null : number(gpu.memory_bytes, 'gpu.memory_bytes'),
        };
        if (gpu.unified_memory !== undefined) result.unified_memory = boolean(gpu.unified_memory, 'gpu.unified_memory');
        return result;
      }),
    },
    load: {
      load_average: loadAverage,
      memory_available_bytes: number(load.memory_available_bytes, 'load.memory_available_bytes'),
      memory_used_percent: number(load.memory_used_percent, 'load.memory_used_percent', 0, 100),
    },
    runtimes: array(value.runtimes, 'runtimes', 32).map(sanitizeRuntime),
    models: array(value.models, 'models', 128).map(sanitizeModel),
  };
}

export function nodeStatus(node: StoredNodeView, now: number): FabricNode['status'] {
  if (!node.connected) return 'offline';
  return now - node.last_seen > LIMITS.staleAfterMs ? 'stale' : 'online';
}

export function aggregateFabricState(nodes: StoredNodeView[], jobs: FabricJob[], now: number): FabricState {
  const fabricNodes: FabricNode[] = nodes.map((node) => ({
    node_id: node.node_id,
    status: nodeStatus(node, now),
    connected: node.connected,
    last_seen: node.last_seen,
    snapshot: node.snapshot,
  }));
  const online = fabricNodes.filter((node) => node.status === 'online');
  const capabilityMap = new Map<string, { nodes: Set<string>; available: number; resident: number }>();
  for (const node of online) {
    for (const model of node.snapshot.models) {
      for (const capability of new Set(model.capabilities)) {
        let item = capabilityMap.get(capability);
        if (!item) {
          item = { nodes: new Set(), available: 0, resident: 0 };
          capabilityMap.set(capability, item);
        }
        item.nodes.add(node.node_id);
        if (model.available) item.available += 1;
        if (model.resident) item.resident += 1;
      }
    }
  }
  return {
    schema_version: '1',
    generated_at: now,
    summary: {
      online_nodes: online.length,
      total_nodes: fabricNodes.length,
      logical_cpus: online.reduce((sum, node) => sum + node.snapshot.hardware.logical_cpus, 0),
      memory_total_bytes: online.reduce((sum, node) => sum + node.snapshot.hardware.memory_total_bytes, 0),
      memory_available_bytes: online.reduce((sum, node) => sum + node.snapshot.load.memory_available_bytes, 0),
      gpu_count: online.reduce((sum, node) => sum + node.snapshot.hardware.gpus.length, 0),
      resident_models: online.reduce((sum, node) => sum + node.snapshot.models.filter((model) => model.resident).length, 0),
      available_models: online.reduce((sum, node) => sum + node.snapshot.models.filter((model) => model.available).length, 0),
      prefix_candidates: online.reduce((sum, node) => sum + node.snapshot.runtimes.reduce(
        (runtimeSum, runtime) => runtimeSum + runtime.prefix_cache.filter((item) => item.expires_at > now).length,
        0,
      ), 0),
      active_requests: online.reduce((sum, node) => sum + node.snapshot.active_requests, 0),
    },
    capabilities: [...capabilityMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({
      name,
      nodes: value.nodes.size,
      available_models: value.available,
      resident_models: value.resident,
    })),
    nodes: fabricNodes.sort((a, b) => a.node_id.localeCompare(b.node_id)),
    jobs: jobs.slice(0, LIMITS.jobsReturned),
  };
}

function isValidPrefixCandidate(
  candidate: PrefixCandidate,
  runtime: RuntimeSnapshot,
  model: ModelSnapshot,
  prefixSha256: string | null,
  prefixBytes: number,
  now: number,
): boolean {
  return prefixSha256 !== null
    && candidate.prefix_sha256 === prefixSha256
    && candidate.prefix_bytes === prefixBytes
    && candidate.expires_at > now
    && candidate.runtime_instance === runtime.runtime_instance
    && runtime.loaded_model === model.id
    && runtime.model_fingerprint !== null
    && candidate.model_fingerprint === runtime.model_fingerprint
    && candidate.simulated === runtime.simulated
    && (model.fingerprint == null || candidate.model_fingerprint === model.fingerprint);
}

export function placementCandidates(
  nodes: SchedulableNode[],
  request: TaskRequest,
  prefixSha256: string | null,
  prefixBytes: number,
  reservedRuntimeKeys: Set<string>,
  now: number,
): Placement[] {
  const candidates: Placement[] = [];
  for (const node of nodes) {
    if (nodeStatus(node, now) !== 'online') continue;
    for (const model of node.snapshot.models) {
      if (!model.available || !model.capabilities.includes(request.capability)) continue;
      if (request.model_id !== undefined && request.model_id !== model.id) continue;
      const runtime = node.snapshot.runtimes.find((item) => item.id === model.runtime);
      if (!runtime || runtime.busy || !['ready', 'unloaded'].includes(runtime.state)) continue;
      if (runtime.loaded_model !== model.id && !runtime.supports_model_switch) continue;
      const simulated = runtime.simulated || model.simulated;
      if (simulated && request.allow_simulated !== true) continue;
      const reservationKey = `${node.node_id}\u0000${runtime.id}`;
      if (reservedRuntimeKeys.has(reservationKey)) continue;
      const prefixMatch = runtime.prefix_cache.some((candidate) =>
        isValidPrefixCandidate(candidate, runtime, model, prefixSha256, prefixBytes, now));
      const resident = runtime.loaded_model === model.id && model.resident;
      const reason = prefixMatch
        ? 'exact node-local prefix candidate on resident model'
        : resident
          ? 'resident idle model'
          : 'available idle model';
      candidates.push({
        node_id: node.node_id,
        runtime_id: runtime.id,
        model_id: model.id,
        connection_id: node.connection_id,
        reservation_key: reservationKey,
        placement_reason: reason,
        prefix_match: prefixMatch,
        resident,
        simulated,
      });
    }
  }
  return candidates.sort((a, b) =>
    Number(b.prefix_match) - Number(a.prefix_match)
    || Number(b.resident) - Number(a.resident)
    || Number(a.simulated) - Number(b.simulated)
    || a.node_id.localeCompare(b.node_id)
    || a.runtime_id.localeCompare(b.runtime_id));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
