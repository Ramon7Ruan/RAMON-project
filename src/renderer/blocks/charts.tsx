import { useState, type ReactElement } from 'react';
import type { CurveBlock, DatavizBlock } from '@shared/types';
import { BlockLabel } from './text';

const SERIES_TOKEN = [
  'var(--chart-series-1)',
  'var(--chart-series-2)',
  'var(--chart-series-3)',
  'var(--chart-series-4)',
];

const W = 640;
const H = 250;
const L = 52;
const R = 16;
const T = 16;
const B = 40;

interface PlotSeries { name: string; points: [number, number][]; dash?: number; color?: string }

function Plot(props: {
  series: PlotSeries[];
  xDomain: [number, number];
  yDomain: [number, number];
  xLabel: string;
  yLabel: string;
  dots?: boolean;
  legend?: boolean;
}) {
  const { series, xDomain, yDomain, xLabel, yLabel, dots, legend } = props;
  const px = (v: number) => L + ((v - xDomain[0]) / (xDomain[1] - xDomain[0])) * (W - L - R);
  const py = (v: number) => H - B - ((v - yDomain[0]) / (yDomain[1] - yDomain[0])) * (H - T - B);

  const grid: ReactElement[] = [];
  for (let i = 0; i <= 4; i++) {
    const yv = yDomain[0] + ((yDomain[1] - yDomain[0]) * i) / 4;
    const y = py(yv);
    grid.push(
      <line key={`gy${i}`} x1={L} y1={y} x2={W - R} y2={y} stroke="var(--chart-grid)" strokeWidth={0.5} />,
      <text key={`ty${i}`} x={L - 9} y={y + 4} textAnchor="end" fontSize={10.5} fill="var(--text-tertiary)">
        {yv.toFixed(yv < 10 ? 1 : 0)}
      </text>,
    );
  }
  for (let i = 0; i <= 4; i++) {
    const xv = xDomain[0] + ((xDomain[1] - xDomain[0]) * i) / 4;
    grid.push(
      <text key={`tx${i}`} x={px(xv)} y={H - B + 17} textAnchor="middle" fontSize={10.5} fill="var(--text-tertiary)">
        {xv.toFixed(0)}
      </text>,
    );
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img">
      {grid}
      <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="var(--chart-axis)" strokeWidth={0.8} />
      <line x1={L} y1={T} x2={L} y2={H - B} stroke="var(--chart-axis)" strokeWidth={0.8} />
      {series.map((s, si) => {
        const color = s.color ?? SERIES_TOKEN[si % SERIES_TOKEN.length];
        const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${px(p[0]).toFixed(1)} ${py(p[1]).toFixed(1)}`).join(' ');
        return (
          <g key={si}>
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={s.dash ? `${s.dash} 4` : undefined}
            />
            {dots && s.points.map((p, i) => (
              <circle key={i} cx={px(p[0])} cy={py(p[1])} r={2.6} fill={color} />
            ))}
          </g>
        );
      })}
      {legend !== false && series.map((s, si) => {
        const lx = L + si * 160;
        const color = s.color ?? SERIES_TOKEN[si % SERIES_TOKEN.length];
        return (
          <g key={`lg${si}`}>
            <line x1={lx} y1={T} x2={lx + 16} y2={T} stroke={color} strokeWidth={2}
              strokeDasharray={s.dash ? `${s.dash} 4` : undefined} />
            <text x={lx + 21} y={T + 4} fontSize={10.5} fill="var(--text-tertiary)">{s.name}</text>
          </g>
        );
      })}
      <text x={W - R} y={H - 4} textAnchor="end" fontSize={10.5} fill="var(--text-tertiary)">{xLabel}</text>
      <text x={8} y={T - 5} fontSize={10.5} fill="var(--text-tertiary)">{yLabel}</text>
    </svg>
  );
}

export function elasticitySeries(e: number): PlotSeries[] {
  const A = 10 - e * 0.8;
  const pts: [number, number][] = [];
  for (let q = 0.4; q <= 9.6; q += 0.4) {
    pts.push([Number(q.toFixed(1)), Math.max(0.2, Math.min(9.8, 9.6 - (q * A) / 6))]);
  }
  return [{ name: '需求曲线', points: pts }];
}

export function Curve({ block }: { block: CurveBlock }) {
  const interactive = block.interactive === 'elasticity';
  const [e, setE] = useState(4);
  const series = interactive ? elasticitySeries(e) : block.series;
  const label = e >= 7 ? '富有弹性' : e <= 3 ? '缺乏弹性' : '接近单位弹性';

  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="chart-wrap">
        <Plot
          series={series}
          xDomain={block.xDomain}
          yDomain={block.yDomain}
          xLabel={block.xLabel}
          yLabel={block.yLabel}
          dots={interactive && block.series.length === 0}
          legend={!interactive || block.series.length > 1}
        />
      </div>
      {block.note && !interactive && <div className="chart-note">{block.note}</div>}
      {interactive && (
        <div className="ctrl">
          <label htmlFor={`el-${block.label ?? ''}`}>需求弹性</label>
          <input
            id={`el-${block.label ?? ''}`}
            type="range" min={0} max={10} step={1} value={e}
            aria-label="需求弹性"
            onChange={(ev) => setE(Number(ev.target.value))}
          />
          <span className="cv">{label}</span>
        </div>
      )}
    </div>
  );
}

export function Dataviz({ block }: { block: DatavizBlock }) {
  const isBar = block.chart === 'bar';
  const n = block.xTicks.length;
  const all = block.series.flatMap((s) => s.points);
  const max = Math.max(...all, 1) * 1.18;
  const gw = (W - L - R) / Math.max(1, n);
  const bw = Math.min(30, gw / (block.series.length + 1.2));
  const py = (v: number) => H - B - (v / max) * (H - T - B);
  const px = (v: number) => L + ((v - 4) / 16) * (W - L - R);

  const grid: ReactElement[] = [];
  for (let i = 0; i <= 3; i++) {
    const y = py((max * i) / 3);
    grid.push(
      <line key={i} x1={L} y1={y} x2={W - R} y2={y} stroke="var(--chart-grid)" strokeWidth={0.5} />,
      <text key={`t${i}`} x={L - 8} y={y + 4} textAnchor="end" fontSize={10.5} fill="var(--text-tertiary)">
        {(max * i / 3).toFixed(max < 2 ? 2 : 0)}
      </text>,
    );
  }

  return (
    <div className="blk">
      <BlockLabel text={block.label} />
      <div className="chart-wrap">
        <svg viewBox={`0 0 ${W} 230`} preserveAspectRatio="xMidYMid meet" role="img">
          {grid}
          {isBar
            ? block.series.map((s, si) =>
                s.points.map((v, i) => {
                  const x = L + gw * i + (gw - bw * block.series.length) / 2 + bw * si;
                  const y = py(v);
                  return (
                    <rect key={`${si}-${i}`} x={x} y={y} width={bw} height={H - B - y} rx={2.5}
                      fill={SERIES_TOKEN[si % SERIES_TOKEN.length]} />
                  );
                }),
              )
            : block.series.map((s, si) => {
                const d = s.points
                  .map((v, i) => `${i ? 'L' : 'M'}${(L + gw * i + gw / 2).toFixed(1)} ${py(v).toFixed(1)}`)
                  .join(' ');
                return (
                  <path key={si} d={d} fill="none" stroke={SERIES_TOKEN[si % SERIES_TOKEN.length]}
                    strokeWidth={2} strokeLinecap="round" />
                );
              })}
          {block.xTicks.map((t, i) => (
            <text key={i} x={L + gw * i + gw / 2} y={H - B + 16} textAnchor="middle"
              fontSize={10.5} fill="var(--text-tertiary)">{t}</text>
          ))}
          <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="var(--chart-axis)" strokeWidth={0.8} />
          {block.series.length > 1 && block.series.map((s, si) => (
            <g key={`lg${si}`}>
              <rect x={L + si * 175} y={T - 12} width={9} height={9} rx={2}
                fill={SERIES_TOKEN[si % SERIES_TOKEN.length]} />
              <text x={L + si * 175 + 14} y={T - 4} fontSize={10.5} fill="var(--text-tertiary)">{s.name}</text>
            </g>
          ))}
          <text x={W - R} y={H - 4} textAnchor="end" fontSize={10.5} fill="var(--text-tertiary)">
            {block.xLabel}
          </text>
        </svg>
      </div>
      <div className="chart-src">来源：{block.source}</div>
    </div>
  );
}

export { Plot };
export type { PlotSeries };
