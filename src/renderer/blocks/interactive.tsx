import { useState } from 'react';
import type { CalcBlock } from '@shared/types';
import { BlockLabel } from './text';

export interface DurationInput { c: number; n: number; y: number }
export interface DurationOutput {
  price: number;
  macaulay: number;
  modified: number;
  priceChangeOnPlus1pct: number;
}

/**
 * 久期计算器 —— 纯函数，便于单元测试。
 * 输入：票息率 c(%)、剩余期限 n(年)、到期收益率 y(%)，面值 100。
 */
export function computeDuration(input: DurationInput): DurationOutput {
  const c = Number.isFinite(input.c) && input.c >= 0 ? input.c : 0;
  const n = Math.max(1, Math.round(Number.isFinite(input.n) ? input.n : 1));
  const y = Number.isFinite(input.y) && input.y > -99 ? input.y : 0;
  const r = y / 100;
  const coupon = (100 * c) / 100;

  let price = 0;
  let weighted = 0;
  for (let t = 1; t <= n; t++) {
    const cf = coupon + (t === n ? 100 : 0);
    const pv = cf / Math.pow(1 + r, t);
    price += pv;
    weighted += t * pv;
  }
  const macaulay = price > 0 ? weighted / price : 0;
  const modified = macaulay / (1 + r);
  return {
    price: round2(price),
    macaulay: round2(macaulay),
    modified: round2(modified),
    priceChangeOnPlus1pct: round2(-modified),
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function Calc({ block }: { block: CalcBlock }) {
  const init: Record<string, number> = {};
  for (const i of block.inputs) init[i.key] = i.v;
  const [vals, setVals] = useState<Record<string, number>>(init);

  const out = block.calc === 'duration'
    ? computeDuration({ c: vals.c ?? 0, n: vals.n ?? 10, y: vals.y ?? 4 })
    : null;

  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="calc-form">
        <div className="calc-grid">
          {block.inputs.map((i) => (
            <div className="cf" key={i.key}>
              <label htmlFor={`calc-${block.calc}-${i.key}`}>
                {i.label}
                <b>{vals[i.key]}{i.unit}</b>
              </label>
              <input
                id={`calc-${block.calc}-${i.key}`}
                type="range" min={i.min} max={i.max} step={i.step} value={vals[i.key]}
                aria-label={i.label}
                onChange={(e) => setVals((p) => ({ ...p, [i.key]: Number(e.target.value) }))}
              />
            </div>
          ))}
        </div>
        {out && (
          <div className="calc-out">
            <div>债券价格<b>{out.price.toFixed(2)}</b></div>
            <div>麦考利久期<b>{out.macaulay.toFixed(2)} 年</b></div>
            <div>修正久期<b>{out.modified.toFixed(2)} 年</b></div>
            <div className="calc-hint">
              利率上升 1% → 价格约变动 <b>{out.priceChangeOnPlus1pct.toFixed(2)}%</b>（实际因凸性会略小）
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
