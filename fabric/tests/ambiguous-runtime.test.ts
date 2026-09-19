import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Use Wrangler's installed runtime, including native fetch, with network intercepted outside the Worker.
test('Ambiguous native Worker fetch verifies identity, creates once and never follows redirects', async () => {
  const bundle = await build({
    stdin: { contents: `
      import { AmbiguousClient } from './worker/ambiguous.ts';
      export default { async fetch() {
        const agent = '11111111-1111-4111-8111-111111111111';
        const workspace = '22222222-2222-4222-8222-222222222222';
        const project = '33333333-3333-4333-8333-333333333333';
        const env = { AMBIGUOUS_API_TOKEN: 'fake-test-only', AMBIGUOUS_AGENT_ID: agent, AMBIGUOUS_WORKSPACE_ID: workspace, AMBIGUOUS_PROJECT_ID: project };
        const client = new AmbiguousClient(env);
        await client.verify();
        const created = await client.create({ kind: 'task', operation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Test', description: 'Test only' }, 'Test only');
        let rejected = false;
        try { await client.verify(); } catch (error) { rejected = error.message.includes('HTTP 302'); }
        return Response.json({ verified: true, created, rejected });
      } };
    `, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  });
  const calls: string[] = [];
  const runtime = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: '2026-09-01', script: bundle.outputFiles[0].text,
    outboundService: async (request) => {
      calls.push(`${request.method} ${request.url}`);
      assert.equal(new URL(request.url).origin, 'https://app.ambiguous.ai');
      assert.equal(request.headers.get('authorization'), 'Bearer fake-test-only');
      if (calls.length === 1) return Response.json({ id: '11111111-1111-4111-8111-111111111111', workspace_id: '22222222-2222-4222-8222-222222222222', type: 'agent' });
      if (calls.length === 2) return Response.json({ project: { id: '33333333-3333-4333-8333-333333333333', workspace_id: '22222222-2222-4222-8222-222222222222' } });
      if (calls.length === 3) {
        assert.equal(request.method, 'POST');
        return Response.json({ task: { id: '44444444-4444-4444-8444-444444444444', project_id: '33333333-3333-4333-8333-333333333333', assignee_id: '11111111-1111-4111-8111-111111111111', status: 'todo' } }, { status: 201 });
      }
      return new Response('', { status: 302, headers: { location: 'https://evil.invalid' } });
    },
  }));
  try {
    const response = await runtime.dispatchFetch('http://local.test/');
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { verified: true, created: { id: '44444444-4444-4444-8444-444444444444', status: 'todo' }, rejected: true });
    assert.equal(calls.length, 4);
    assert.equal(calls.filter((call) => call.startsWith('POST')).length, 1);
  } finally { await runtime.dispose(); }
});
