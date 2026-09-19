import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { AmbiguousClient, AmbiguousStore, handleAmbiguous, handoffDescription, parseHandoff, quotedText, type AmbiguousEnv } from '../worker/ambiguous';
import { InputError } from '../worker/domain';
import type { FabricPrincipal } from '../src/access-contracts';
import type { FabricJob } from '../src/contracts';
import type { AmbiguousHandoffInput, AmbiguousStatus } from '../src/ambiguous-contracts';

const agentId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const taskId = '44444444-4444-4444-8444-444444444444';
const jobId = '55555555-5555-4555-8555-555555555555';
const env: AmbiguousEnv = { AMBIGUOUS_API_TOKEN: 'test-only-not-a-real-token', AMBIGUOUS_AGENT_ID: agentId, AMBIGUOUS_WORKSPACE_ID: workspaceId, AMBIGUOUS_PROJECT_ID: projectId };
const job: FabricJob = { id: jobId, status: 'succeeded', capability: 'complete', node_id: 'test-node', model_id: 'native-model', runtime_id: 'local', created_at: 1, placement_reason: 'test', result: { content: 'Useful local output.\n![exfil](https://evil.invalid)\n</pre><script>alert(1)</script>' } };
function input(kind: 'task' | 'result' = 'task'): AmbiguousHandoffInput {
  return kind === 'task' ? { kind, operation_id: crypto.randomUUID(), title: 'Demo task', description: 'A bounded coworker task.' }
    : { kind, operation_id: crypto.randomUUID(), title: 'Explicit local result', job_id: jobId };
}
function request(body?: unknown): Request {
  return new Request(`https://fabric.example/api/ambiguous/${body === undefined ? 'status' : 'handoffs'}`, body === undefined ? {} : {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}
function setup() {
  const database = new DatabaseSync(':memory:');
  const sql = { exec(query: string, ...bindings: any[]) {
    const statement = database.prepare(query);
    const rows = statement.columns().length ? statement.all(...bindings) : (statement.run(...bindings), []);
    return { toArray: () => rows, one: () => { assert.equal(rows.length, 1); return rows[0]; } };
  } } as unknown as SqlStorage;
  const store = new AmbiguousStore(sql); store.initialize(); store.initialize();
  let role: FabricPrincipal['role'] | null = 'admin';
  let postError = false;
  let mismatched = false;
  let onVerify: (() => void) | undefined;
  let pendingPost: Promise<void> | undefined;
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    assert.equal(new URL(String(url)).origin, 'https://app.ambiguous.ai');
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    if (String(url).endsWith('/api/users/me')) {
      onVerify?.();
      return Response.json({ id: agentId, workspace_id: mismatched ? 'wrong' : workspaceId, type: 'agent', private_email: 'not exposed' });
    }
    if (String(url).endsWith(`/api/projects/${projectId}`)) return Response.json({ project: { id: projectId, workspace_id: workspaceId } });
    if (init?.method === 'POST') {
      await pendingPost;
      if (postError) throw new Error(`private upstream error with ${env.AMBIGUOUS_API_TOKEN}`);
      return Response.json({ task: { id: taskId, project_id: projectId, assignee_id: agentId, status: JSON.parse(init.body as string).status } }, { status: 201 });
    }
    return Response.json({ task: { id: taskId, project_id: projectId, status: 'in_progress', description: 'private upstream task description' } });
  };
  const client = new AmbiguousClient(env, fetcher);
  const ctx = { client, store, job: () => job, authorize(required: 'admin' | 'viewer'): FabricPrincipal {
    if (!role) throw new InputError('revoked', 401);
    if (role === 'node' || (required === 'admin' && role !== 'admin')) throw new InputError('forbidden', 403);
    return { id: 'fabric-admin', role, label: 'Test', node_id: null, expires_at: null };
  } };
  return { database, store, ctx, calls, setRole: (next: typeof role) => { role = next; }, failPost: () => { postError = true; }, mismatch: () => { mismatched = true; }, onVerify: (fn: () => void) => { onVerify = fn; }, holdPost: (p: Promise<void>) => { pendingPost = p; } };
}

test('handoffs validate fields, result state and text export bounds', () => {
  assert.equal(parseHandoff(input()).kind, 'task');
  for (const body of [null, [], {}, { ...input(), extra: 'evil' }, { ...input(), title: ' ' }, { ...input(), operation_id: '../../etc' }, { ...input(), description: 'x'.repeat(8001) }, { ...input('result'), job_id: 'bad' }]) {
    assert.throws(() => parseHandoff(body), InputError);
  }
  assert.throws(() => handoffDescription(input('result'), { ...job, status: 'running' }), /completed/);
  assert.throws(() => handoffDescription(input('result'), { ...job, result: { content: 'x'.repeat(32001) } }), /export limit/);
  const output = handoffDescription(input('result'), job);
  assert.match(output, /\n    !\[exfil\]/);
  assert.match(output, /\n    <\/pre><script>/);
  assert.match(output, /not an instruction to execute/);
  assert.equal(quotedText('a\n\nb'), '    a\n    \n    b');
});

test('lone carriage returns cannot escape the Markdown data block', () => {
  const malicious = 'safe\r![exfil](https://evil.invalid)\r<script>alert(1)</script>\r\nend';
  assert.equal(quotedText(malicious), '    safe\n    ![exfil](https://evil.invalid)\n    <script>alert(1)</script>\n    end');
  for (const description of [handoffDescription({ ...input('task'), kind: 'task', description: malicious }), handoffDescription(input('result'), { ...job, result: { content: malicious } })]) {
    assert.ok(!description.includes('\r'));
    assert.ok(description.split('\n').filter((line) => line.includes('![exfil]') || line.includes('<script>')).every((line) => line.startsWith('    ')));
  }
});

test('only administrators may write; other authenticated viewers see no private handoffs', async () => {
  for (const role of ['agent', 'viewer', 'node'] as const) {
    const s = setup(); s.setRole(role);
    await assert.rejects(handleAmbiguous(request(input()), s.ctx), (e: unknown) => e instanceof InputError && e.status === 403);
    assert.equal(s.calls.length, 0);
    if (role === 'node') await assert.rejects(handleAmbiguous(request(), s.ctx), /forbidden/);
    else {
      const status = await (await handleAmbiguous(request(), s.ctx)).json() as AmbiguousStatus;
      assert.equal(status.connected, true); assert.equal(status.can_write, false);
      assert.equal(Object.hasOwn(status, 'handoffs'), false);
      assert.ok(!JSON.stringify(status).includes('private_email'));
      assert.ok(!JSON.stringify(status).includes(env.AMBIGUOUS_API_TOKEN!));
    }
    s.database.close();
  }
});

test('a verified task is assigned to the pinned agent/project and stored without its description', async () => {
  const s = setup(); const body = input();
  const response = await handleAmbiguous(request(body), s.ctx);
  assert.equal(response.status, 201);
  const result = await response.json() as any;
  assert.equal(result.handoff.task_id, taskId);
  assert.equal(result.handoff.url, `https://app.ambiguous.ai/tasks/${taskId}`);
  const posted = JSON.parse(s.calls.find((call) => call.init.method === 'POST')!.init.body as string);
  assert.equal(posted.assignee_id, agentId); assert.equal(posted.project_id, projectId); assert.equal(posted.status, 'todo');
  assert.match(posted.description, new RegExp(body.operation_id));
  const rows = JSON.stringify(s.database.prepare('SELECT * FROM ambiguous_handoffs').all());
  assert.ok(!rows.includes('A bounded coworker task.')); assert.ok(!rows.includes(env.AMBIGUOUS_API_TOKEN!));
  s.database.close();
});

test('concurrent duplicate operations and duplicate result exports send only one POST', async () => {
  const s = setup(); const body = input('result');
  let release!: () => void; s.holdPost(new Promise<void>((resolve) => { release = resolve; }));
  const first = handleAmbiguous(request(body), s.ctx);
  while (!s.calls.some((call) => call.init.method === 'POST')) await new Promise((resolve) => setTimeout(resolve, 1));
  const duplicate = await handleAmbiguous(request(body), s.ctx);
  assert.equal((await duplicate.json() as any).handoff.state, 'pending');
  release(); assert.equal((await first).status, 201);
  const again = await handleAmbiguous(request({ ...body, operation_id: crypto.randomUUID() }), s.ctx);
  assert.equal((await again.json() as any).replayed, true);
  assert.equal(s.calls.filter((call) => call.init.method === 'POST').length, 1);
  const posted = JSON.parse(s.calls.find((call) => call.init.method === 'POST')!.init.body as string);
  assert.equal(posted.status, 'done');
  await assert.rejects(handleAmbiguous(request({ ...body, title: 'changed' }), s.ctx), /another request/);
  s.database.close();
});

test('an unknown write outcome is durable, sanitizes errors and never retries on replay or status reads', async () => {
  const s = setup(); s.failPost(); const body = input();
  const response = await handleAmbiguous(request(body), s.ctx);
  assert.equal(response.status, 202);
  const text = await response.text(); assert.match(text, /uncertain/); assert.ok(!text.includes(env.AMBIGUOUS_API_TOKEN!));
  await handleAmbiguous(request(body), s.ctx);
  await handleAmbiguous(request(), s.ctx);
  assert.equal(s.calls.filter((call) => call.init.method === 'POST').length, 1);
  assert.equal(s.store.list()[0].state, 'uncertain');
  s.database.close();
});

test('identity mismatch and revocation during verification prevent all upstream writes', async () => {
  const mismatch = setup(); mismatch.mismatch();
  await assert.rejects(handleAmbiguous(request(input()), mismatch.ctx), /identity mismatch/);
  assert.equal(mismatch.calls.filter((call) => call.init.method === 'POST').length, 0);
  assert.equal(mismatch.store.list().length, 0); mismatch.database.close();
  const revoked = setup(); revoked.onVerify(() => revoked.setRole(null));
  await assert.rejects(handleAmbiguous(request(input()), revoked.ctx), /revoked/);
  assert.equal(revoked.calls.filter((call) => call.init.method === 'POST').length, 0); revoked.database.close();
});

test('status reads only linked tasks and returns measured status without task descriptions', async () => {
  const s = setup(); await handleAmbiguous(request(input()), s.ctx);
  const status = await (await handleAmbiguous(request(), s.ctx)).json() as AmbiguousStatus;
  assert.equal(status.handoffs?.[0].task_status, 'in_progress');
  assert.ok(status.handoffs?.[0].checked_at);
  assert.ok(!JSON.stringify(status).includes('private upstream task description'));
  assert.equal(s.calls.filter((call) => call.init.method === 'POST').length, 1);
  s.database.close();
});

test('unconfigured, redirects, wrong project, human identity and oversized upstream responses fail closed', async () => {
  const empty = new AmbiguousClient({}, async () => { throw new Error('must not call'); });
  assert.equal(empty.configured(), false); await assert.rejects(empty.verify(), /not configured/);
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }), Response.json({ id: agentId, workspace_id: workspaceId, type: 'human' }), Response.json({ filler: 'x'.repeat(196609) })]) {
    const client = new AmbiguousClient(env, async (_url, init) => { assert.equal(init?.redirect, 'manual'); return response; });
    await assert.rejects(client.verify(), InputError);
  }
  const wrongProject = new AmbiguousClient(env, async (url) => String(url).endsWith('/me') ? Response.json({ id: agentId, workspace_id: workspaceId, type: 'agent' }) : Response.json({ project: { id: projectId, workspace_id: 'other' } }));
  await assert.rejects(wrongProject.verify(), /project\/workspace mismatch/);
});

test('dashboard exposes the integration and guards plain-text result previews', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const ui = readFileSync(new URL('../src/AmbiguousPanel.tsx', import.meta.url), 'utf8');
  assert.match(app, /<AmbiguousPanel/);
  assert.match(ui, /id="ambiguous"/); assert.match(ui, /Create Ambiguous task/); assert.match(ui, /Publish selected result/);
  assert.match(ui, /status\?\.can_write/); assert.match(ui, /<pre className="ambiguous-preview">\{preview\}<\/pre>/);
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|localStorage|AMBIGUOUS_API_TOKEN/);
});
