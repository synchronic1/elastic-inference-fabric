import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FabricPrincipal } from '../src/access-contracts';
import type { FabricState } from '../src/contracts';
import { handleMcp, type FabricOperations } from '../worker/mcp';
import { readJsonBody } from '../worker/http';

const origin = 'https://fabric.example';
const principal: FabricPrincipal = { id: 'test-agent', label: 'Test agent', role: 'agent', node_id: null, expires_at: null };
const jobId = 'a33f304c-d90a-440b-a656-60ad03e99358';
const operations: FabricOperations = {
  resources: () => ({ nodes: [], jobs: [], summary: { online_nodes: 0 } } as unknown as FabricState),
  submit: async (task) => ({ id: jobId, status: 'running', capability: task.capability, node_id: 'n', model_id: 'm', runtime_id: 'r', created_at: Date.now(), placement_reason: 'test fixture' }),
  task: () => { throw new Error('job not found'); },
};

test('official MCP client initializes, discovers tools/resources and submits with structured results', async () => {
  const client = new Client({ name: 'integration-test', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => handleMcp(new Request(input, init), principal, operations, [origin])) as typeof fetch,
  });
  try {
    await client.connect(transport);
    assert.equal(transport.sessionId, undefined);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ['fabric_get_task', 'fabric_models', 'fabric_resources', 'fabric_submit_task']);
    assert.equal((await client.listResources()).resources.length, 3);
    const identity = await client.readResource({ uri: 'fabric://identity' });
    assert.ok(JSON.stringify(identity).includes('Test agent'));
    const job = await client.callTool({ name: 'fabric_submit_task', arguments: { capability: 'complete', prompt: 'Hello\nworld' } });
    assert.equal((job.structuredContent as Record<string, unknown> | undefined)?.id, jobId);
    const chat = await client.callTool({ name: 'fabric_submit_task', arguments: {
      capability: 'complete', messages: [{ role: 'user', content: 'What is 2+2?' }],
    } });
    assert.equal((chat.structuredContent as Record<string, unknown> | undefined)?.id, jobId);
    const missing = await client.callTool({ name: 'fabric_get_task', arguments: { job_id: jobId } });
    assert.equal(missing.isError, true);
    const invalid = await client.callTool({ name: 'fabric_submit_task', arguments: { capability: 'complete', prompt: 'x', command: 'not permitted' } });
    assert.equal(invalid.isError, true);
    const ambiguous = await client.callTool({ name: 'fabric_submit_task', arguments: {
      capability: 'complete', prompt: 'raw', messages: [{ role: 'user', content: 'chat' }],
    } });
    assert.equal(ambiguous.isError, true);
  } finally {
    await client.close();
  }
});

test('MCP validates Origin, method, protocol version and JSON content negotiation', async () => {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const request = (headers: Record<string, string>) => new Request(`${origin}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers }, body: JSON.stringify(rpc),
  });
  assert.equal((await handleMcp(request({ Origin: 'https://evil.example' }), principal, operations, [origin])).status, 403);
  assert.equal((await handleMcp(request({ 'MCP-Protocol-Version': 'unrecognized' }), principal, operations, [origin])).status, 400);
  assert.equal((await handleMcp(request({ Accept: 'text/plain' }), principal, operations, [origin])).status, 406);
  assert.equal((await handleMcp(new Request(`${origin}/mcp`), principal, operations, [origin])).status, 405);
  assert.equal((await handleMcp(new Request('https://untrusted.example/mcp'), principal, operations, [origin])).status, 403);
  const notification = new Request(`${origin}/mcp`, {
    method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  const accepted = await handleMcp(notification, principal, operations, [origin]);
  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), '');
});

test('bounded reader rejects chunked bodies without trusting Content-Length', async () => {
  const request = new Request(`${origin}/test`, { method: 'POST', body: JSON.stringify({ prompt: 'x'.repeat(100) }) });
  await assert.rejects(readJsonBody(request, 30), /too large/);
});
