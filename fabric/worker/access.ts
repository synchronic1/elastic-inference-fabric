import type {
  FabricAccessToken,
  FabricPrincipal,
  FabricRole,
  IssuedFabricToken,
} from '../src/access-contracts';
import { InputError, validNodeId } from './domain';

const TOKEN_PREFIX = 'fat_';
const SESSION_PREFIX = 'fas_';
const SECRET_BYTES = 32;
const DEFAULT_EXPIRY_DAYS = 30;
const MAX_EXPIRY_DAYS = 365;
const MAX_ACTIVE_TOKENS = 1_000;
const MAX_ACTIVE_SESSIONS_PER_PRINCIPAL = 100;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;

interface AccessTokenRow extends Record<string, SqlStorageValue> {
  id: string;
  secret_hash: string;
  token_prefix: string;
  label: string;
  role: FabricRole;
  node_id: string | null;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

interface SessionRow extends Record<string, SqlStorageValue> {
  session_hash: string;
  principal_id: string;
  bootstrap_fingerprint: string | null;
  created_at: number;
  expires_at: number;
}

export class AccessError extends InputError {}

export class AccessStore {
  constructor(
    private readonly sql: SqlStorage,
    private readonly bootstrapToken: string | null,
  ) {}

  initialize(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS access_tokens (
      id TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      label TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'agent', 'node')),
      node_id TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      last_used_at INTEGER
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS access_tokens_active ON access_tokens(revoked_at, expires_at)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS access_sessions (
      session_hash TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      bootstrap_fingerprint TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    this.sql.exec('CREATE INDEX IF NOT EXISTS access_sessions_principal ON access_sessions(principal_id)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS access_sessions_expiry ON access_sessions(expires_at)');
    this.pruneSessions(Date.now());
  }

  async authenticateBearer(token: string): Promise<FabricPrincipal | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
    if (this.hasBootstrapToken() && constantTimeEqual(token, this.bootstrapToken as string)) {
      return bootstrapPrincipal();
    }
    if (!validOpaqueSecret(token, TOKEN_PREFIX)) return null;
    const hash = await sha256Hex(token);
    const row = this.sql.exec<AccessTokenRow>('SELECT * FROM access_tokens WHERE secret_hash=?', hash).toArray()[0];
    const now = Date.now();
    if (!row || !rowIsActive(row, now)) return null;
    this.sql.exec('UPDATE access_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL', now, row.id);
    return principalFromRow(row);
  }

  async authenticateSession(cookie: string): Promise<FabricPrincipal | null> {
    if (!validOpaqueSecret(cookie, SESSION_PREFIX)) return null;
    const hash = await sha256Hex(cookie);
    const session = this.sql.exec<SessionRow>('SELECT * FROM access_sessions WHERE session_hash=?', hash).toArray()[0];
    const now = Date.now();
    if (!session) return null;
    if (session.expires_at <= now) {
      this.sql.exec('DELETE FROM access_sessions WHERE session_hash=?', hash);
      return null;
    }
    if (session.principal_id === 'bootstrap-admin') {
      if (!this.hasBootstrapToken()) {
        this.sql.exec('DELETE FROM access_sessions WHERE session_hash=?', hash);
        return null;
      }
      const currentFingerprint = await sha256Hex(this.bootstrapToken as string);
      if (!session.bootstrap_fingerprint || !constantTimeEqual(session.bootstrap_fingerprint, currentFingerprint)) {
        this.sql.exec('DELETE FROM access_sessions WHERE session_hash=?', hash);
        return null;
      }
      return bootstrapPrincipal();
    }
    const principal = this.getPrincipal(session.principal_id);
    if (!principal) {
      this.sql.exec('DELETE FROM access_sessions WHERE session_hash=?', hash);
      return null;
    }
    this.sql.exec('UPDATE access_tokens SET last_used_at=? WHERE id=? AND revoked_at IS NULL', now, principal.id);
    return principal;
  }

