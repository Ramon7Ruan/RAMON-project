import katex from 'katex';
import type { FormulaBlock } from '@shared/types';
import { BlockLabel } from './text';

export interface FormulaRender {
  html: string;
  failed: boolean;
}

/**
 * 公式渲染。语法错误时**不抛异常、不整页崩**——
 * 返回 failed 让上层降级为纯文本展示（PRD §8 部分失败）。
 */
export function renderFormula(latex: string): FormulaRender {
  try {
    const html = katex.renderToString(latex, {
      throwOnError: true,
      displayMode: false,
      output: 'html',
    });
    return { html, failed: false };
  } catch {
    return { html: '', failed: true };
  }
}

export function Formula({ block }: { block: FormulaBlock }) {
  const r = renderFormula(block.latex);
  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="formula-box">
        {r.failed ? (
          <div className="fx" style={{ fontFamily: 'var(--font-serif)' }}>{block.latex}</div>
        ) : (
          <div className="fx" dangerouslySetInnerHTML={{ __html: r.html }} />
        )}
        {block.note && <div className="fn">{block.note}</div>}
      </div>
      {block.symbols.length > 0 && (
        <div className="symtab">
          {block.symbols.map((s, i) => (
            <div key={i}>
              <b>{s.s}</b>
              {s.m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
