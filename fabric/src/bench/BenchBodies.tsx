// Presentational bodies for the bench. Deliberately free of any @xyflow/react
// import so every one of them can be rendered with renderToStaticMarkup and
// asserted directly. The edge handles React Flow needs are injected by
// BenchDiagram as `handles`, so this module stays DOM-only.
import type { ReactNode } from 'react';
import NodeIdentity from '../NodeIdentity';
import {
  MODEL_CHIP_LIMIT,
  RUNTIME_CHIP_LIMIT,
  drainSegments,
  type BenchMicroBar,
  type BenchRateCell,
  type BenchRow,
} from './core';

function StatusWord({ value }: { value: string }) {
  // Same markup App.tsx's Status renders, so the three states keep one styling
  // contract. Inlined rather than exported across modules to keep the bench
  // free of a cycle back into App.
  return <span className={`status ${value}`}>{value}</span>;
}

function Drain({ drain }: { drain: BenchRow['drain'] }) {
  const segments = drainSegments(drain);
  return (
    <span
      className={`bench-drain ${drain.eligible ? 'eligible' : 'expired'}`}
      title={`heartbeat ${Math.round(drain.ageMs / 1000)}s old`}
    >
      {segments.map((filled, index) => (
        <i key={index} className={filled ? 'on' : 'off'} />
      ))}
    </span>
  );
}

function MicroBar({ bar }: { bar: BenchMicroBar }) {
  return (
    <div className="bench-micro" data-bar={bar.name} data-unified={bar.unifiedWithGpu || undefined}>
      <span className="bench-micro-name">{bar.name}</span>
      <span className="bench-micro-value" title={bar.detail ?? bar.value}>
        {bar.value}
      </span>
      <span className="bench-micro-track">
        {bar.ratio === null ? (
          <i className="bench-hatch" />
        ) : (
          <i className="bench-micro-fill" style={{ width: `${bar.ratio * 100}%` }} />
        )}
      </span>
      {bar.unifiedWithGpu && <span className="bench-bracket">unified with GPU pool</span>}
    </div>
  );
}

function RateCell({
  rate,
  ticks,
}: {
  rate: BenchRateCell;
  ticks: { value: number; x: number; label: string }[];
}) {
  const measured = rate.kind === 'measured';
  return (
    <div className="bench-plot">
      <div className="bench-plot-track">
        {ticks.map((tick) => (
          <span key={tick.value} className="bench-gridline" style={{ left: `${tick.x}px` }} />
        ))}
        {measured ? (
          <span className={`bench-plot-fill ${rate.stale ? 'stale' : ''}`} style={{ width: `${rate.lengthPx}px` }}>
            <i className="bench-plot-cap" />
          </span>
        ) : (
          <span className="bench-hatch bench-plot-empty" />
        )}
        {!measured && <span className="bench-plot-word">Not measured</span>}
      </div>
      <div className="bench-rate">
        <b>{rate.text}</b>
        <small>{rate.modelText}</small>
        {rate.sampleText && <small>{rate.sampleText}</small>}
        {rate.disclosure && <small className="bench-provenance">{rate.disclosure}</small>}
      </div>
    </div>
  );
}

function Chips({ row }: { row: BenchRow }) {
  return (
    <div className="bench-models">
      {row.modelsEmpty && <span className="bench-empty">No models reported</span>}
      {row.modelChips.map((chip) => (
        <span key={chip.id} className={`topology-model ${chip.state}`} title={`${chip.id}: ${chip.word}`}>
          {chip.id} <em>{chip.word}</em>
        </span>
      ))}
      {row.modelOverflow > 0 && (
        <span className="bench-empty">
          +{row.modelOverflow} more (first {MODEL_CHIP_LIMIT} shown)
        </span>
      )}
      {row.runtimesEmpty ? (
        <span className="bench-empty">Runtime not reported</span>
      ) : (
        row.runtimeChips.map((chip) => (
          <span key={chip.id} className={`bench-runtime ${chip.busy ? 'busy' : ''}`}>
            {chip.label}
            {chip.simulated && <em className="bench-simulated">simulated</em>}
          </span>
        ))
      )}
      {row.runtimeOverflow > 0 && (
        <span className="bench-empty">
          +{row.runtimeOverflow} more (first {RUNTIME_CHIP_LIMIT} shown)
        </span>
      )}
    </div>
  );
}

