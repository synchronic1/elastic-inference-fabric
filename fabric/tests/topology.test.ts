import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import FabricTopology from '../src/FabricTopology';
import type { FabricState } from '../src/contracts';

const fabric: FabricState = {
  schema_version: '1', generated_at: 1_700_000_000_000,
  summary: { online_nodes: 1, total_nodes: 2, logical_cpus: 12, memory_total_bytes: 16 * 1024 ** 3, memory_available_bytes: 8 * 1024 ** 3, gpu_count: 1, resident_models: 1, available_models: 2, prefix_candidates: 0, active_requests: 1 },
  capabilities: [], jobs: [],
  nodes: [{ node_id: 'native-mac', status: 'online', connected: true, last_seen: 1_700_000_000_000, snapshot: { schema_version: '1', node_id: 'native-mac', observed_at: 1_700_000_000_000, uptime_seconds: 4, execution_scope: 'local', active_requests: 1, hardware: { os: 'macOS', arch: 'arm64', hostname: 'studio', cpu: 'Apple', logical_cpus: 12, physical_cpus: 8, memory_total_bytes: 16 * 1024 ** 3, gpus: [{ vendor: 'Apple', name: 'M4 GPU', memory_bytes: null, unified_memory: true }] }, load: { load_average: [1, 1, 1], memory_available_bytes: 8 * 1024 ** 3, memory_used_percent: 50 }, runtimes: [{ id: 'llama', kind: 'llama', mode: 'native', state: 'ready', busy: true, simulated: false, loaded_model: 'qwen3', prefix_cache: [], runtime_instance: 'r1', model_fingerprint: null, supports_model_switch: true, supports_cache_transfer: false }], models: [{ id: 'qwen3', runtime: 'llama', capabilities: ['complete'], cached_on_disk: true, resident: true, available: true, simulated: false }] } }, { node_id: 'quiet-node', status: 'offline', connected: false, last_seen: 1_700_000_000_000, snapshot: { schema_version: '1', node_id: 'quiet-node', observed_at: 1_700_000_000_000, uptime_seconds: 0, execution_scope: 'local', active_requests: 0, hardware: { os: 'Linux', arch: 'x64', hostname: 'quiet', cpu: 'x86', logical_cpus: 4, physical_cpus: 4, memory_total_bytes: 8 * 1024 ** 3, gpus: [] }, load: { load_average: null, memory_available_bytes: 4 * 1024 ** 3, memory_used_percent: 50 }, runtimes: [], models: [] } }],
};

test('topology renders actual fixture nodes and never invents throughput', () => {
  const markup = renderToStaticMarkup(createElement(FabricTopology, { fabric }));
  assert.match(markup, /native-mac/);
  assert.match(markup, /quiet-node/);
  assert.match(markup, /M4 GPU/);
  assert.match(markup, /Not measured/);
  assert.match(markup, /Resident/);
  assert.match(markup, /offline/);
  assert.ok(!markup.includes(' tok/s'));
});

test('topology only marks the busy node as working when another node is idle', () => {
  const twoOnline: FabricState = { ...fabric, nodes: fabric.nodes.map((node) => node.node_id === 'quiet-node' ? { ...node, status: 'online', connected: true } : node) };
  const markup = renderToStaticMarkup(createElement(FabricTopology, { fabric: twoOnline }));
  assert.equal(markup.match(/data-active="true"/g)?.length, 1);
  assert.match(markup, /quiet-node/);
});
