import { DurableObject } from 'cloudflare:workers';
import type { FabricJob, NodeSnapshot, TaskRequest } from '../src/contracts';
import { PRIMARY_MODELS } from '../src/model-catalog';
import {
  aggregateFabricState,
  InputError,
  LIMITS,
  parseTaskRequest,
  placementCandidates,
  sanitizeNodeSnapshot,
  sha256Hex,
  validJobId,
  validNodeId,
  type SchedulableNode,
} from './domain';

interface Env {
  FABRIC: DurableObjectNamespace<FabricRoom>;
  ASSETS: Fetcher;
  FABRIC_TOKEN?: string;
}

interface SocketAttachment {
  node_id: string;
  connection_id: string;
}

interface NodeRow {
  [key: string]: SqlStorageValue;
  node_id: string;
  last_seen: number;
  snapshot_json: string;
  connection_id: string | null;
}

interface JobRow {
  [key: string]: SqlStorageValue;
  id: string;
  status: FabricJob['status'];
  capability: string;
  node_id: string;
  model_id: string;
  runtime_id: string;
  connection_id: string;
  created_at: number;
  completed_at: number | null;
  deadline_at: number;
  placement_reason: string;
  result_json: string | null;
  error: string | null;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...headers } });
}

function errorResponse(message: string, status: number): Response {
  return json({ error: message }, status);
}

function publicJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
}

function configuredToken(env: Env): string | null {
  return typeof env.FABRIC_TOKEN === 'string' && env.FABRIC_TOKEN.length > 0 ? env.FABRIC_TOKEN : null;
}

function agentCard(origin: string): Record<string, unknown> {
  return {
    name: 'Ganglion Fabric',
    description: 'Authenticated Cloudflare relay and scheduler for private, outbound-connected Dendrite inference nodes.',
    url: origin,
    version: '0.1.0',
    authentication: { schemes: ['bearer', 'same-site session cookie'] },
    endpoints: {
      submit_task: `${origin}/v1/tasks`,
      task_status: `${origin}/v1/tasks/{id}`,
      authenticated_inventory: `${origin}/v1/resources`,
      model_roster: `${origin}/v1/models`,
      openapi: `${origin}/openapi.json`,
    },
    semantics: {
      relay: 'Prompts transit the Cloudflare Worker to a selected node; inference stays on that node.',
      availability: 'The public model roster describes intended roles, not live installation or availability.',
      fallback: 'There is no cloud inference fallback and simulated runtimes require allow_simulated=true.',
      cache: 'Prefix candidates are node-local placement hints, never portable cache artifacts.',
    },
    models: PRIMARY_MODELS,
  };
}

function openApi(origin: string): Record<string, unknown> {
  const security = [{ bearerAuth: [] }, { sessionCookie: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Ganglion Fabric API', version: '0.1.0',
      description: 'Cloud relay to outbound-connected private Dendrite nodes. Prompts transit the relay; inference is local and has no cloud fallback.',
    },
    servers: [{ url: origin }],
    paths: {
      '/v1/models': { get: { summary: 'Public intended-role model roster (not live availability)', responses: { 200: { description: 'Static roster' } } } },
      '/v1/resources': { get: { summary: 'Authenticated live fabric inventory', security, responses: { 200: { description: 'FabricState' }, 401: { description: 'Unauthorized' } } } },
      '/v1/tasks': {
        post: {
          summary: 'Submit local inference through the relay', security,
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/TaskRequest' } } } },
          responses: { 202: { description: 'Accepted FabricJob' }, 409: { description: 'No eligible idle node' } },
        },
      },
      '/v1/tasks/{id}': { get: { summary: 'Read task status/result', security, parameters: [{ name: 'id', in: 'path', required: true }], responses: { 200: { description: 'FabricJob' }, 404: { description: 'Unknown job' } } } },
      '/v1/nodes/connect': { get: { summary: 'Dendrite outbound WebSocket connection', security: [{ bearerAuth: [] }], responses: { 101: { description: 'WebSocket upgraded; send an immediate heartbeat and then every 10 seconds' } } } },
      '/api/session': {
        post: { summary: 'Exchange token for strict HttpOnly session cookie', responses: { 200: { description: 'Logged in' } } },
        delete: { summary: 'Clear session cookie', security, responses: { 200: { description: 'Logged out' } } },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'fabric_session' },
      },
      schemas: {
        TaskRequest: {
          type: 'object', additionalProperties: false, required: ['capability', 'prompt'],
          properties: {
            capability: { type: 'string', minLength: 1, maxLength: 128 },
            prompt: { type: 'string', minLength: 1, maxLength: LIMITS.promptCharacters },
            prefix: { type: 'string', maxLength: LIMITS.prefixCharacters },
            model_id: { type: 'string' }, max_tokens: { type: 'integer', minimum: 1, maximum: 4096 },
            temperature: { type: 'number', minimum: 0, maximum: 2 }, allow_simulated: { type: 'boolean', default: false },
          },
        },
      },
    },
  };
}

