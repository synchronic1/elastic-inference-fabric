import { lazy, Suspense, useEffect, useState } from 'react';
import type { FabricState } from './contracts';

const LocalCopilot = lazy(() => import('./LocalCopilot'));

export default function FabricCopilot() {
  const [open, setOpen] = useState(false);
  const [inventory, setInventory] = useState<FabricState | null>(null);
  const [admin, setAdmin] = useState(false);
  const [diagnostic, setDiagnostic] = useState('');
  const [probing, setProbing] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const refresh = async () => {
      try {
        const [resources, identity] = await Promise.all([
          fetch('/v1/resources', { credentials: 'same-origin', cache: 'no-store' }),
          fetch('/api/me', { credentials: 'same-origin', cache: 'no-store' }),
        ]);
        if (!resources.ok) throw new Error('Could not read live node capabilities.');
        const state = await resources.json() as FabricState;
        const me = identity.ok ? await identity.json() as { principal?: { role?: string } } : null;
        if (alive) { setInventory(state); setAdmin(me?.principal?.role === 'admin'); }
      } catch (error) {
        if (alive) setDiagnostic(error instanceof Error ? error.message : 'Diagnostics unavailable.');
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 10_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [open]);
  const runProbe = async (nodeId: string) => {
    setProbing(nodeId); setDiagnostic('');
    try {
      const response = await fetch(`/api/nodes/${encodeURIComponent(nodeId)}/chat-probe`, {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) throw new Error(response.status === 409
        ? 'Node is disconnected. Reconnect Dendrite before probing.'
        : `Setup probe was rejected (HTTP ${response.status}).`);
      setDiagnostic(`Setup probe requested on ${nodeId}. Results appear here after the node responds.`);
    } catch (error) {
      setDiagnostic(error instanceof Error ? error.message : 'Setup probe failed.');
    } finally { setProbing(''); }
  };
  const resident = inventory?.nodes.filter((node) => node.connected && node.status === 'online')
    .flatMap((node) => node.snapshot.runtimes.filter((runtime) => runtime.loaded_model && !runtime.simulated).map((runtime) => ({
      nodeId: node.node_id, runtime,
    }))) ?? [];
  return <section className="fabric-copilot" aria-labelledby="copilot-title">
    <div className="section-title">
      <div><p className="eyebrow">CopilotKit × Dendrite</p><h2 id="copilot-title">Ask the fabric</h2></div>
      <button type="button" aria-expanded={open} aria-controls="copilot-console" onClick={() => setOpen(!open)}>
        {open ? 'Close console' : 'Open local assistant'}
      </button>
    </div>
    <p>Chat with a resident model on a Dendrite node. Recent turns give follow-up questions context.</p>
    {open && <div id="copilot-console">
      <p>The model has no live web search. Answers appear when local generation finishes;
        closing this console does not cancel work already sent to a node.</p>
      <div className="fabric-chat-diagnostics">
        <strong>Local model setup</strong>
        {resident.length ? <ul>{resident.map(({ nodeId, runtime }) => <li key={`${nodeId}/${runtime.id}`}>
          <span>{nodeId} · {runtime.loaded_model ?? runtime.id}: {!runtime.supports_chat ? 'chat endpoint not verified'
            : runtime.chat_profile?.status === 'verified'
            ? `verified ${runtime.chat_profile.format.replaceAll('_', ' ')}`
            : runtime.chat_profile?.status === 'unverified' ? 'chat format needs attention' : 'setup probe pending'}</span>
          {admin && runtime.kind === 'helios' && <button type="button" disabled={probing === nodeId || runtime.busy}
            onClick={() => { void runProbe(nodeId); }}>
            {probing === nodeId ? 'Requesting…' : 'Run setup probe'}
          </button>}
        </li>)}</ul> : <p>No online resident runtime is currently advertised.</p>}
        {admin && <p>Probing uses a tiny local request through Helios’s queue. It does not change model settings.
          For an unverified Helios attachment, check the exact hot model selector and
          its `/v1/completions` and `/v1/chat/completions` routes. For an existing
          llama-server attachment, check `/props` for a chat template; no IK_Llama
          build is needed. Managed nodes need a compatible `llama-server` binary,
          built for their local CPU or GPU.</p>}
        {diagnostic && <p role="status">{diagnostic}</p>}
      </div>
      <Suspense fallback={<p role="status">Loading local assistant…</p>}><LocalCopilot /></Suspense>
    </div>}
  </section>;
}
