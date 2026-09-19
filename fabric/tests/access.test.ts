import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { AccessError, AccessStore } from '../worker/access';

interface TestCursor<T> {
  toArray(): T[];
  one(): T;
  readonly rowsWritten: number;
}

function sqlAdapter(database: DatabaseSync): SqlStorage {
  return {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: any[]): TestCursor<T> {
      const statement = database.prepare(query);
      let rows: T[] = [];
      let rowsWritten = 0;
      if (statement.columns().length > 0) {
        rows = statement.all(...bindings) as T[];
      } else {
        rowsWritten = Number(statement.run(...bindings).changes);
      }
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`expected one row, got ${rows.length}`);
          return rows[0];
        },
        rowsWritten,
      };
    },
  } as unknown as SqlStorage;
}

function setup(bootstrapToken: string | null = 'legacy-bootstrap-secret'): { database: DatabaseSync; store: AccessStore } {
  const database = new DatabaseSync(':memory:');
  const store = new AccessStore(sqlAdapter(database), bootstrapToken);
  store.initialize();
  return { database, store };
}

describe('token issuance and validation', () => {
  it('supports explicit non-expiry without changing the 30-day default', async () => {
    const { database, store } = setup();
    const issued = await store.createToken({ label: 'Persistent demo', role: 'agent', expires_in_days: null });
    assert.equal(issued.access.expires_at, null);
    const session = await store.createSession(issued.access);
    const row = database.prepare('SELECT expires_at FROM access_sessions').get() as { expires_at: number };
    assert.ok(row.expires_at > Date.now() && row.expires_at <= Date.now() + 43_200_000);
    assert.equal((await store.authenticateSession(session))?.role, 'agent');
    store.revokeToken(issued.access.id);
    assert.equal(await store.authenticateBearer(issued.token), null);
    assert.equal(await store.authenticateSession(session), null);
  });

  it('updates only active agent/viewer metadata while preserving secrets, identity and sessions', async () => {
    const { database, store } = setup();
    const viewer = await store.createToken({ label: 'Demo', role: 'viewer', expires_in_days: 1 });
    const session = await store.createSession(viewer.access);
    const before = database.prepare('SELECT secret_hash FROM access_tokens WHERE id=?').get(viewer.access.id);
    const updated = store.updateToken(viewer.access.id, { role: 'agent', expires_in_days: null });
    assert.equal(updated.role, 'agent');
    assert.equal(updated.expires_at, null);
    assert.equal(updated.id, viewer.access.id);
    assert.deepEqual(database.prepare('SELECT secret_hash FROM access_tokens WHERE id=?').get(viewer.access.id), before);
    assert.ok(!JSON.stringify(updated).includes(viewer.token));
    assert.equal(Object.hasOwn(updated, 'secret_hash'), false);
    assert.equal((await store.authenticateBearer(viewer.token))?.role, 'agent');
    assert.equal((await store.authenticateSession(session))?.role, 'agent');
    store.updateToken(viewer.access.id, { role: 'viewer' });
    assert.equal((await store.authenticateSession(session))?.role, 'viewer');
    assert.equal(store.getPrincipal(viewer.access.id)?.expires_at, null);
    const renewed = store.updateToken(viewer.access.id, { expires_in_days: 7 });
    assert.equal(renewed.role, 'viewer');
    assert.ok(renewed.expires_at! >= Date.now() + 7 * 86_400_000 - 1000);
    for (const body of [{}, { role: 'admin' }, { role: 'node' }, { node_id: 'changed' }, { secret_hash: 'changed' }, { expires_in_days: 0 }, { expires_in_days: 1.5 }, { expires_in_days: 366 }, { expires_in_days: 'never' }]) {
      assert.throws(() => store.updateToken(viewer.access.id, body), AccessError);
    }
    const admin = await store.createToken({ label: 'Admin', role: 'admin' });
    const node = await store.createToken({ label: 'Node', role: 'node', node_id: 'smoke-node' });
    for (const token of [admin, node]) {
      assert.throws(() => store.updateToken(token.access.id, { role: 'agent' }), (error: unknown) => error instanceof AccessError && error.status === 403);
    }
    database.prepare('UPDATE access_tokens SET expires_at=? WHERE id=?').run(Date.now() - 1, viewer.access.id);
    assert.throws(() => store.updateToken(viewer.access.id, { expires_in_days: null }), /active token not found/);
    store.revokeToken(viewer.access.id);
    assert.throws(() => store.updateToken(viewer.access.id, { role: 'agent' }), /active token not found/);
    assert.throws(() => store.updateToken('bootstrap-admin', { role: 'agent' }), /active token not found/);
  });

  it('issues expiring viewer tokens, supports sessions, and immediately revokes both', async () => {
    const { database, store } = setup();
    const issued = await store.createToken({ label: 'Shared demo viewer', role: 'viewer', expires_in_days: 1 });
    assert.equal(issued.access.role, 'viewer');
    assert.equal(issued.access.node_id, null);
    assert.equal(issued.access.expires_at! - issued.access.created_at, 86_400_000);
    const session = await store.createSession(issued.access);
    assert.equal((await store.authenticateSession(session))?.role, 'viewer');
    assert.equal((await store.authenticateBearer(issued.token))?.role, 'viewer');
    await assert.rejects(store.createToken({ label: 'Invalid viewer', role: 'viewer', node_id: 'mac-01' }), /only node tokens/);
    assert.equal(store.revokeToken(issued.access.id), true);
    assert.equal(await store.authenticateBearer(issued.token), null);
    assert.equal(await store.authenticateSession(session), null);
    const expiring = await store.createToken({ label: 'Expired demo', role: 'viewer', expires_in_days: 1 });
    const expiringSession = await store.createSession(expiring.access);
    database.prepare('UPDATE access_tokens SET expires_at=? WHERE id=?').run(Date.now() - 1, expiring.access.id);
    assert.equal(await store.authenticateBearer(expiring.token), null);
    assert.equal(await store.authenticateSession(expiringSession), null);
  });

  it('migrates the legacy role constraint without losing tokens or sessions and is idempotent', async () => {
    const { database, store } = setup();
    const admin = await store.createToken({ label: 'Existing admin', role: 'admin' });
    const agent = await store.createToken({ label: 'Existing agent', role: 'agent' });
    const node = await store.createToken({ label: 'Existing node', role: 'node', node_id: 'mac-01' });
    const revoked = await store.createToken({ label: 'Revoked agent', role: 'agent' });
    store.revokeToken(revoked.access.id);
    const session = await store.createSession(admin.access);
    const rows = database.prepare('SELECT * FROM access_tokens ORDER BY id').all();
    const sessions = database.prepare('SELECT * FROM access_sessions').all();
    // Reconstruct the actual pre-viewer CHECK constraint with the same rows.
    const schema = (database.prepare("SELECT sql FROM sqlite_master WHERE name='access_tokens'").get() as { sql: string }).sql;
    database.exec('ALTER TABLE access_tokens RENAME TO saved_tokens');
    database.exec(schema.replace(", 'viewer'", ''));
    database.exec('INSERT INTO access_tokens SELECT * FROM saved_tokens');
    database.exec('DROP TABLE saved_tokens');
    assert.throws(() => database.prepare("UPDATE access_tokens SET role='viewer' WHERE id=?").run(agent.access.id), /CHECK/);
    database.exec('BEGIN');
    try { store.initialize(); store.initialize(); database.exec('COMMIT'); }
    catch (error) { database.exec('ROLLBACK'); throw error; }
    assert.deepEqual(database.prepare('SELECT * FROM access_tokens ORDER BY id').all(), rows);
    assert.deepEqual(database.prepare('SELECT * FROM access_sessions').all(), sessions);
    assert.equal((await store.authenticateSession(session))?.id, admin.access.id);
    assert.equal((await store.authenticateBearer(agent.token))?.role, 'agent');
    assert.equal((await store.authenticateBearer(node.token))?.node_id, 'mac-01');
    assert.equal(await store.authenticateBearer(revoked.token), null);
    assert.equal((await store.createToken({ label: 'New viewer', role: 'viewer' })).access.role, 'viewer');
    assert.ok(database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='access_tokens_active'").get());
    assert.equal(database.prepare("SELECT name FROM sqlite_master WHERE name='access_tokens_pre_viewer'").get(), undefined);
  });

  it('defaults to a 30-day agent and persists only a SHA-256 hash', async () => {
    const { database, store } = setup();
    const before = Date.now();
    const first = await store.createToken({ label: 'Build agent' });
    const second = await store.createToken({ label: 'Second agent', role: 'agent' });
    assert.match(first.token, /^fat_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first.token, second.token);
    assert.equal(first.access.role, 'agent');
    assert.equal(first.access.node_id, null);
    assert.ok(first.access.expires_at !== null);
    assert.ok(first.access.expires_at >= before + 30 * 86_400_000);
    assert.ok(first.access.expires_at <= Date.now() + 30 * 86_400_000);
    assert.equal(first.access.token_prefix, first.token.slice(0, 12));

    const stored = database.prepare('SELECT secret_hash, token_prefix FROM access_tokens WHERE id=?').get(first.access.id) as {
      secret_hash: string; token_prefix: string;
    };
    assert.match(stored.secret_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(stored.secret_hash, first.token);
    assert.equal(stored.token_prefix, first.token.slice(0, 12));
    assert.equal(JSON.stringify(database.prepare('SELECT * FROM access_tokens').all()).includes(first.token), false);
  });

  it('enforces roles, node binding, labels, expiry, and exact input fields', async () => {
    const { store } = setup();
    const node = await store.createToken({ label: 'Mac node', role: 'node', node_id: 'mac-01', expires_in_days: 365 });
    assert.equal(node.access.node_id, 'mac-01');
    assert.equal(node.access.role, 'node');

    await assert.rejects(store.createToken({ label: '', role: 'agent' }), AccessError);
    await assert.rejects(store.createToken({ label: 'bad', role: 'owner' }), /role must/);
    await assert.rejects(store.createToken({ label: 'node', role: 'node' }), /require a valid node_id/);
    await assert.rejects(store.createToken({ label: 'agent', role: 'agent', node_id: 'mac-01' }), /only node tokens/);
    await assert.rejects(store.createToken({ label: 'agent', role: 'agent', expires_in_days: 0 }), /expires_in_days/);
    await assert.rejects(store.createToken({ label: 'agent', role: 'agent', expires_in_days: 366 }), /expires_in_days/);
    await assert.rejects(store.createToken({ label: 'agent', role: 'agent', expires_in_days: 1.5 }), /expires_in_days/);
    await assert.rejects(store.createToken({ label: 'agent', role: 'agent', extra: true }), /unknown token field/);
  });

  it('authenticates valid tokens, rejects malformed and expired tokens, and tracks use', async () => {
    const { database, store } = setup();
    const issued = await store.createToken({ label: 'API client', role: 'agent' });
    assert.equal(await store.authenticateBearer('fat_short'), null);
    assert.equal(await store.authenticateBearer(''), null);
    assert.deepEqual(await store.authenticateBearer(issued.token), {
      id: issued.access.id,
      label: 'API client',
      role: 'agent',
      node_id: null,
      expires_at: issued.access.expires_at,
    });
    assert.equal(store.listTokens()[0].last_used_at !== null, true);

    database.prepare('UPDATE access_tokens SET expires_at=? WHERE id=?').run(Date.now() - 1, issued.access.id);
    assert.equal(store.getPrincipal(issued.access.id), null);
    assert.equal(await store.authenticateBearer(issued.token), null);
  });

  it('runs caller authorization synchronously at the token insert boundary', async () => {
    const { database, store } = setup();
    let checked = false;
    const issued = await store.createToken({ label: 'Allowed' }, () => { checked = true; });
    assert.equal(checked, true);
    assert.ok(store.getPrincipal(issued.access.id));
    await assert.rejects(
      store.createToken({ label: 'Denied' }, () => { throw new AccessError('admin revoked', 403); }),
      (error: unknown) => error instanceof AccessError && error.status === 403,
    );
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM access_tokens').get() as { count: number }).count, 1);
  });
});

describe('sessions and immediate rechecks', () => {
  it('hashes opaque sessions, caps them at token expiry, and deletes them', async () => {
    const { database, store } = setup();
    const issued = await store.createToken({ label: 'Short lived', role: 'agent' });
    const shortenedExpiry = Date.now() + 60_000;
    database.prepare('UPDATE access_tokens SET expires_at=? WHERE id=?').run(shortenedExpiry, issued.access.id);
    const current = store.getPrincipal(issued.access.id);
    assert.ok(current);
    const session = await store.createSession(current);
    assert.match(session, /^fas_[A-Za-z0-9_-]{43}$/);
    const persisted = database.prepare('SELECT session_hash, expires_at FROM access_sessions').get() as { session_hash: string; expires_at: number };
    assert.match(persisted.session_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(persisted.session_hash, session);
    assert.ok(persisted.expires_at <= shortenedExpiry);
    assert.equal((await store.authenticateSession(session))?.id, issued.access.id);
    await store.deleteSession(session);
    assert.equal(await store.authenticateSession(session), null);
  });

  it('revocation invalidates bearer, sync principal lookup, and every linked session', async () => {
    const { database, store } = setup();
    const issued = await store.createToken({ label: 'Revocable', role: 'admin' });
    const principal = await store.authenticateBearer(issued.token);
    assert.ok(principal);
    const sessionA = await store.createSession(principal);
    const sessionB = await store.createSession(principal);
    assert.equal(store.revokeToken(issued.access.id), true);
    assert.equal(store.revokeToken(issued.access.id), false);
    assert.equal(store.getPrincipal(issued.access.id), null);
    assert.equal(await store.authenticateBearer(issued.token), null);
    assert.equal(await store.authenticateSession(sessionA), null);
    assert.equal(await store.authenticateSession(sessionB), null);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM access_sessions WHERE principal_id=?').get(issued.access.id) as { count: number }).count, 0);
    const listed = store.listTokens().find((token) => token.id === issued.access.id);
    assert.ok(listed?.revoked_at !== null);
  });

  it('rejects a stale principal passed after expiry', async () => {
    const { database, store } = setup();
    const issued = await store.createToken({ label: 'Expiring', role: 'agent' });
    database.prepare('UPDATE access_tokens SET expires_at=? WHERE id=?').run(Date.now() - 1, issued.access.id);
    await assert.rejects(store.createSession(issued.access), (error: unknown) => error instanceof AccessError && error.status === 401);
  });

  it('rechecks principal revocation after asynchronous session hashing', async () => {
    const { database, store } = setup();
    const issued = await store.createToken({ label: 'Racing principal', role: 'agent' });
    const pending = store.createSession(issued.access);
    assert.equal(store.revokeToken(issued.access.id), true);
    await assert.rejects(pending, (error: unknown) => error instanceof AccessError && error.status === 401);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM access_sessions').get() as { count: number }).count, 0);
  });
});

describe('bootstrap administrator', () => {
  it('supports a legacy nonempty secret without persisting it', async () => {
    const { database, store } = setup('x');
    assert.deepEqual(await store.authenticateBearer('x'), {
      id: 'bootstrap-admin', label: 'Bootstrap administrator', role: 'admin', node_id: null, expires_at: null,
    });
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM access_tokens').get()!.count, 0);
    assert.equal(store.revokeToken('bootstrap-admin'), false);
  });

  it('binds bootstrap sessions to the current token fingerprint across rotation', async () => {
    const database = new DatabaseSync(':memory:');
    const sql = sqlAdapter(database);
    const oldStore = new AccessStore(sql, 'old-bootstrap-token');
    oldStore.initialize();
    const principal = await oldStore.authenticateBearer('old-bootstrap-token');
    assert.ok(principal);
    const oldSession = await oldStore.createSession(principal);
    assert.equal((await oldStore.authenticateSession(oldSession))?.id, 'bootstrap-admin');

    const rotatedStore = new AccessStore(sql, 'new-bootstrap-token');
    rotatedStore.initialize();
    assert.equal(await rotatedStore.authenticateBearer('old-bootstrap-token'), null);
    assert.equal(await rotatedStore.authenticateSession(oldSession), null);
    assert.equal((await rotatedStore.authenticateBearer('new-bootstrap-token'))?.id, 'bootstrap-admin');
  });

  it('disables bootstrap authentication when the environment secret is empty', async () => {
    const { store } = setup(null);
    assert.equal(await store.authenticateBearer('anything'), null);
    assert.equal(store.getPrincipal('bootstrap-admin'), null);
  });
});
