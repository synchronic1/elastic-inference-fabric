import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FabricJob, NodeSnapshot } from '../src/contracts';
import {
  aggregateFabricState,
  InputError,
  LIMITS,
  parseTaskRequest,
  placementCandidates,
  sanitizeNodeSnapshot,
  sha256Hex,
  type SchedulableNode,
} from '../worker/domain';

function snapshot(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    schema_version: '1',
    node_id: 'node-a',
    observed_at: 1_700_000_000_000,
    uptime_seconds: 100,
    execution_scope: 'local',
    active_requests: 0,
    hardware: {
      os: 'darwin', arch: 'arm64', hostname: 'mac', cpu: 'Apple M2', logical_cpus: 8,
      physical_cpus: 4, memory_total_bytes: 16_000, gpus: [{ vendor: 'Apple', name: 'M2', memory_bytes: null, unified_memory: true }],
    },
    load: { load_average: [0.1, 0.2, 0.3], memory_available_bytes: 8_000, memory_used_percent: 50 },
    runtimes: [{
      id: 'llama', kind: 'ik_llama', mode: 'managed', state: 'ready', busy: false,
      simulated: false, loaded_model: 'model-a', prefix_cache: [], runtime_instance: 'instance-a',
      model_fingerprint: 'fingerprint-a', supports_model_switch: true, supports_cache_transfer: false,
    }],
    models: [{
      id: 'model-a', runtime: 'llama', capabilities: ['complete'], cached_on_disk: true,
      resident: true, available: true, simulated: false, fingerprint: 'fingerprint-a',
    }],
    ...overrides,
  };
}

function node(id: string, snap: NodeSnapshot, lastSeen: number, connection = `connection-${id}`): SchedulableNode {
  return { node_id: id, snapshot: snap, last_seen: lastSeen, connected: true, connection_id: connection };
}

describe('task admission', () => {
  it('accepts only the Python ExecuteRequest fields plus allow_simulated', () => {
    assert.deepEqual(parseTaskRequest({ capability: 'complete', prompt: 'hello' }), { capability: 'complete', prompt: 'hello' });
    assert.throws(
      () => parseTaskRequest({ capability: 'complete', prompt: 'hello', runtime_id: 'private' }),
      (error: unknown) => error instanceof InputError && /unknown request field/.test(error.message),
    );
    assert.throws(() => parseTaskRequest({ capability: 'complete', prompt: '', max_tokens: 1 }), InputError);
    assert.throws(() => parseTaskRequest({ capability: 'complete', prompt: 'ok', max_tokens: 1.2 }), InputError);
    assert.throws(() => parseTaskRequest({ capability: 'complete', prompt: 'ok', temperature: 2.1 }), InputError);
  });

  it('bounds prompt and prefix independently', () => {
    assert.throws(() => parseTaskRequest({ capability: 'complete', prompt: 'x'.repeat(LIMITS.promptCharacters + 1) }), InputError);
    assert.throws(() => parseTaskRequest({ capability: 'complete', prompt: 'x', prefix: 'y'.repeat(LIMITS.prefixCharacters + 1) }), InputError);
  });

  it('preserves multiline arbitrary Unicode prompt text for native templates', () => {
    const request = parseTaskRequest({ capability: 'complete', prompt: '<|im_start|>user\nこんにちは\t🌊\n<|im_end|>', prefix: 'system\r\nline 2' });
    assert.equal(request.prompt, '<|im_start|>user\nこんにちは\t🌊\n<|im_end|>');
    assert.equal(request.prefix, 'system\r\nline 2');
  });
});

describe('node snapshot sanitation', () => {
  it('normalizes Python epoch seconds and drops local paths and unknown node fields', () => {
    const raw = {
      ...snapshot(), observed_at: 1_700_000_000,
      advertise_url: 'http://192.168.0.2:8080',
      discovered_gguf: [{ path: '/Users/private/model.gguf' }],
      heartbeat: { last_error: '/private/file' },
    };
    const clean = sanitizeNodeSnapshot(raw, 'node-a');
    assert.equal(clean.observed_at, 1_700_000_000_000);
    assert.equal('advertise_url' in clean, false);
    assert.equal('discovered_gguf' in clean, false);
    assert.equal('heartbeat' in clean, false);
  });

  it('rejects a heartbeat that claims another node identity', () => {
    assert.throws(() => sanitizeNodeSnapshot(snapshot(), 'node-b'), /does not match connection/);
  });
});

