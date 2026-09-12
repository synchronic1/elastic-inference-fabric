import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { CreateFabricToken, FabricAccessToken, FabricPrincipal, FabricRole, IssuedFabricToken } from './access-contracts';
import './access.css';

type TokenForm = { label: string; role: FabricRole; node_id: string; expires_in_days: string };
const initialForm: TokenForm = { label: '', role: 'agent', node_id: '', expires_in_days: '30' };

async function accessApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'include', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  if (!response.ok) throw new Error((await response.text()) || `${response.status} ${response.statusText}`);
  return response.json() as Promise<T>;
}
function when(value: number | null) { return value ? new Date(value).toLocaleString() : 'Never'; }

export default function AccessPanel() {
  const [principal, setPrincipal] = useState<FabricPrincipal | null>(null);
  const [tokens, setTokens] = useState<FabricAccessToken[]>([]);
  const [form, setForm] = useState<TokenForm>(initialForm);
  const [issued, setIssued] = useState<IssuedFabricToken | null>(null);
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const me = await accessApi<{ principal: FabricPrincipal }>('/api/me');
      setPrincipal(me.principal);
      if (me.principal.role === 'admin') setTokens((await accessApi<{ tokens: FabricAccessToken[] }>('/api/tokens')).tokens);
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Access details are unavailable.'); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create(event: FormEvent) {
    event.preventDefault(); setNotice('');
    const days = Number(form.expires_in_days);
    if (!form.label.trim() || !Number.isInteger(days) || days < 1 || days > 365 || (form.role === 'node' && !form.node_id.trim())) { setNotice('Provide a label, 1–365 days, and a node ID for node tokens.'); return; }
    const payload: CreateFabricToken = { label: form.label.trim(), role: form.role, expires_in_days: days, ...(form.role === 'node' ? { node_id: form.node_id.trim() } : {}) };
    setBusy(true);
    try { const next = await accessApi<IssuedFabricToken>('/api/tokens', { method: 'POST', body: JSON.stringify(payload) }); setIssued(next); setReveal(false); setForm(initialForm); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not issue token.'); }
    finally { setBusy(false); }
  }
  async function revoke(token: FabricAccessToken) {
    if (!window.confirm(`Revoke ${token.label}? Its sessions and connections will end.`)) return;
    setBusy(true); setNotice('');
    try { await accessApi<{ ok: true }>(`/api/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' }); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not revoke token.'); }
    finally { setBusy(false); }
  }
  function copySecret() { if (!issued) return; navigator.clipboard?.writeText(issued.token).then(() => setNotice('Token copied. Store it securely now.')).catch(() => setNotice('Copy failed; select the token manually.')); }

  if (!principal) return <section className="access-panel"><p className="eyebrow">ACCESS</p><p className="access-muted">Loading identity and access policy…</p>{notice && <p className="access-error" role="alert">{notice}</p>}</section>;
  const isAdmin = principal.role === 'admin';
  return <section className="access-panel" aria-labelledby="access-heading">
    <header className="access-heading"><div><p className="eyebrow">ACCESS &amp; MCP</p><h2 id="access-heading">Fabric access</h2></div><span className={`access-role ${principal.role}`}>{principal.role}</span></header>
    <div className="identity-grid"><div><span>Identity</span><b>{principal.label}</b></div><div><span>Access expires</span><b>{when(principal.expires_at)}</b></div>{principal.node_id && <div><span>Bound node</span><b>{principal.node_id}</b></div>}</div>
    <div className="mcp-guide"><div><h3>MCP endpoint <code>{window.location.origin}/mcp</code></h3>{principal.role === 'node' ? <p>Node access is for the connector only; it cannot use MCP tools.</p> : <p>Streamable HTTP with a preprovisioned access token — not OAuth. Send <code>Authorization: Bearer &lt;FABRIC_ACCESS_TOKEN&gt;</code>.</p>}<p className="tool-list">Tools: <code>fabric_resources</code>, <code>fabric_models</code>, <code>fabric_submit_task</code>, <code>fabric_get_task</code></p></div><a href="/openapi.json">MCP / API docs ↗</a></div>
    {notice && <p className="access-error" role="status">{notice}</p>}
    {isAdmin && <div className="admin-access"><div><p className="eyebrow">TOKEN ADMINISTRATION</p><h3>Issue an access token</h3></div><form className="token-form" onSubmit={create}><label>Label<input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="e.g. research-agent" required /></label><label>Role<select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as FabricRole })}><option value="agent">Agent</option><option value="node">Node connector</option><option value="admin">Admin</option></select></label>{form.role === 'node' && <label>Node ID<input value={form.node_id} onChange={(e) => setForm({ ...form, node_id: e.target.value })} required /></label>}<label>Expires in days<input type="number" min="1" max="365" value={form.expires_in_days} onChange={(e) => setForm({ ...form, expires_in_days: e.target.value })} required /></label><button disabled={busy}>{busy ? 'Working…' : 'Issue token'}</button></form>
      {issued && <div className="issued-token" role="status"><div><p className="eyebrow">COPY NOW — SHOWN ONCE</p><p>This secret will not be shown again. Store it in a secure secret manager.</p></div><div className="secret-row"><input aria-label="New access token" type={reveal ? 'text' : 'password'} readOnly value={issued.token} /><button type="button" className="access-secondary" onClick={() => setReveal(!reveal)}>{reveal ? 'Hide' : 'Reveal'}</button><button type="button" onClick={copySecret}>Copy</button><button type="button" className="access-secondary" onClick={() => { setIssued(null); setReveal(false); }}>Dismiss</button></div></div>}
      <div className="token-list"><h3>Issued tokens</h3>{tokens.length === 0 ? <p className="access-muted">No access tokens have been issued.</p> : <div className="token-table" role="list">{tokens.map((token) => <article key={token.id} role="listitem"><div><b>{token.label}</b><span>{token.role} · {token.token_prefix}…</span></div><div><span>Expires {when(token.expires_at)}</span><span>{token.revoked_at ? `Revoked ${when(token.revoked_at)}` : token.last_used_at ? `Used ${when(token.last_used_at)}` : 'Never used'}</span></div>{token.revoked_at ? <span className="revoked">Revoked</span> : <button className="revoke" disabled={busy} onClick={() => revoke(token)}>Revoke</button>}</article>)}</div>}</div>
    </div>}
  </section>;
}
