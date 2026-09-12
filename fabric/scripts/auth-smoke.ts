/**
 * Local-only integration smoke for Fabric auth, ownership, MCP, and node revocation.
 *
 * Terminal 1 (CLI vars override any developer defaults; persistence is isolated):
 *   fabric_smoke_state=$(mktemp -d)
 *   npx wrangler dev --local --ip 127.0.0.1 --port 8788 --persist-to "$fabric_smoke_state" \
 *     --var FABRIC_TOKEN:local-auth-smoke-bootstrap-nonsensitive \
 *     --var 'FABRIC_MCP_ORIGINS:http://127.0.0.1:8788,http://elasticinferencefabric.airanger.dev'
 * Terminal 2:
 *   FABRIC_ORIGIN=http://127.0.0.1:8788 \
 *   FABRIC_SMOKE_BOOTSTRAP=local-auth-smoke-bootstrap-nonsensitive \
 *     npx tsx scripts/auth-smoke.ts
 *
 * Wrangler derives the inner request URL from the configured custom domain, hence the
 * second local-only MCP origin. This script refuses non-loopback target origins.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { IssuedFabricToken } from '../src/access-contracts';
import type { FabricJob, FabricState } from '../src/contracts';

const origin = process.env.FABRIC_ORIGIN ?? 'http://127.0.0.1:8788';
const bootstrap = process.env.FABRIC_SMOKE_BOOTSTRAP;
const url = new URL(origin);
if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
  throw new Error('auth-smoke refuses non-loopback origins');
}
if (!bootstrap) throw new Error('FABRIC_SMOKE_BOOTSTRAP must contain a throwaway local bootstrap token');

const require = createRequire(import.meta.url);
const WebSocketClient = require('ws') as new (url: string, options: { headers: Record<string, string> }) => SmokeSocket;

interface SmokeSocket {
  once(event: string, listener: (...args: any[]) => void): void;
  on(event: string, listener: (...args: any[]) => void): void;
  send(data: string): void;
  close(): void;
}

interface ApiOptions {
  method?: string;
  token?: string;
  cookie?: string;
  requestOrigin?: string;
  body?: unknown;
  expected: number;
}

async function api<T = unknown>(path: string, options: ApiOptions): Promise<{ response: Response; value: T | null }> {
  const headers = new Headers();
  if (options.token) headers.set('Authorization', `Bearer ${options.token}`);
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.requestOrigin) headers.set('Origin', options.requestOrigin);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const response = await fetch(new URL(path, origin), { method: options.method ?? 'GET', headers, body });
  assert.equal(response.status, options.expected, `${options.method ?? 'GET'} ${path} returned ${response.status}`);
  const text = await response.text();
  return { response, value: text ? JSON.parse(text) as T : null };
}

async function issue(token: string, body: Record<string, unknown>): Promise<IssuedFabricToken> {
  const { value } = await api<IssuedFabricToken>('/api/tokens', { method: 'POST', token, body, expected: 201 });
  assert.ok(value?.token && value.access.id);
  return value;
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie');
  assert.ok(setCookie);
  const pair = setCookie.split(';', 1)[0];
  assert.match(pair, /^fabric_session=fas_[A-Za-z0-9_-]{43}$/);
  return pair;
}

function connect(token: string, nodeId: string): SmokeSocket {
  return new WebSocketClient(new URL(`/v1/nodes/connect?node_id=${encodeURIComponent(nodeId)}`, origin).toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function opened(socket: SmokeSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
    socket.once('unexpected-response', (_request: unknown, response: { statusCode?: number; resume(): void }) => {
      response.resume();
      reject(new Error(`unexpected WebSocket response ${response.statusCode ?? 'unknown'}`));
    });
  });
}

async function rejectedUpgrade(token: string, nodeId: string, expected: number): Promise<void> {
  const socket = connect(token, nodeId);
  const status = await new Promise<number>((resolve, reject) => {
    socket.once('open', () => reject(new Error('WebSocket unexpectedly opened')));
    socket.once('unexpected-response', (_request: unknown, response: { statusCode?: number; resume(): void }) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    socket.once('error', (error: Error) => reject(error));
  });
  assert.equal(status, expected);
}

async function nextMessage(socket: SmokeSocket): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    socket.once('message', (data: { toString(): string }) => {
      try { resolve(JSON.parse(data.toString()) as Record<string, unknown>); } catch (error) { reject(error); }
    });
    socket.once('error', reject);
  });
}

function syntheticHeartbeat(nodeId: string): Record<string, unknown> {
  return {
    type: 'heartbeat',
    snapshot: {
      schema_version: '1', node_id: nodeId, observed_at: Date.now(), uptime_seconds: 10,
      execution_scope: 'local', active_requests: 0,
      hardware: {
        os: 'smoke', arch: 'test', hostname: 'synthetic-node', cpu: 'synthetic', logical_cpus: 1,
        physical_cpus: 1, memory_total_bytes: 1024, gpus: [],
      },
      load: { load_average: [0, 0, 0], memory_available_bytes: 512, memory_used_percent: 50 },
      runtimes: [{
        id: 'mock-runtime', kind: 'synthetic', mode: 'managed', state: 'ready', busy: false,
        simulated: false, loaded_model: 'smoke-model', prefix_cache: [], runtime_instance: 'smoke-instance',
        model_fingerprint: 'smoke-fingerprint', supports_model_switch: true, supports_cache_transfer: false,
      }],
      models: [{
        id: 'smoke-model', runtime: 'mock-runtime', capabilities: ['complete'], cached_on_disk: true,
        resident: true, available: true, simulated: false, fingerprint: 'smoke-fingerprint',
      }],
    },
  };
}

async function waitForNode(token: string, nodeId: string, connected: boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const { value } = await api<FabricState>('/v1/resources', { token, expected: 200 });
    if (value?.nodes.find((node) => node.node_id === nodeId)?.connected === connected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`node ${nodeId} did not reach connected=${connected}`);
}

const createdIds: string[] = [];
let nodeSocket: SmokeSocket | null = null;
try {
  const admin = await issue(bootstrap, { label: 'Smoke admin', role: 'admin', expires_in_days: 1 });
  createdIds.push(admin.access.id);
  const disposable = await issue(admin.token, { label: 'Disposable', role: 'agent', expires_in_days: 1 });
  createdIds.push(disposable.access.id);
  const listed = await api<{ tokens: Array<Record<string, unknown>> }>('/api/tokens', { token: admin.token, expected: 200 });
  assert.ok(listed.value?.tokens.some((token) => token.id === disposable.access.id));
  assert.equal(JSON.stringify(listed.value).includes(disposable.token), false);
  await api(`/api/tokens/${disposable.access.id}`, { method: 'DELETE', token: admin.token, expected: 200 });

  const agentA = await issue(admin.token, { label: 'Agent A', role: 'agent', expires_in_days: 1 });
  const agentB = await issue(admin.token, { label: 'Agent B', role: 'agent', expires_in_days: 1 });
  const node = await issue(admin.token, { label: 'Synthetic node', role: 'node', node_id: 'smoke-node', expires_in_days: 1 });
  createdIds.push(agentA.access.id, agentB.access.id, node.access.id);

  await api('/api/tokens', { token: agentA.token, expected: 403 });
  await api('/api/tokens', { method: 'POST', token: agentA.token, body: { label: 'forbidden' }, expected: 403 });
  await rejectedUpgrade(agentA.token, 'smoke-node', 403);
  await rejectedUpgrade(node.token, 'wrong-node', 403);
  await api('/v1/resources', { token: node.token, expected: 403 });
  await api('/v1/tasks', { method: 'POST', token: node.token, body: { capability: 'complete', prompt: 'blocked' }, expected: 403 });
  await api('/mcp', { method: 'POST', token: node.token, expected: 403 });

  nodeSocket = connect(node.token, 'smoke-node');
  await opened(nodeSocket);
  nodeSocket.send(JSON.stringify(syntheticHeartbeat('smoke-node')));
  await waitForNode(admin.token, 'smoke-node', true);

  const executeMessage = nextMessage(nodeSocket);
  const accepted = await api<FabricJob>('/v1/tasks', {
    method: 'POST', token: agentA.token,
    body: { capability: 'complete', prompt: 'synthetic local execution', model_id: 'smoke-model', max_tokens: 8 },
    expected: 202,
  });
  assert.ok(accepted.value?.id);
  const execute = await executeMessage;
  assert.equal(execute.type, 'execute');
  assert.equal(execute.job_id, accepted.value.id);
  nodeSocket.send(JSON.stringify({
    type: 'result', job_id: accepted.value.id,
    result: {
      request_id: 'synthetic-request', node_id: 'smoke-node', runtime_id: 'mock-runtime', model_id: 'smoke-model',
      content: 'synthetic-ok', simulated: false, elapsed_ms: 1, cache: {}, usage: {},
    },
  }));
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const own = await api<FabricJob>(`/v1/tasks/${accepted.value.id}`, { token: agentA.token, expected: 200 });
    if (own.value?.status === 'succeeded') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (attempt === 29) throw new Error('synthetic job did not complete');
  }
  await api(`/v1/tasks/${accepted.value.id}`, { token: agentB.token, expected: 404 });
  const resourcesA = await api<FabricState>('/v1/resources', { token: agentA.token, expected: 200 });
  const resourcesB = await api<FabricState>('/v1/resources', { token: agentB.token, expected: 200 });
  assert.ok(resourcesA.value?.jobs.some((job) => job.id === accepted.value?.id));
  assert.equal(resourcesB.value?.jobs.some((job) => job.id === accepted.value?.id), false);

  const loginA = await api('/api/session', { method: 'POST', requestOrigin: origin, body: { token: agentA.token }, expected: 200 });
  const cookieA = sessionCookie(loginA.response);
  await api('/api/me', { cookie: cookieA, expected: 200 });
  await api(`/api/tokens/${agentA.access.id}`, { method: 'DELETE', token: admin.token, expected: 200 });
  await api('/api/me', { cookie: cookieA, expected: 401 });
  await api('/api/me', { token: agentA.token, expected: 401 });

  await api('/mcp', { method: 'POST', expected: 401 });
  await api('/mcp', { method: 'POST', token: 'fat_invalid', expected: 401 });
  const loginB = await api('/api/session', { method: 'POST', requestOrigin: origin, body: { token: agentB.token }, expected: 200 });
  await api('/mcp', { method: 'POST', cookie: sessionCookie(loginB.response), expected: 401 });
  await api('/mcp', { method: 'POST', token: agentB.token, requestOrigin: 'https://untrusted.example', expected: 403 });

  const client = new Client({ name: 'ganglion-auth-smoke', version: '0.2.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
      requestInit: { headers: { Authorization: `Bearer ${agentB.token}` } },
    }));
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    const resources = (await client.listResources()).resources.map((resource) => resource.uri).sort();
    assert.deepEqual(tools, ['fabric_get_task', 'fabric_models', 'fabric_resources', 'fabric_submit_task']);
    assert.deepEqual(resources, ['fabric://identity', 'fabric://models', 'fabric://resources']);
  } finally {
    await client.close();
  }

  const closed = new Promise<number>((resolve) => nodeSocket?.once('close', (code: number) => resolve(code)));
  await api(`/api/tokens/${node.access.id}`, { method: 'DELETE', token: admin.token, expected: 200 });
  assert.equal(await closed, 4003);
  await waitForNode(admin.token, 'smoke-node', false);

  console.log(JSON.stringify({
    ok: true,
    checks: ['admin-crud', 'role-boundaries', 'job-ownership', 'session-revocation', 'node-revocation', 'mcp-auth', 'mcp-discovery'],
    mcp_tools: 4,
    mcp_resources: 3,
  }));
} finally {
  nodeSocket?.close();
  for (const id of createdIds) {
    await api(`/api/tokens/${id}`, { method: 'DELETE', token: bootstrap, expected: 200 })
      .catch(() => undefined);
  }
}
