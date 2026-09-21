import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Block, BlockType, Concept, Domain, TrackKey } from '../src/shared/types';

export function tempDir(prefix = 'recall-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function cleanup(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** 每个 Block 类型给一份合法载荷 */
export function blockOf(type: BlockType, i = 0): Block {
  switch (type) {
    case 'prose':
      return { type: 'prose', label: '定义', body: `第 ${i} 段的说明文字。` };
    case 'formula':
      return { type: 'formula', label: '公式', latex: 'a = b + c', symbols: [{ s: 'a', m: '结果' }, { s: 'b', m: '输入' }] };
    case 'curve':
      return {
        type: 'curve', label: '曲线', xLabel: 'X', yLabel: 'Y',
        xDomain: [0, 10], yDomain: [0, 10],
        series: [{ name: 'S', points: [[1, 2], [5, 6], [9, 9]] }],
      };
    case 'dataviz':
      return {
        type: 'dataviz', label: '数据图', chart: 'bar', xLabel: '区间', yLabel: '数量',
        xTicks: ['A', 'B', 'C'], series: [{ name: '样本', points: [3, 5, 2] }],
        source: '测试数据 截至 2026-09-20',
      };
    case 'compare':
      return {
        type: 'compare', label: '对比表',
        columns: ['', '甲', '乙'],
        rows: [['特征一', '是', '否'], ['特征二', '低', '高']],
      };
    case 'flow':
      return { type: 'flow', label: '传导链路', steps: [{ label: '第一步', note: '起点' }, { label: '第二步', note: '终点' }] };
    case 'timeline':
      return {
        type: 'timeline', label: '时间线',
        events: [
          { date: '2026-08', title: '事件一', note: '说明一' },
          { date: '2026-09', title: '事件二', note: '说明二', hot: true },
        ],
      };
    case 'pitfall':
      return { type: 'pitfall', label: '误区', wrong: '常见误解', right: '实际情况', why: '原因说明' };
    case 'case':
      return { type: 'case', label: '微案例', title: '案例标题', body: '案例正文', nums: [{ label: '指标', v: '20bp' }] };
    case 'scale':
      return { type: 'scale', label: '数量级', ticks: [{ v: '低', t: '说明一' }, { v: '中', t: '说明二' }, { v: '高', t: '说明三' }] };
    case 'calc':
      return {
        type: 'calc', label: '计算器', calc: 'duration',
        inputs: [
          { key: 'c', label: '票息率', min: 0, max: 12, step: 0.1, v: 3, unit: '%' },
          { key: 'n', label: '期限', min: 1, max: 30, step: 1, v: 10, unit: '年' },
          { key: 'y', label: '收益率', min: 0.5, max: 12, step: 0.1, v: 4, unit: '%' },
        ],
      };
  }
}

/**
 * 各分区的合法 recipe 池。
 * 必须满足 PRD §5.3 检查 8 的差异化约束，且池内组合互不相同
 * —— 否则会触发「recipe 组合唯一」门禁（这是故意的：fixture 也得遵守规则）。
 */
const POOL: Record<Domain, BlockType[][]> = {
  econ: [
    ['prose', 'flow', 'curve', 'pitfall'],
    ['prose', 'curve', 'case', 'compare'],
    ['prose', 'flow', 'scale', 'calc'],
    ['prose', 'curve', 'compare', 'pitfall'],
    ['prose', 'flow', 'timeline', 'case'],
    ['prose', 'curve', 'scale', 'pitfall'],
  ],
  finance: [
    ['prose', 'formula', 'compare', 'case'],
    ['prose', 'dataviz', 'pitfall', 'scale'],
    ['prose', 'formula', 'calc', 'scale'],
    ['prose', 'dataviz', 'compare', 'flow'],
    ['prose', 'calc', 'case', 'pitfall'],
    ['prose', 'formula', 'dataviz', 'compare'],
  ],
  hotspot: [
    ['prose', 'timeline', 'case', 'pitfall'],
    ['prose', 'timeline', 'dataviz', 'compare'],
    ['prose', 'timeline', 'flow', 'case'],
    ['prose', 'timeline', 'scale', 'pitfall'],
    ['prose', 'timeline', 'compare', 'case'],
    ['prose', 'timeline', 'dataviz', 'pitfall'],
  ],
};

const TRACK_OF: Record<Domain, TrackKey[]> = {
  econ: ['macro', 'micro', 'econometrics'],
  finance: ['equity', 'bond', 'fund', 'quant'],
  hotspot: ['event', 'data'],
};

let seq = 0;

export interface MakeOpts extends Partial<Concept> {
  /** 用于在 recipe 池里选一组，保证同批 fixture 的组合互不相同 */
  variant?: number;
}

export function makeConcept(over: MakeOpts = {}): Concept {
  seq += 1;
  const domain: Domain = over.domain ?? 'econ';
  const tracks = TRACK_OF[domain];
  const track: TrackKey = over.track ?? tracks[seq % tracks.length];
  const variant = over.variant ?? seq;
  const combo = POOL[domain][variant % POOL[domain].length];
  const blocks: Block[] = over.blocks ?? combo.map((t, i) => blockOf(t, i));

  return {
    id: over.id ?? `${domain}.${track}.test-${seq}`,
    domain,
    track,
    title: over.title ?? `测试概念 ${seq}`,
    one_liner: over.one_liner ?? `这是第 ${seq} 个概念的一句话说明？`,
    key_points: over.key_points ?? [`第 ${seq} 条结论甲`, `第 ${seq} 条结论乙`],
    difficulty: over.difficulty ?? ((seq % 3) + 1) as 1 | 2 | 3,
    tags: over.tags ?? ['测试'],
    recipe: over.recipe ?? [...new Set(blocks.map((b) => b.type))],
    blocks,
    links: over.links ?? [],
    source: over.source ?? (domain === 'hotspot' ? '测试来源 截至 2026-09-20' : undefined),
    updated_at: over.updated_at ?? '2026-09-21',
    order: over.order ?? seq,
  };
}

/** 一小组互相引用的概念，links 都指向组内成员，不会有死链 */
export function makeGroup(n: number, domains: Domain[] = ['econ', 'finance', 'hotspot']): Concept[] {
  const list: Concept[] = [];
  for (let i = 0; i < n; i++) {
    const domain = domains[i % domains.length];
    list.push(makeConcept({ domain, variant: i }));
  }
  return list.map((c, i) => ({
    ...c,
    links: [{ to: list[(i + 1) % list.length].id, reason: '测试关联' }],
  }));
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function ensureDir(p: string): string {
  mkdirSync(p, { recursive: true });
  return p;
}
