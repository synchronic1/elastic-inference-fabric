import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { FabricJob } from './contracts';
import type { AmbiguousHandoff, AmbiguousHandoffInput, AmbiguousStatus } from './ambiguous-contracts';

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...(body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

export default function AmbiguousPanel({ jobs, signedIn }: { jobs: FabricJob[]; signedIn: boolean }) {
  const [status, setStatus] = useState<AmbiguousStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [mode, setMode] = useState<'task' | 'result'>('task');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [jobId, setJobId] = useState('');
  // A lost browser response locks this form. Never mint a new ID and blindly retry a write.
  const [unresolved, setUnresolved] = useState<string | null>(null);
  const active = useRef(true);
  const epoch = useRef(0);
  const submitting = useRef(false);
  const completed = jobs.filter((job) => job.status === 'succeeded');
  const selected = completed.find((job) => job.id === jobId);
  const preview = selected?.result ? (typeof selected.result.content === 'string' ? selected.result.content : JSON.stringify(selected.result, null, 2)) : '';

  const refresh = useCallback(async () => {
    if (!signedIn) return;
    const current = epoch.current;
    setLoading(true);
    try {
      const next = await api<AmbiguousStatus>('/api/ambiguous/status');
      if (active.current && current === epoch.current) { setStatus(next); setError(''); }
    } catch (cause) {
      if (active.current && current === epoch.current) { setStatus(null); setError(cause instanceof Error ? cause.message : 'Connection check failed'); }
    } finally { if (active.current && current === epoch.current) setLoading(false); }
  }, [signedIn]);

  useEffect(() => {
    active.current = true;
    epoch.current += 1;
    setStatus(null);
    setError('');
    void refresh();
    return () => { active.current = false; epoch.current += 1; };
  }, [refresh]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || unresolved || !status?.can_write || !status.connected) return;
    submitting.current = true;
    setBusy(true); setError(''); setNotice('');
    const operationId = crypto.randomUUID();
    const input: AmbiguousHandoffInput = mode === 'task'
      ? { operation_id: operationId, kind: 'task', title, description }
      : { operation_id: operationId, kind: 'result', title, job_id: jobId };
    const current = epoch.current;
    try {
      const { handoff, replayed } = await api<{ handoff: AmbiguousHandoff; replayed: boolean }>('/api/ambiguous/handoffs', input);
      if (!active.current || current !== epoch.current) return;
      if (handoff.state === 'succeeded') {
        setNotice(replayed ? 'This handoff was already recorded. No duplicate was created.' : mode === 'task' ? 'Task created and assigned to Synchronic1.' : 'Completed inference result published to Ambiguous.');
        setTitle(''); setDescription(''); setJobId('');
      } else {
        setUnresolved(handoff.id);
        setNotice('The submission outcome is uncertain. Check Ambiguous before creating any replacement. This operation will not be retried.');
      }
      await refresh();
    } catch (cause) {
      if (!active.current || current !== epoch.current) return;
      setUnresolved(operationId);
      setError(`${cause instanceof Error ? cause.message : 'Response unavailable'}. Check recent handoffs and Ambiguous before submitting again. Operation: ${operationId}`);
      // Safe read only; it may recover a successfully recorded operation after a lost POST response.
      await refresh();
    } finally { submitting.current = false; if (active.current && current === epoch.current) setBusy(false); }
  }

  return <section id="ambiguous" className="ambiguous-panel" aria-labelledby="ambiguous-heading">
    <header className="ambiguous-header">
      <div>
        <p className="eyebrow">AMBIGUOUS · AI COWORKER</p>
        <h2 id="ambiguous-heading">Turn inference into team progress.</h2>
        <p>Hand off a task to Synchronic1, or bring a completed Dendrite result into your workspace.</p>
      </div>
      <a href="https://app.ambiguous.ai/" target="_blank" rel="noreferrer">Open Ambiguous ↗</a>
    </header>
    <div className="ambiguous-flow" aria-label="Integration flow">
      <span><strong>EIF + Dendrite</strong><small>Local inference</small></span>
      <span className="ambiguous-arrow" aria-hidden="true">→</span>
      <span><strong>You choose what to share</strong><small>Administrator handoff</small></span>
      <span className="ambiguous-arrow" aria-hidden="true">→</span>
      <span><strong>Synchronic1</strong><small>Ambiguous · Fabric handoffs</small></span>
    </div>
    <div className="ambiguous-connection">
      <span className={`ambiguous-dot ${status?.connected ? 'connected' : ''}`} aria-hidden="true" />
      <span>{!signedIn ? 'Sign in to check the connection' : loading ? 'Checking Ambiguous…' : status?.connected ? `Connected · ${status.agent} / ${status.workspace}` : status?.configured ? 'Connection needs attention' : status ? 'Server credential not configured' : 'Connection not verified'}</span>
      {signedIn && <button type="button" onClick={() => void refresh()} disabled={loading || busy}>Refresh status</button>}
    </div>
    {(error || status?.error) && <p className="ambiguous-error" role="alert">{error || status?.error}</p>}
    {notice && <p role="status" className="ambiguous-notice">{notice}</p>}
    {!status?.can_write && <p className="ambiguous-note">Task creation, result sharing and private handoff history require a Fabric administrator. Shared demo access cannot modify the Ambiguous workspace.</p>}
    {status?.can_write && <div className="ambiguous-workspace">
      <form onSubmit={submit}>
        <fieldset disabled={busy || Boolean(unresolved) || !status.connected}>
          <legend>Send to the coworker workspace</legend>
          <label htmlFor="ambiguous-action">Action
            <select id="ambiguous-action" value={mode} onChange={(e) => setMode(e.target.value as 'task' | 'result')}>
              <option value="task">Create a task for Synchronic1</option>
              <option value="result">Publish a completed inference result</option>
            </select>
          </label>
          <label htmlFor="ambiguous-title">Task title
            <input id="ambiguous-title" value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} placeholder={mode === 'task' ? 'e.g. Review the EIF demo narrative' : 'e.g. Local inference — demo result'} />
          </label>
          {mode === 'task' ? <label htmlFor="ambiguous-description">What needs to be done?
            <textarea id="ambiguous-description" value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={8000} rows={4} placeholder="Describe the task and the outcome you need." />
          </label> : <>
            <label htmlFor="ambiguous-job">Completed Fabric job
              <select id="ambiguous-job" value={jobId} onChange={(e) => setJobId(e.target.value)} required>
                <option value="">{completed.length ? 'Choose a result to share' : 'No completed jobs in the current inventory'}</option>
                {completed.map((job) => <option key={job.id} value={job.id}>{job.model_id} · {job.node_id} · {job.id.slice(0, 8)}</option>)}
              </select>
            </label>
            {selected && <details open><summary>Preview the result that will leave the fabric</summary><pre className="ambiguous-preview">{preview}</pre></details>}
          </>}
          <p className="ambiguous-note">{mode === 'task' ? 'Sends this title and task text' : 'Sends this title, selected result, job ID, node and model'} to Ambiguous’s cloud workspace. Nothing else is exported. This does not automatically start inference or guarantee a coworker reply.</p>
          <button type="submit" disabled={mode === 'result' && (!selected || preview.length > 32000)}>{busy ? 'Sending once…' : mode === 'task' ? 'Create Ambiguous task' : 'Publish selected result'}</button>
        </fieldset>
        {unresolved && <p className="ambiguous-error">Submission locked for safety. Operation <code>{unresolved}</code>. Refresh status and check Ambiguous; do not create a replacement until you know whether this task exists.</p>}
      </form>
      <div className="ambiguous-history">
        <h3>Recent handoffs</h3>
        <p className="ambiguous-note">Statuses are checked on refresh. Only the ten latest EIF handoffs are shown.</p>
        {!status.handoffs?.length && <p>No handoffs yet. Your first task or shared result will appear here.</p>}
        <ul>{status.handoffs?.map((handoff) => <li key={handoff.id}>
          <div><strong>{handoff.title}</strong><span className={`ambiguous-state ${handoff.state}`}>{handoff.state === 'succeeded' ? handoff.task_status ?? 'created' : handoff.state}</span></div>
          <p>{handoff.kind === 'result' ? 'Inference result' : 'Coworker task'} · {new Date(handoff.created_at).toLocaleString()}</p>
          {handoff.url ? <a href={handoff.url} target="_blank" rel="noreferrer">View in Ambiguous ↗</a> : <p>Check Ambiguous for operation <code>{handoff.id}</code>. No automatic retry.</p>}
          {handoff.checked_at && <small>Last checked {new Date(handoff.checked_at).toLocaleTimeString()}</small>}
        </li>)}</ul>
      </div>
    </div>}
  </section>;
}
