import type { ReactNode } from 'react';
import type { CaseBlock, PitfallBlock, ProseBlock } from '@shared/types';

export function BlockLabel({ text }: { text?: string }) {
  if (!text) return null;
  return <div className="blk-label">{text}</div>;
}

/** prose 支持的极简内联语法：**重点** */
export function renderInline(body: string): ReactNode[] {
  const out: ReactNode[] = [];
  const parts = body.split(/(\*\*[^*]+\*\*)/g);
  parts.forEach((p, i) => {
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
      out.push(<strong key={i}>{p.slice(2, -2)}</strong>);
    } else if (p) {
      out.push(p);
    }
  });
  return out;
}

export function Prose({ block }: { block: ProseBlock }) {
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <p className="prose">{renderInline(block.body)}</p>
    </div>
  );
}

export function Pitfall({ block }: { block: PitfallBlock }) {
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="pitfall">
        <div className="pf pf-wrong">
          <div className="pf-h">常见误区</div>
          {block.wrong}
        </div>
        <div className="pf pf-right">
          <div className="pf-h">实际上是</div>
          {block.right}
        </div>
      </div>
      <div className="pf-why">{block.why}</div>
    </div>
  );
}

export function Case({ block }: { block: CaseBlock }) {
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="case-card">
        <div className="ct">{block.title}</div>
        {block.nums && block.nums.length > 0 && (
          <div className="case-nums">
            {block.nums.map((n, i) => (
              <div key={i}>
                {n.label}
                <b>{n.v}</b>
              </div>
            ))}
          </div>
        )}
        <p>{block.body}</p>
      </div>
    </div>
  );
}
