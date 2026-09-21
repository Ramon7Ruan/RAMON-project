import { Component, type ReactNode } from 'react';
import type { Block, BlockType } from '@shared/types';
import { Prose, Pitfall, Case, BlockLabel, renderInline } from './text';
import { Formula, renderFormula } from './math';
import { Curve, Dataviz, elasticitySeries } from './charts';
import { Compare, Flow, Timeline, Scale } from './struct';
import { Calc, computeDuration } from './interactive';

/** 讲解方式的中文名 —— 用于 recipe 徽标，让"多样化"本身成为可见信息 */
export const BLOCK_NAMES: Record<BlockType, string> = {
  prose: '定义',
  formula: '公式',
  curve: '曲线',
  dataviz: '数据图',
  compare: '对比表',
  flow: '传导图',
  timeline: '时间线',
  pitfall: '误区',
  case: '微案例',
  scale: '数量级',
  calc: '计算器',
};

export function Degraded({ reason }: { reason: string }) {
  return <div className="blk"><div className="blk-degraded">此部分内容暂时无法显示（{reason}）</div></div>;
}

class BlockErrorBoundary extends Component<{ children: ReactNode }, { err: string | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(e: unknown) {
    return { err: (e as Error)?.message ?? '未知错误' };
  }

  render() {
    if (this.state.err) return <Degraded reason={this.state.err} />;
    return this.props.children;
  }
}

/** 单块渲染失败只影响这一块，整页照常（PRD §8 部分失败） */
export function BlockRenderer({ block }: { block: Block }) {
  // 内容来自网络，字段缺失是可能的；宁可降级这一块，也不能让整页崩掉
  if (!block || typeof block !== 'object' || typeof (block as { type?: unknown }).type !== 'string') {
    return <Degraded reason="内容块格式不完整" />;
  }
  const inner = renderBlock(block);
  return (
    <BlockErrorBoundary key={`${block.type}-${(block as { label?: string }).label ?? ''}`}>
      {inner}
    </BlockErrorBoundary>
  );
}

export function renderBlock(block: Block): ReactNode {
  // 内容来自网络，字段缺失是可能的；宁可降级这一块，也不能让整页崩掉
  if (!block || typeof block !== 'object' || typeof (block as { type?: unknown }).type !== 'string') {
    return <Degraded reason="内容块格式不完整" />;
  }
  switch (block.type) {
    case 'prose':
      return <Prose block={block} />;
    case 'formula':
      return <Formula block={block} />;
    case 'curve':
      if (!block.series?.length && block.interactive !== 'elasticity') {
        return <Degraded reason="曲线没有数据" />;
      }
      return <Curve block={block} />;
    case 'dataviz':
      if (!block.series?.length || !block.xTicks?.length) {
        return <Degraded reason="图表没有数据" />;
      }
      return <Dataviz block={block} />;
    case 'compare':
      return <Compare block={block} />;
    case 'flow':
      return <Flow block={block} />;
    case 'timeline':
      return <Timeline block={block} />;
    case 'pitfall':
      return <Pitfall block={block} />;
    case 'case':
      return <Case block={block} />;
    case 'scale':
      return <Scale block={block} />;
    case 'calc':
      if (block.calc !== 'duration') return <Degraded reason={`不支持的计算器：${String(block.calc)}`} />;
      return <Calc block={block} />;
    default:
      return <Degraded reason={`未知的讲解方式：${String((block as { type?: unknown }).type)}`} />;
  }
}

/** 概念页的完整解析流 */
export function BlockFlow({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => (
        <BlockRenderer key={i} block={b} />
      ))}
    </>
  );
}

export { Prose, Pitfall, Case, Formula, Curve, Dataviz, Compare, Flow, Timeline, Scale, Calc, BlockLabel, renderInline, renderFormula, elasticitySeries, computeDuration };
