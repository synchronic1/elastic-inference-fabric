// Operator-supplied demo labels, not hardware discovery or geolocation.
// Connection, token, routing and job identities always retain the node ID.
const DEMO_LABELS = new Map<string, { name: string; sublabel: string }>([
  ['peter-mac-cpu', { name: 'Mac', sublabel: 'Portable · Local' }],
  ['ubuntu-desktop-node', { name: 'Ubuntu node', sublabel: 'Remote · Sweden' }],
]);

export function nodePresentation(nodeId: string) {
  return DEMO_LABELS.get(nodeId) ?? { name: nodeId, sublabel: null };
}

export default function NodeIdentity({ nodeId }: { nodeId: string }) {
  const label = nodePresentation(nodeId);
  return (
    <span className="node-identity">
      <span className="node-display-name">{label.name}</span>
      {label.sublabel && <small className="node-sublabel">{label.sublabel}</small>}
      {label.name !== nodeId && <small className="node-canonical-id">{nodeId}</small>}
    </span>
  );
}