describe('placement policy', () => {
  it('prefers an exact, unexpired node-local prefix candidate over another resident model', async () => {
    const now = 1_700_000_000_000;
    const prefix = 'stable system prompt';
    const digest = await sha256Hex(prefix);
    const cached = snapshot({
      node_id: 'node-b',
      runtimes: [{
        ...snapshot().runtimes[0],
        runtime_instance: 'instance-b', model_fingerprint: 'fingerprint-b',
        prefix_cache: [{
          prefix_sha256: digest, prefix_bytes: new TextEncoder().encode(prefix).byteLength,
          expires_at: now + 10_000, runtime_instance: 'instance-b', model_fingerprint: 'fingerprint-b',
          slot_id: 0, state: 'candidate', portable: false, simulated: false,
        }],
      }],
      models: [{ ...snapshot().models[0], fingerprint: 'fingerprint-b' }],
    });
    const candidates = placementCandidates(
      [node('node-a', snapshot(), now), node('node-b', cached, now)],
      { capability: 'complete', prompt: 'request', prefix }, digest,
      new TextEncoder().encode(prefix).byteLength, new Set(), now,
    );
    assert.equal(candidates[0].node_id, 'node-b');
    assert.equal(candidates[0].prefix_match, true);
    assert.match(candidates[0].placement_reason, /prefix/);
  });

  it('does not route to stale, simulated, busy, or reserved runtimes by default', () => {
    const now = 1_700_000_000_000;
    const stale = node('stale', { ...snapshot(), node_id: 'stale' }, now - LIMITS.staleAfterMs - 1);
    const simulatedSnapshot = snapshot({
      node_id: 'sim',
      runtimes: [{ ...snapshot().runtimes[0], simulated: true }],
      models: [{ ...snapshot().models[0], simulated: true }],
    });
    const simulated = node('sim', simulatedSnapshot, now);
    const busySnapshot = snapshot({ node_id: 'busy', runtimes: [{ ...snapshot().runtimes[0], busy: true }] });
    const busy = node('busy', busySnapshot, now);
    const reserved = node('reserved', { ...snapshot(), node_id: 'reserved', active_requests: 0 }, now);
    const result = placementCandidates(
      [stale, simulated, busy, reserved], { capability: 'complete', prompt: 'request' }, null, 0,
      new Set(['reserved\u0000llama']), now,
    );
    assert.deepEqual(result, []);
    assert.equal(placementCandidates([simulated], { capability: 'complete', prompt: 'request', allow_simulated: true }, null, 0, new Set(), now).length, 1);
  });

  it('uses durable reservations rather than the advisory heartbeat request count', () => {
    const now = 1_700_000_000_000;
    const advisoryBusy = snapshot({ active_requests: 99 });
    assert.equal(placementCandidates([node('node-a', advisoryBusy, now)], { capability: 'complete', prompt: 'x' }, null, 0, new Set(), now).length, 1);
  });
});

describe('inventory aggregation', () => {
  it('counts resources and capabilities only from online nodes', () => {
    const now = 1_700_000_000_000;
    const online = { node_id: 'node-a', snapshot: snapshot(), last_seen: now, connected: true };
    const stale = { node_id: 'node-stale', snapshot: { ...snapshot(), node_id: 'node-stale' }, last_seen: now - 31_000, connected: true };
    const offline = { node_id: 'node-offline', snapshot: { ...snapshot(), node_id: 'node-offline' }, last_seen: now, connected: false };
    const state = aggregateFabricState([online, stale, offline], [] as FabricJob[], now);
    assert.equal(state.summary.total_nodes, 3);
    assert.equal(state.summary.online_nodes, 1);
    assert.equal(state.summary.logical_cpus, 8);
    assert.equal(state.summary.gpu_count, 1);
    assert.deepEqual(state.capabilities, [{ name: 'complete', nodes: 1, available_models: 1, resident_models: 1 }]);
    assert.deepEqual(state.nodes.map((item) => item.status), ['online', 'offline', 'stale']);
  });
});