export function AxisBody({
  data,
}: {
  data: { ceiling: number; ticks: { value: number; x: number; label: string }[]; empty: boolean };
}) {
  return (
    <div className="bench-axis">
      <span className="bench-axis-caption">
        tok/s generated · last measured sample{data.empty ? ' · no measured rates yet' : ''}
      </span>
      <span className="bench-axis-rule">
        {data.ticks.map((tick) => (
          <span key={tick.value} className="bench-tick" style={{ left: `${tick.x}px` }}>
            <i />
            <small>{tick.label}</small>
          </span>
        ))}
      </span>
    </div>
  );
}

export function GroupBody({
  data,
  handles,
}: {
  data: { columns: { label: string; x: number }[]; honesty: string };
  handles?: ReactNode;
}) {
  return (
    <div className="bench-group">
      {handles}
      {data.columns.map((column) => (
        <span key={column.label} className="bench-group-column" style={{ left: `${column.x}px` }}>
          {column.label}
        </span>
      ))}
      <span className="bench-group-honesty">{data.honesty}</span>
    </div>
  );
}

export function LaneBody({
  data,
  handles,
}: {
  data: { row: BenchRow; ticks: { value: number; x: number; label: string }[] };
  handles?: ReactNode;
}) {
  const { row } = data;
  return (
    <article
      className={`bench-lane ${row.status} ${row.working ? 'working has-work' : ''}`}
      role="group"
      aria-label={`${row.nodeId}, ${row.status}, ${
        row.rate.kind === 'measured' ? row.rate.text : 'throughput not measured'
      }, ${row.inFlightText}`}
    >
      {handles}
      <div className="bench-intake">
        <h3><NodeIdentity nodeId={row.nodeId} /></h3>
        <StatusWord value={row.status} />
        <p>{row.inFlightText}</p>
        <Drain drain={row.drain} />
      </div>
      <div
        className="bench-lane-content nowheel nopan"
        tabIndex={0}
        role="region"
        aria-label={`${row.nodeId} readings and inventory`}
      >
        <div className="bench-measure">
          <div className="bench-compute">
            {row.compute.map((bar) => (
              <MicroBar key={bar.name} bar={bar} />
            ))}
          </div>
          <RateCell rate={row.rate} ticks={data.ticks} />
          <div className="bench-accel">
            {row.accelerators.length === 0 ? (
              <span className="bench-empty">No accelerator detected</span>
            ) : (
              row.accelerators.map((accelerator) => (
                <div key={`${accelerator.vendor}:${accelerator.name}`} className="bench-accel-item">
                  <b title={`${accelerator.vendor} ${accelerator.name}`}>{accelerator.name}</b>
                  {accelerator.state === 'unspecified' ? (
                    <>
                      <i className="bench-hatch bench-swatch" />
                      <small>{accelerator.caption}</small>
                    </>
                  ) : (
                    <small className={accelerator.state === 'unified' ? 'unified' : undefined}>
                      {accelerator.caption}
                    </small>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
        <Chips row={row} />
        <div className="bench-footer">
          <span>{row.heartbeatText}</span>
          <span>{row.uptimeText}</span>
          <span>{row.promptRateText}</span>
          <span>{row.cacheTransferText}</span>
          <span>{row.prefixText}</span>
          {row.prefixDisclosure && <span className="bench-provenance">{row.prefixDisclosure}</span>}
        </div>
      </div>
    </article>
  );
}

export function NoteBody({
  data,
}: {
  data: { jobs: { id: string; capability: string; status: string; reason: string }[] };
}) {
  return (
    <div className="bench-note-row">
      <h3>Jobs with no reported node</h3>
      <ul>
        {data.jobs.map((job) => (
          <li key={job.id}>
            <b>{job.id}</b>
            <span>{job.capability}</span>
            <StatusWord value={job.status} />
            <span className="bench-provenance">{job.reason}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DemoBody({ data }: { data: { caption: string } }) {
  return (
    <div className="bench-note bench-demo">
      <p className="eyebrow">DEMO · ARCHITECTURE ONLY</p>
      <h3>ILLUSTRATIVE BENCH</h3>
      <p>{data.caption}</p>
    </div>
  );
}

export function EmptyNote({ text }: { text: string }) {
  return (
    <div className="bench-note">
      <p>{text}</p>
      <p className="bench-provenance">
        Throughput, compute and accelerator readings appear once a node connects.
      </p>
    </div>
  );
}
