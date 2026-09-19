import type { FabricNode, FabricState, ModelSnapshot, NodeSnapshot } from './contracts';
import NodeIdentity from './NodeIdentity';

type Performance = { generation_tokens_per_second: number | null; prompt_tokens_per_second: number | null; samples: number; last_observed_at: number | null; model_id: string | null; runtime_id: string | null };
type SnapshotWithPerformance = NodeSnapshot & { performance?: Performance };

function memory(available: number, total: number) { const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`; return `${gb(available)} / ${gb(total)}`; }
function measuredAgo(observedAt: number | null) {
  if (observedAt === null) return 'time not reported';
  const seconds = Math.max(0, Math.floor((Date.now() - observedAt) / 1000));
  return seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
}
function performance(snapshot: NodeSnapshot) {
  const p = (snapshot as SnapshotWithPerformance).performance;
  if (!p || p.generation_tokens_per_second === null || p.generation_tokens_per_second === undefined) return { rate: 'Not measured', detail: null };
  return { rate: `${p.generation_tokens_per_second.toFixed(1)} tok/s`, detail: `${p.model_id ?? 'model not reported'} · ${p.runtime_id ?? 'runtime not reported'} · ${measuredAgo(p.last_observed_at)}` };
}
function ModelChip({ model }: { model: ModelSnapshot }) {
  const state = model.resident ? 'resident' : model.cached_on_disk ? 'cached' : 'unprovisioned';
  return <span className={`topology-model ${state}`} title={`${model.id}: ${state}`}>{model.id}</span>;
}
function Node({ node, active }: { node: FabricNode; active: boolean }) {
  const s = node.snapshot;
  const runtime = s.runtimes.find((item) => item.busy) ?? s.runtimes[0];
  const measured = performance(s);
  return <article className={`topology-node ${node.status} ${active ? 'working' : ''}`} data-active={active || undefined}>
    <header><div><span className="topology-node-status" /><h3><NodeIdentity nodeId={node.node_id} /></h3></div><b>{node.status}</b></header>
    <p className="topology-host">{s.hardware.hostname} · {s.hardware.os}</p>
    <dl><div><dt>CPU</dt><dd>{s.hardware.logical_cpus} threads</dd></div><div><dt>Memory free</dt><dd>{memory(s.load.memory_available_bytes, s.hardware.memory_total_bytes)}</dd></div><div><dt>GPU</dt><dd>{s.hardware.gpus.length ? s.hardware.gpus.map((gpu) => gpu.name).join(', ') : 'Not detected'}</dd></div><div><dt>Requests</dt><dd>{s.active_requests} active</dd></div><div><dt>Runtime</dt><dd>{runtime ? `${runtime.kind} · ${runtime.state}` : 'Not reported'}</dd></div><div><dt>Last measured</dt><dd>{measured.rate}{measured.detail && <small className="topology-provenance">{measured.detail}</small>}</dd></div></dl>
    <div className="topology-models" aria-label="Model availability">{s.models.length ? s.models.map((model) => <ModelChip key={model.id} model={model} />) : <span className="topology-empty">No models reported</span>}</div>
  </article>;
}

export default function FabricTopology({ fabric, activeNodeId, live = true }: { fabric: FabricState | null; activeNodeId?: string; live?: boolean }) {
  const preview = fabric === null;
  const runningNodeIds = new Set((fabric?.jobs ?? []).filter((job) => job.status === 'running').map((job) => job.node_id));
  if (fabric && activeNodeId) runningNodeIds.add(activeNodeId);
  const active = live && (fabric?.nodes.some((node) => node.status === 'online' && (node.snapshot.active_requests > 0 || runningNodeIds.has(node.node_id))) ?? false);
  return <section id="flow" className={`topology ${preview ? 'topology-preview' : ''}`} aria-labelledby="topology-heading" data-view={preview ? 'demo' : live ? 'live' : 'stale'}>
    <header className="topology-heading"><div><p className="eyebrow">{preview ? 'DEMO · ARCHITECTURE ONLY' : live ? 'LIVE TOPOLOGY' : 'LAST KNOWN TOPOLOGY'}</p><h2 id="topology-heading">Fabric flow diagram</h2></div><p>{preview ? 'Sign in to reveal live nodes, models and throughput.' : live ? 'Rates are last measured, not capacity guarantees.' : 'Connection interrupted. Showing the last received snapshot.'}</p></header>
    <div className={`topology-map ${active ? 'has-work' : ''}`} role="group" aria-label="Requests flow from an agent through the authenticated cloud router to local inference. Heartbeats and results return through the router.">
      <div className="topology-origin"><span className="topology-icon" aria-hidden="true">↗</span><div><b>Agent / harness</b><small>Task + access token</small></div></div>
      <div className="topology-link request" aria-hidden="true"><i /> <span>Request</span></div>
      <div className="topology-router"><span className="topology-icon" aria-hidden="true">⌘</span><div><b>Authenticated MCP router</b><small>Cloudflare · select a node</small></div></div>
      <div className="topology-link request-node" aria-hidden="true"><i /> <span>Request → node</span></div>
      <div className="topology-nodes">{preview ? <div className="topology-demo-node">
        <p className="eyebrow">ILLUSTRATIVE NODE</p>
        <h3>Dendrite · local inference</h3>
        <div className="topology-demo-pipeline"><span>CPU / GPU</span><b aria-hidden="true">→</b><span>Runtime</span><b aria-hidden="true">→</b><span>Local model</span></div>
        <p>Nodes connect outbound. Models execute on the selected machine.</p>
      </div> : fabric.nodes.length ? fabric.nodes.map((node) => <Node key={node.node_id} node={node} active={live && node.status === 'online' && (node.snapshot.active_requests > 0 || runningNodeIds.has(node.node_id))} />) : <p className="topology-empty">No node heartbeat has been received.</p>}</div>
      <div className="topology-return-lane"><span>← Heartbeats · resources &amp; availability</span><span>← Results · completion &amp; output</span></div>
    </div>
    {preview ? <footer className="topology-demo-caption"><span>Schematic only — no live hardware, model availability or token rates shown.</span><a href="#fabric-access">Connect to see live resources ↓</a></footer> : <footer className="topology-legend"><span><i className="request" /> Request</span><span><i className="result" /> Result</span><span><i className="heartbeat" /> Heartbeat</span><span><i className="resident" /> Resident</span><span><i className="cached" /> Cached</span><span><i className="unprovisioned" /> Unprovisioned</span></footer>}
  </section>;
}