function llmsText(origin: string): string {
  const models = PRIMARY_MODELS.map((model) => `- ${JSON.stringify(model)}`).join('\n');
  return `# Ganglion Fabric\n\nGanglion is an authenticated Cloudflare relay and scheduler for private Dendrite inference nodes. Nodes connect outbound, so no inbound node port is exposed. Prompts transit Cloudflare, while inference remains on the selected node. There is no public live inventory and no cloud inference fallback. Simulated execution must be explicitly allowed. Prefix-cache metadata is only a node-local placement hint.\n\n## API\n- POST ${origin}/v1/tasks (authenticated): submit capability, prompt, optional prefix/model_id/max_tokens/temperature/allow_simulated.\n- GET ${origin}/v1/tasks/{id} (authenticated): retrieve job state or result.\n- GET ${origin}/v1/resources (authenticated): retrieve live inventory.\n- GET ${origin}/v1/models (public): intended-role roster, not actual availability.\n- OpenAPI: ${origin}/openapi.json\n\n## Intended model roles\n${models}\n`;
}

async function readJsonBody(request: Request, limit: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new InputError('request body too large', 413);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw new InputError('request body too large', 413);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new InputError('request body must be valid UTF-8 JSON');
  }
}

function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.get('origin');
  return origin === null || origin === new URL(request.url).origin;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return configuredToken(env)
        ? json({ ok: true, service: 'ganglion-fabric' })
        : errorResponse('FABRIC_TOKEN is not configured securely', 503);
    }
    if (request.method === 'GET' && url.pathname === '/.well-known/agent.json') return publicJson(agentCard(url.origin));
    if (request.method === 'GET' && url.pathname === '/openapi.json') return publicJson(openApi(url.origin));
    if (request.method === 'GET' && url.pathname === '/llms.txt') {
      return new Response(llmsText(url.origin), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return publicJson({ description: 'Intended roles only; authenticate to /v1/resources for actual availability.', models: PRIMARY_MODELS });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/')) {
      if (!configuredToken(env)) return errorResponse('FABRIC_TOKEN is not configured securely', 503);
      return env.FABRIC.getByName('global').fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class FabricRoom extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.initialize());
  }

  private initialize(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS nodes (
      node_id TEXT PRIMARY KEY, last_seen INTEGER NOT NULL, snapshot_json TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS connections (
      node_id TEXT PRIMARY KEY, connection_id TEXT NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, capability TEXT NOT NULL,
      node_id TEXT NOT NULL, model_id TEXT NOT NULL, runtime_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER,
      deadline_at INTEGER NOT NULL, placement_reason TEXT NOT NULL,
      result_json TEXT, error TEXT
    )`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS jobs_status_deadline ON jobs(status, deadline_at)`);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS jobs_created ON jobs(created_at DESC)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reservations (
      reservation_key TEXT PRIMARY KEY, job_id TEXT NOT NULL UNIQUE, idle_seen_at INTEGER
    )`);
    const reservationColumns = this.sql.exec<{ name: string }>('PRAGMA table_info(reservations)').toArray();
    if (!reservationColumns.some((column) => column.name === 'idle_seen_at')) {
      this.sql.exec('ALTER TABLE reservations ADD COLUMN idle_seen_at INTEGER');
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'POST' && url.pathname === '/api/session') return await this.login(request);
      if (request.method === 'DELETE' && url.pathname === '/api/session') return await this.logout(request);
      if (request.method === 'GET' && url.pathname === '/v1/nodes/connect') return await this.connectNode(request, url);

      const auth = await this.authenticate(request);
      if (!auth.authenticated) return errorResponse('unauthorized', auth.status);
      if (request.method !== 'GET' && auth.kind === 'cookie' && !sameOriginRequest(request)) {
        return errorResponse('cross-origin cookie-authenticated write rejected', 403);
      }
      this.prune(Date.now());
      if (request.method === 'GET' && (url.pathname === '/api/fabric' || url.pathname === '/v1/resources')) return this.fabricState();
      if (request.method === 'POST' && url.pathname === '/v1/tasks') return await this.createTask(request);
      const taskMatch = /^\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === 'GET' && taskMatch) return this.getTask(decodeURIComponent(taskMatch[1]));
      return errorResponse('not found', 404);
    } catch (error) {
      if (error instanceof InputError) return errorResponse(error.message, error.status);
      return errorResponse('internal fabric error', 500);
    }
  }

  private token(): string | null {
    return configuredToken(this.env);
  }

  private async login(request: Request): Promise<Response> {
    if (!sameOriginRequest(request)) return errorResponse('cross-origin login rejected', 403);
    const secret = this.token();
    if (!secret) return errorResponse('FABRIC_TOKEN is not configured securely', 503);
    const body = await readJsonBody(request, 4096);
    const supplied = (body && typeof body === 'object' && !Array.isArray(body)) ? (body as Record<string, unknown>).token : undefined;
    if (typeof supplied !== 'string' || !constantTimeEqual(supplied, secret)) return errorResponse('unauthorized', 401);
    const session = await createSession(secret, Date.now() + 12 * 60 * 60 * 1000);
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true }, 200, { 'set-cookie': `fabric_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
  }

  private async logout(request: Request): Promise<Response> {
    const auth = await this.authenticate(request);
    if (!auth.authenticated) return errorResponse('unauthorized', auth.status);
    if (auth.kind === 'cookie' && !sameOriginRequest(request)) return errorResponse('cross-origin logout rejected', 403);
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return json({ ok: true }, 200, { 'set-cookie': `fabric_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}` });
  }

  private async authenticate(request: Request): Promise<{ authenticated: boolean; kind?: 'bearer' | 'cookie'; status: number }> {
    const secret = this.token();
    if (!secret) return { authenticated: false, status: 503 };
    const authorization = request.headers.get('authorization');
    if (authorization?.startsWith('Bearer ') && constantTimeEqual(authorization.slice(7), secret)) {
      return { authenticated: true, kind: 'bearer', status: 200 };
    }
    const cookie = parseCookies(request.headers.get('cookie')).get('fabric_session');
    if (cookie && await verifySession(cookie, secret)) return { authenticated: true, kind: 'cookie', status: 200 };
    return { authenticated: false, status: 401 };
  }

  private async connectNode(request: Request, url: URL): Promise<Response> {
    const auth = await this.authenticate(request);
    if (!auth.authenticated || auth.kind !== 'bearer') return errorResponse('node WebSocket requires bearer authentication', auth.status);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return errorResponse('WebSocket upgrade required', 426);
    const nodeId = url.searchParams.get('node_id');
    if (!validNodeId(nodeId)) return errorResponse('invalid node_id', 400);

    const connectionId = crypto.randomUUID();
    const old = this.sql.exec<{ connection_id: string }>('SELECT connection_id FROM connections WHERE node_id = ?', nodeId).toArray()[0];
    if (old) {
      this.failConnectionJobs(nodeId, old.connection_id, 'node connection replaced');
      for (const socket of this.ctx.getWebSockets(`node:${nodeId}`)) {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null;
        if (attachment?.connection_id === old.connection_id) socket.close(4001, 'replaced');
      }
    }
    this.sql.exec(`INSERT INTO connections(node_id, connection_id) VALUES (?, ?)
      ON CONFLICT(node_id) DO UPDATE SET connection_id=excluded.connection_id`, nodeId, connectionId);
    // A replacement connection must provide its own heartbeat before it can be
    // considered online; never schedule from the previous socket's snapshot.
    this.sql.exec('UPDATE nodes SET last_seen=0 WHERE node_id=?', nodeId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ node_id: nodeId, connection_id: connectionId } satisfies SocketAttachment);
    this.ctx.acceptWebSocket(server, [`node:${nodeId}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || !validNodeId(attachment.node_id)) {
      socket.close(1008, 'invalid attachment');
      return;
    }
    const current = this.sql.exec<{ connection_id: string }>('SELECT connection_id FROM connections WHERE node_id = ?', attachment.node_id).toArray()[0];
    if (!current || current.connection_id !== attachment.connection_id) {
      socket.close(4001, 'superseded');
      return;
    }
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : new Uint8Array(message);
    if (bytes.byteLength > LIMITS.socketMessageBytes) {
      socket.close(1009, 'message too large');
      return;
    }
    let packet: Record<string, unknown>;
    try {
      const raw = typeof message === 'string' ? message : new TextDecoder('utf-8', { fatal: true }).decode(message);
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      packet = parsed as Record<string, unknown>;
    } catch {
      socket.close(1007, 'invalid JSON');
      return;
    }
    try {
      if (packet.type === 'heartbeat') this.recordHeartbeat(attachment, packet.snapshot);
      else if (packet.type === 'result') this.recordResult(attachment, packet);
      else throw new InputError('unknown node message type');
    } catch (error) {
      socket.close(1008, error instanceof InputError ? error.message.slice(0, 120) : 'invalid message');
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.handleSocketGone(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    this.handleSocketGone(socket);
  }

  private handleSocketGone(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    const current = this.sql.exec<{ connection_id: string }>('SELECT connection_id FROM connections WHERE node_id = ?', attachment.node_id).toArray()[0];
    // A delayed close from a replaced socket must not remove the replacement.
    if (!current || current.connection_id !== attachment.connection_id) return;
    this.sql.exec('DELETE FROM connections WHERE node_id = ? AND connection_id = ?', attachment.node_id, attachment.connection_id);
    this.failConnectionJobs(attachment.node_id, attachment.connection_id, 'node disconnected during execution');
  }

  private recordHeartbeat(attachment: SocketAttachment, rawSnapshot: unknown): void {
    const serializedSize = new TextEncoder().encode(JSON.stringify(rawSnapshot)).byteLength;
    if (serializedSize > LIMITS.snapshotBytes) throw new InputError('snapshot too large', 413);
    const snapshot = sanitizeNodeSnapshot(rawSnapshot, attachment.node_id);
    const snapshotJson = JSON.stringify(snapshot);
    const now = Date.now();
    this.sql.exec(`INSERT INTO nodes(node_id, last_seen, snapshot_json) VALUES (?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET last_seen=excluded.last_seen, snapshot_json=excluded.snapshot_json`,
    attachment.node_id, now, snapshotJson);
    // A timeout does not prove local inference stopped. Keep its runtime reserved
    // until two heartbeats at least five seconds apart both report that lane idle.
    const quarantined = this.sql.exec<{ reservation_key: string; runtime_id: string; idle_seen_at: number | null }>(`
      SELECT r.reservation_key, j.runtime_id, r.idle_seen_at
      FROM reservations r JOIN jobs j ON j.id=r.job_id
      WHERE j.node_id=? AND j.status='expired'`, attachment.node_id).toArray();
    for (const item of quarantined) {
      const runtime = snapshot.runtimes.find((candidate) => candidate.id === item.runtime_id);
      if (!runtime || runtime.busy || runtime.state === 'generating') {
        this.sql.exec('UPDATE reservations SET idle_seen_at=NULL WHERE reservation_key=?', item.reservation_key);
      } else if (item.idle_seen_at === null) {
        this.sql.exec('UPDATE reservations SET idle_seen_at=? WHERE reservation_key=?', now, item.reservation_key);
      } else if (now - item.idle_seen_at >= 5_000) {
        this.sql.exec('DELETE FROM reservations WHERE reservation_key=?', item.reservation_key);
      }
    }
  }

  private recordResult(attachment: SocketAttachment, packet: Record<string, unknown>): void {
    if (!validJobId(packet.job_id)) throw new InputError('invalid job_id');
    const current = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', packet.job_id).toArray()[0];
    if (!current || current.status !== 'running') return;
    if (current.node_id !== attachment.node_id || current.connection_id !== attachment.connection_id) return;
    const activeConnection = this.sql.exec<{ connection_id: string }>('SELECT connection_id FROM connections WHERE node_id = ?', attachment.node_id).toArray()[0];
    if (!activeConnection || activeConnection.connection_id !== attachment.connection_id) return;
    const now = Date.now();
    if (current.deadline_at <= now) {
      this.sql.exec(`UPDATE jobs SET status='expired', completed_at=?, error='execution deadline exceeded' WHERE id=? AND status='running'`, now, current.id);
      this.scheduleNextAlarm();
      return;
    }
    if (packet.error !== undefined) {
      if (typeof packet.error !== 'string' || packet.error.length === 0) throw new InputError('result error must be a nonempty string');
      if (packet.status_code !== undefined && (!Number.isInteger(packet.status_code) || (packet.status_code as number) < 400 || (packet.status_code as number) > 599)) {
        throw new InputError('invalid result status_code');
      }
      this.finishJob(current.id, 'failed', now, null, packet.error.slice(0, 2048));
      return;
    }
    if (!packet.result || typeof packet.result !== 'object' || Array.isArray(packet.result)) throw new InputError('result must be an object');
    const resultJson = JSON.stringify(packet.result);
    if (new TextEncoder().encode(resultJson).byteLength > LIMITS.resultBytes) throw new InputError('result too large', 413);
    this.finishJob(current.id, 'succeeded', now, resultJson, null);
  }

  private finishJob(id: string, status: 'succeeded' | 'failed', completedAt: number, resultJson: string | null, error: string | null): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE jobs SET status=?, completed_at=?, result_json=?, error=? WHERE id=? AND status='running'`, status, completedAt, resultJson, error, id);
      this.sql.exec('DELETE FROM reservations WHERE job_id = ?', id);
    });
    this.scheduleNextAlarm();
  }

  private failConnectionJobs(nodeId: string, connectionId: string, message: string): void {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const jobs = this.sql.exec<{ id: string }>(`SELECT id FROM jobs WHERE node_id=? AND connection_id=? AND status='running'`, nodeId, connectionId).toArray();
      for (const job of jobs) {
        this.sql.exec(`UPDATE jobs SET status='failed', completed_at=?, error=? WHERE id=? AND status='running'`, now, message, job.id);
        this.sql.exec('DELETE FROM reservations WHERE job_id = ?', job.id);
      }
    });
    this.scheduleNextAlarm();
  }

  private fabricState(): Response {
    const now = Date.now();
    const nodeRows = this.sql.exec<NodeRow>(`SELECT n.node_id, n.last_seen, n.snapshot_json, c.connection_id
      FROM nodes n LEFT JOIN connections c ON c.node_id=n.node_id ORDER BY n.node_id`).toArray();
    const nodes = nodeRows.map((row) => ({
      node_id: row.node_id,
      last_seen: row.last_seen,
      snapshot: JSON.parse(row.snapshot_json) as NodeSnapshot,
      connected: row.connection_id !== null && this.socketFor(row.node_id, row.connection_id) !== null,
    }));
    const jobs = this.sql.exec<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?', LIMITS.jobsReturned).toArray().map(jobFromRow);
    return json(aggregateFabricState(nodes, jobs, now));
  }

  private getTask(id: string): Response {
    if (!validJobId(id)) return errorResponse('invalid job id', 400);
    const row = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', id).toArray()[0];
    return row ? json(jobFromRow(row)) : errorResponse('job not found', 404);
  }

  private async createTask(request: Request): Promise<Response> {
    const task = parseTaskRequest(await readJsonBody(request, LIMITS.requestBytes));
    const prefix = task.prefix ?? '';
    const prefixHash = prefix ? await sha256Hex(prefix) : null;
    const prefixBytes = new TextEncoder().encode(prefix).byteLength;
    const now = Date.now();
    const nodes = this.schedulableNodes();
    const reserved = new Set(this.sql.exec<{ reservation_key: string }>('SELECT reservation_key FROM reservations').toArray().map((row) => row.reservation_key));
    const candidates = placementCandidates(nodes, task, prefixHash, prefixBytes, reserved, now);
    let selected = null as (typeof candidates)[number] | null;
    let jobId = '';
    for (const candidate of candidates) {
      const candidateJobId = crypto.randomUUID();
      const won = this.ctx.storage.transactionSync(() => {
        this.sql.exec('INSERT OR IGNORE INTO reservations(reservation_key, job_id) VALUES (?, ?)', candidate.reservation_key, candidateJobId);
        const owner = this.sql.exec<{ job_id: string }>('SELECT job_id FROM reservations WHERE reservation_key=?', candidate.reservation_key).toArray()[0];
        if (!owner || owner.job_id !== candidateJobId) return false;
        this.sql.exec(`INSERT INTO jobs(id,status,capability,node_id,model_id,runtime_id,connection_id,created_at,deadline_at,placement_reason)
          VALUES (?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidateJobId, task.capability, candidate.node_id, candidate.model_id, candidate.runtime_id,
        candidate.connection_id, now, now + LIMITS.jobTimeoutMs, candidate.placement_reason);
        return true;
      });
      if (won) {
        selected = candidate;
        jobId = candidateJobId;
        break;
      }
    }
    if (!selected) return errorResponse('no online idle node satisfies the requested capability and simulation policy', 409);

    const executeRequest: Omit<TaskRequest, 'allow_simulated'> = {
      capability: task.capability,
      prompt: task.prompt,
      prefix,
      model_id: selected.model_id,
    };
    if (task.max_tokens !== undefined) executeRequest.max_tokens = task.max_tokens;
    if (task.temperature !== undefined) executeRequest.temperature = task.temperature;
    const socket = this.socketFor(selected.node_id, selected.connection_id);
    try {
      if (!socket) throw new Error('selected node socket is unavailable');
      socket.send(JSON.stringify({ type: 'execute', job_id: jobId, request: executeRequest }));
      this.scheduleNextAlarm();
    } catch {
      this.finishJob(jobId, 'failed', Date.now(), null, 'node disconnected before dispatch');
    }
    const row = this.sql.exec<JobRow>('SELECT * FROM jobs WHERE id = ?', jobId).one();
    return json(jobFromRow(row), 202);
  }

  private schedulableNodes(): SchedulableNode[] {
    const rows = this.sql.exec<NodeRow>(`SELECT n.node_id, n.last_seen, n.snapshot_json, c.connection_id
      FROM nodes n JOIN connections c ON c.node_id=n.node_id`).toArray();
    return rows.flatMap((row) => {
      if (!row.connection_id || !this.socketFor(row.node_id, row.connection_id)) return [];
      return [{ node_id: row.node_id, last_seen: row.last_seen, snapshot: JSON.parse(row.snapshot_json) as NodeSnapshot, connected: true, connection_id: row.connection_id }];
    });
  }

  private socketFor(nodeId: string, connectionId: string): WebSocket | null {
    return this.ctx.getWebSockets(`node:${nodeId}`).find((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      return attachment?.connection_id === connectionId && socket.readyState === WebSocket.OPEN;
    }) ?? null;
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const expired = this.sql.exec<{ id: string }>(`SELECT id FROM jobs WHERE status='running' AND deadline_at <= ?`, now).toArray();
      for (const job of expired) {
        this.sql.exec(`UPDATE jobs SET status='expired', completed_at=?, error='execution deadline exceeded' WHERE id=? AND status='running'`, now, job.id);
      }
    });
    this.prune(now);
    this.scheduleNextAlarm();
  }

  private scheduleNextAlarm(): void {
    const next = this.sql.exec<{ deadline_at: number }>(`SELECT MIN(deadline_at) AS deadline_at FROM jobs WHERE status='running'`).toArray()[0];
    if (next && typeof next.deadline_at === 'number') this.ctx.waitUntil(this.ctx.storage.setAlarm(next.deadline_at));
    else this.ctx.waitUntil(this.ctx.storage.deleteAlarm());
  }

  private prune(now: number): void {
    this.ctx.storage.transactionSync(() => {
      // Alarms are at-least-once and may be delayed. API reads still expose a
      // truthful deadline state without releasing the quarantined runtime.
      this.sql.exec(`UPDATE jobs SET status='expired', completed_at=?, error='execution deadline exceeded'
        WHERE status='running' AND deadline_at <= ?`, now, now);
      this.sql.exec(`DELETE FROM jobs WHERE status != 'running' AND completed_at < ?`, now - LIMITS.jobRetentionMs);
      this.sql.exec(`DELETE FROM nodes WHERE last_seen < ? AND node_id NOT IN (SELECT node_id FROM connections)`, now - LIMITS.nodeRetentionMs);
      this.sql.exec(`DELETE FROM reservations WHERE job_id NOT IN (SELECT id FROM jobs)`);
    });
  }
}

function jobFromRow(row: JobRow): FabricJob {
  const job: FabricJob = {
    id: row.id,
    status: row.status,
    capability: row.capability,
    node_id: row.node_id,
    model_id: row.model_id,
    runtime_id: row.runtime_id,
    created_at: row.created_at,
    placement_reason: row.placement_reason,
  };
  if (row.completed_at !== null) job.completed_at = row.completed_at;
  if (row.result_json !== null) job.result = JSON.parse(row.result_json) as Record<string, unknown>;
  if (row.error !== null) job.error = row.error;
  return job;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of header?.split(';') ?? []) {
    const index = part.indexOf('=');
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function constantTimeEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    difference |= (left.charCodeAt(index % Math.max(left.length, 1)) || 0) ^ (right.charCodeAt(index % Math.max(right.length, 1)) || 0);
  }
  return difference === 0;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sessionSignature(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))));
}

async function createSession(secret: string, expiresAt: number): Promise<string> {
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const payload = `${expiresAt}.${nonce}`;
  return `${payload}.${await sessionSignature(payload, secret)}`;
}

async function verifySession(session: string, secret: string): Promise<boolean> {
  const parts = session.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{20,32}$/.test(parts[1])) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  return constantTimeEqual(parts[2], await sessionSignature(payload, secret));
}
