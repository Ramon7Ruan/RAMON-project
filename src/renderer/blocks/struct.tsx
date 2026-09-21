import { Fragment } from 'react';
import type { CompareBlock, FlowBlock, ScaleBlock, TimelineBlock } from '@shared/types';
import { BlockLabel } from './text';

export function Compare({ block }: { block: CompareBlock }) {
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <table className="cmp">
        <thead>
          <tr>{block.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {block.rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Flow({ block }: { block: FlowBlock }) {
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="flow-row">
        {block.steps.map((s, i) => (
          <Fragment key={i}>
            <div className="flow-step">
              <b>{s.label}</b>
              {s.note && <span>{s.note}</span>}
            </div>
            {i < block.steps.length - 1 && <div className="flow-arrow">→</div>}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function Timeline({ block }: { block: TimelineBlock }) {
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="tl">
        {block.events.map((e, i) => (
          <div className={`tl-item${e.hot ? ' hot' : ''}`} key={i}>
            <div className="tl-dot" />
            <div className="tl-body">
              <div className="tl-date">{e.date}</div>
              <b>{e.title}</b>
              <span>{e.note}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Scale({ block }: { block: ScaleBlock }) {
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="scale-row">
        {block.ticks.map((t, i) => (
          <div className="scale-tick" key={i}>
            <b>{t.v}</b>
            <span>
              {t.t.split('\n').map((line, j) => (
                <span key={j}>
                  {line}
                  {j < t.t.split('\n').length - 1 && <br />}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
