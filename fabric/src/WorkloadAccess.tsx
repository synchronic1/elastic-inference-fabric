import type { ReactNode } from 'react';

export default function WorkloadAccess({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  if (!readOnly) return children;
  return <section className="notice" aria-label="Read-only demo access">
    <div><h3>Live demo · read-only</h3><p>Explore live nodes, models, and performance. This viewer token cannot submit workloads, read private job results, use MCP, or manage access.</p></div>
  </section>;
}