  async createToken(raw: unknown, authorize?: () => void): Promise<IssuedFabricToken> {
    const input = validateCreateToken(raw);
    const now = Date.now();
    const token = TOKEN_PREFIX + randomSecret();
    const hash = await sha256Hex(token);
    // Count immediately before the synchronous insert so an await cannot race the cap.
    const active = this.sql.exec<{ count: number }>(`
      SELECT COUNT(*) AS count FROM access_tokens
      WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`, now).one().count;
    if (active >= MAX_ACTIVE_TOKENS) throw new AccessError('active token limit reached', 409);

    const id = crypto.randomUUID();
    const expiresAt = now + input.expiresInDays * 24 * 60 * 60 * 1000;
    // The caller can synchronously revalidate its admin principal after the
    // hashing await and immediately before this authority-creating write.
    authorize?.();
    this.sql.exec(`INSERT INTO access_tokens(
      id, secret_hash, token_prefix, label, role, node_id, created_at, expires_at, revoked_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    id, hash, token.slice(0, 12), input.label, input.role, input.nodeId, now, expiresAt);
    const row = this.sql.exec<AccessTokenRow>('SELECT * FROM access_tokens WHERE id=?', id).one();
    return { token, access: accessTokenFromRow(row) };
  }

  listTokens(): FabricAccessToken[] {
    const now = Date.now();
    this.pruneSessions(now);
    return this.sql.exec<AccessTokenRow>('SELECT * FROM access_tokens ORDER BY created_at DESC, id ASC')
      .toArray().map(accessTokenFromRow);
  }

  revokeToken(id: string): boolean {
    if (!validUuid(id) || id === 'bootstrap-admin') return false;
    const row = this.sql.exec<{ revoked_at: number | null }>('SELECT revoked_at FROM access_tokens WHERE id=?', id).toArray()[0];
    if (!row || row.revoked_at !== null) return false;
    const now = Date.now();
    this.sql.exec('UPDATE access_tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, id);
    // Authentication also checks revocation synchronously, so the update invalidates
    // sessions even if cleanup were interrupted.
    this.sql.exec('DELETE FROM access_sessions WHERE principal_id=?', id);
    return true;
  }

  async createSession(principal: FabricPrincipal): Promise<string> {
    const now = Date.now();
    const initial = this.getPrincipal(principal.id);
    if (!initial) throw new AccessError('principal is no longer authorized', 401);
    this.pruneSessions(now);
    const cookie = SESSION_PREFIX + randomSecret();
    const sessionHash = await sha256Hex(cookie);
    const bootstrapFingerprint = initial.id === 'bootstrap-admin'
      ? await sha256Hex(this.bootstrapToken as string)
      : null;
    // All crypto awaits are complete. Recheck revocation/expiry synchronously
    // and derive expiry from the current record immediately before insertion.
    const current = this.getPrincipal(principal.id);
    if (!current) throw new AccessError('principal is no longer authorized', 401);
    const count = this.sql.exec<{ count: number }>(
      'SELECT COUNT(*) AS count FROM access_sessions WHERE principal_id=? AND expires_at>?',
      current.id, now,
    ).one().count;
    if (count >= MAX_ACTIVE_SESSIONS_PER_PRINCIPAL) throw new AccessError('active session limit reached', 409);
    const expiresAt = Math.min(now + SESSION_LIFETIME_MS, current.expires_at ?? Number.MAX_SAFE_INTEGER);
    if (expiresAt <= now) throw new AccessError('principal is expired', 401);
    this.sql.exec(`INSERT INTO access_sessions(
      session_hash, principal_id, bootstrap_fingerprint, created_at, expires_at
    ) VALUES (?, ?, ?, ?, ?)`, sessionHash, current.id, bootstrapFingerprint, now, expiresAt);
    return cookie;
  }

  async deleteSession(cookie: string): Promise<void> {
    if (!validOpaqueSecret(cookie, SESSION_PREFIX)) return;
    this.sql.exec('DELETE FROM access_sessions WHERE session_hash=?', await sha256Hex(cookie));
  }

  getPrincipal(id: string): FabricPrincipal | null {
    if (id === 'bootstrap-admin') return this.hasBootstrapToken() ? bootstrapPrincipal() : null;
    if (!validUuid(id)) return null;
    const row = this.sql.exec<AccessTokenRow>('SELECT * FROM access_tokens WHERE id=?', id).toArray()[0];
    return row && rowIsActive(row, Date.now()) ? principalFromRow(row) : null;
  }

  private hasBootstrapToken(): boolean {
    return typeof this.bootstrapToken === 'string' && this.bootstrapToken.length > 0;
  }

  private pruneSessions(now: number): void {
    this.sql.exec('DELETE FROM access_sessions WHERE expires_at <= ?', now);
    this.sql.exec(`DELETE FROM access_sessions
      WHERE principal_id != 'bootstrap-admin' AND principal_id NOT IN (
        SELECT id FROM access_tokens
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
      )`, now);
  }
}

interface ValidatedCreateToken {
  label: string;
  role: FabricRole;
  nodeId: string | null;
  expiresInDays: number;
}

function validateCreateToken(raw: unknown): ValidatedCreateToken {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AccessError('token request must be an object');
  const value = raw as Record<string, unknown>;
  const allowed = new Set(['label', 'role', 'node_id', 'expires_in_days']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new AccessError(`unknown token field: ${key}`);
  }
  if (typeof value.label !== 'string') throw new AccessError('label must be a string');
  const label = value.label.trim();
  if (label.length < 1 || label.length > 80 || /\p{Cc}/u.test(label)) {
    throw new AccessError('label must be 1 to 80 characters without control characters');
  }
  const role = value.role === undefined ? 'agent' : value.role;
  if (role !== 'admin' && role !== 'agent' && role !== 'node') throw new AccessError('role must be admin, agent, or node');
  let nodeId: string | null = null;
  if (role === 'node') {
    if (!validNodeId(value.node_id)) throw new AccessError('node tokens require a valid node_id');
    nodeId = value.node_id;
  } else if (value.node_id !== undefined) {
    throw new AccessError('only node tokens may bind node_id');
  }
  const expiresInDays = value.expires_in_days === undefined ? DEFAULT_EXPIRY_DAYS : value.expires_in_days;
  if (!Number.isInteger(expiresInDays) || typeof expiresInDays !== 'number' || expiresInDays < 1 || expiresInDays > MAX_EXPIRY_DAYS) {
    throw new AccessError(`expires_in_days must be an integer from 1 to ${MAX_EXPIRY_DAYS}`);
  }
  return { label, role, nodeId, expiresInDays };
}

function bootstrapPrincipal(): FabricPrincipal {
  return {
    id: 'bootstrap-admin',
    label: 'Bootstrap administrator',
    role: 'admin',
    node_id: null,
    expires_at: null,
  };
}

function principalFromRow(row: AccessTokenRow): FabricPrincipal {
  return {
    id: row.id,
    label: row.label,
    role: row.role,
    node_id: row.node_id,
    expires_at: row.expires_at,
  };
}

function accessTokenFromRow(row: AccessTokenRow): FabricAccessToken {
  return {
    ...principalFromRow(row),
    token_prefix: row.token_prefix,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    last_used_at: row.last_used_at,
  };
}

function rowIsActive(row: AccessTokenRow, now: number): boolean {
  return row.revoked_at === null && (row.expires_at === null || row.expires_at > now);
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validOpaqueSecret(value: unknown, prefix: string): value is string {
  return typeof value === 'string'
    && value.length === prefix.length + 43
    && value.startsWith(prefix)
    && /^[A-Za-z0-9_-]+$/.test(value.slice(prefix.length));
}

function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function constantTimeEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    difference |= (left.charCodeAt(index % Math.max(left.length, 1)) || 0)
      ^ (right.charCodeAt(index % Math.max(right.length, 1)) || 0);
  }
  return difference === 0;
}
