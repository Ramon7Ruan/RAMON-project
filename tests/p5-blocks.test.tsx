import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Block, BlockType } from '../src/shared/types';
import { BLOCK_TYPES } from '../src/shared/types';
import { BlockRenderer, BLOCK_NAMES } from '../src/renderer/blocks';
import { computeDuration } from '../src/renderer/blocks/interactive';
import { renderFormula } from '../src/renderer/blocks/math';
import { elasticitySeries } from '../src/renderer/blocks/charts';
import { blockOf } from './fixtures';

const render = (b: Block) => renderToStaticMarkup(<BlockRenderer block={b} />);

describe('P5 十一种讲解方式的渲染', () => {
  it('11 种类型都有渲染器与中文名', () => {
    expect(BLOCK_TYPES.length).toBe(11);
    for (const t of BLOCK_TYPES) {
      expect(BLOCK_NAMES[t], `缺少 ${t} 的中文名`).toBeTruthy();
      const html = render(blockOf(t));
      expect(html.length, `${t} 渲染为空`).toBeGreaterThan(20);
      expect(html, `${t} 没有渲染出 block 根节点`).toContain('class="blk"');
    }
  });

  it('输出是稳定的：同一输入渲染两次结果完全一致', () => {
    for (const t of BLOCK_TYPES) {
      const b = blockOf(t);
      expect(render(b), `${t} 渲染不稳定`).toBe(render(b));
    }
  });

  it('prose 支持 **重点** 内联标记', () => {
    const html = render({ type: 'prose', body: '这是**重点**内容' });
    expect(html).toContain('<strong>重点</strong>');
  });

  it('prose 中的 HTML 被转义，不会注入', () => {
    const html = render({ type: 'prose', body: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('formula 正常渲染出 KaTeX 结构，且带符号注释', () => {
    const html = render(blockOf('formula'));
    expect(html).toContain('katex');
    expect(html).toContain('symtab');
  });

  it('formula 语法错误时降级为纯文本，不抛异常（部分失败）', () => {
    const r = renderFormula('\\frac{1}{');
    expect(r.failed).toBe(true);
    expect(r.html).toBe('');
    const html = render({ type: 'formula', latex: '\\frac{1}{', symbols: [{ s: 'x', m: '说明' }] });
    expect(html).toContain('formula-box');
    expect(html).not.toContain('katex');
  });

  it('curve 渲染坐标轴、图例与路径', () => {
    const html = render(blockOf('curve'));
    expect(html).toContain('<svg');
    expect(html).toContain('<path');
    expect(html).toContain('S');
  });

  it('dataviz 渲染出图与来源', () => {
    const html = render(blockOf('dataviz'));
    expect(html).toContain('chart-src');
    expect(html).toContain('来源');
  });

  it('dataviz 的 series 空洞会被降级为「无法显示」而不是抛异常', () => {
    const html = render({ type: 'dataviz', chart: 'bar', xLabel: 'x', yLabel: 'y', xTicks: [], series: [], source: 's' });
    expect(html).toContain('blk-degraded');
  });

  it('curve 无数据时降级', () => {
    const html = render({
      type: 'curve', xLabel: 'x', yLabel: 'y', xDomain: [0, 1], yDomain: [0, 1], series: [],
    });
    expect(html).toContain('blk-degraded');
  });

  it('可拖动的曲线：交互态渲染出滑块与当前值', () => {
    const html = render({
      type: 'curve', label: '拖动看斜率变化', xLabel: '数量', yLabel: '价格',
      xDomain: [0, 10], yDomain: [0, 10], series: [], interactive: 'elasticity',
      note: '拖动滑块改变弹性',
    });
    expect(html).toContain('type="range"');
    expect(html).toContain('需求弹性');
    expect(html).not.toContain('blk-degraded');
  });

  it('elasticitySeries 随弹性增大而变平（富有弹性 → 曲线更平坦）', () => {
    const steep = elasticitySeries(0);
    const flat = elasticitySeries(10);
    const drop = (s: { points: [number, number][] }) => s[0].points[0][1] - s[0].points[s[0].points.length - 1][1];
    expect(drop(steep)).toBeGreaterThan(drop(flat));
  });

  it('compare 渲染出完整的表头与行', () => {
    const html = render(blockOf('compare'));
    expect(html).toContain('<table');
    // 注意用 <th[ >] 排除 <thead>
    expect((html.match(/<th[ >]/g) ?? []).length).toBe(3);
    expect((html.match(/<tr/g) ?? []).length).toBe(3); // 1 表头 + 2 行
  });

  it('flow 渲染步骤与箭头，箭头数 = 步骤数 - 1', () => {
    const html = render(blockOf('flow'));
    expect((html.match(/flow-step/g) ?? []).length).toBe(2);
    expect((html.match(/flow-arrow/g) ?? []).length).toBe(1);
  });

  it('timeline 渲染事件，hot 事件带高亮类', () => {
    const html = render(blockOf('timeline'));
    expect((html.match(/tl-item/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toContain('tl-item hot');
  });

  it('pitfall 左右两栏 + 为什么', () => {
    const html = render(blockOf('pitfall'));
    expect(html).toContain('pf-wrong');
    expect(html).toContain('pf-right');
    expect(html).toContain('pf-why');
  });

  it('case 渲染指标与正文', () => {
    const html = render(blockOf('case'));
    expect(html).toContain('case-card');
    expect(html).toContain('case-nums');
  });

  it('scale 渲染各档位，换行转成 <br>', () => {
    const html = render({
      type: 'scale', ticks: [{ v: '0.05%', t: '优秀\n基本贴合' }, { v: '0.5%', t: '明显' }],
    });
    expect(html).toContain('scale-tick');
    expect(html).toContain('<br/>');
  });

  it('calc 渲染三个输入与计算结果', () => {
    const html = render(blockOf('calc'));
    expect((html.match(/type="range"/g) ?? []).length).toBe(3);
    expect(html).toContain('修正久期');
  });

  it('未知类型降级而不是抛异常', () => {
    const html = render({ type: 'nope' } as unknown as Block);
    expect(html).toContain('blk-degraded');
    expect(html).toContain('未知的讲解方式');
  });

  it('超长文本不会溢出结构，也不会被截断', () => {
    const long = '很长的一段说明。'.repeat(400);
    const html = render({ type: 'prose', body: long });
    expect(html).toContain(long.slice(0, 40));
    expect(html.length).toBeGreaterThan(long.length);
  });
});

describe('P5 久期计算器的数值正确性', () => {
  it('零息债的麦考利久期等于期限', () => {
    // 票息 0、期限 10 年 → 麦考利久期应等于 10
    const r = computeDuration({ c: 0, n: 10, y: 5 });
    expect(r.macaulay).toBeCloseTo(10, 2);
  });

  it('票息越高久期越短', () => {
    const low = computeDuration({ c: 1, n: 10, y: 4 });
    const high = computeDuration({ c: 10, n: 10, y: 4 });
    expect(high.macaulay).toBeLessThan(low.macaulay);
  });

  it('期限越长久期越长', () => {
    const short = computeDuration({ c: 3, n: 5, y: 4 });
    const long = computeDuration({ c: 3, n: 20, y: 4 });
    expect(long.macaulay).toBeGreaterThan(short.macaulay);
  });

  it('票息等于收益率时，价格等于面值 100', () => {
    const r = computeDuration({ c: 5, n: 10, y: 5 });
    expect(r.price).toBeCloseTo(100, 1);
  });

  it('修正久期 = 麦考利久期 / (1 + y)', () => {
    const r = computeDuration({ c: 3, n: 10, y: 4 });
    // 麦考利与修正久期各自四舍五入到 2 位，因此允许 0.02 的误差上界
    expect(Math.abs(r.modified - r.macaulay / 1.04)).toBeLessThan(0.02);
  });

  it('利率上行 1% 的价格变动为负，且量级与修正久期一致', () => {
    const r = computeDuration({ c: 3, n: 10, y: 4 });
    expect(r.priceChangeOnPlus1pct).toBeLessThan(-5);
    expect(Math.abs(r.priceChangeOnPlus1pct - -r.modified)).toBeLessThan(0.01);
  });

  it('脏输入不会产生 NaN', () => {
    for (const bad of [
      { c: NaN, n: 10, y: 4 },
      { c: 3, n: 0, y: 4 },
      { c: -5, n: -3, y: -99 },
      { c: 3, n: 10, y: NaN },
    ]) {
      const r = computeDuration(bad as { c: number; n: number; y: number });
      for (const v of [r.price, r.macaulay, r.modified, r.priceChangeOnPlus1pct]) {
        expect(Number.isFinite(v), `脏输入 ${JSON.stringify(bad)} 产生了非有限值`).toBe(true);
      }
    }
  });
});

describe('P5 讲解方式组合（BlockFlow）', () => {
  it('字段残缺的 block 降级显示，不抛异常', () => {
    const html = renderToStaticMarkup(<BlockRenderer block={undefined as unknown as Block} />);
    expect(html).toContain('blk-degraded');
    expect(html).toContain('格式不完整');
  });

  it('单个 block 渲染失败不影响其它 block（部分失败）', async () => {
    const { BlockFlow } = await import('../src/renderer/blocks');
    const html = renderToStaticMarkup(
      <BlockFlow blocks={[
        { type: 'prose', body: '正常内容' },
        { type: 'curve', xLabel: 'x', yLabel: 'y', xDomain: [0, 1], yDomain: [0, 1], series: [] },
        { type: 'pitfall', wrong: 'w', right: 'r', why: 'y' },
      ]} />,
    );
    expect(html).toContain('正常内容');
    expect(html).toContain('blk-degraded');
    expect(html).toContain('pf-wrong');
  });

  it('全部 11 种类型都能被 BlockRenderer 分派到具体渲染器', () => {
    const seen = new Set<BlockType>();
    for (const t of BLOCK_TYPES) {
      const html = render(blockOf(t));
      if (!html.includes('blk-degraded')) seen.add(t);
    }
    expect([...seen].sort()).toEqual([...BLOCK_TYPES].sort());
  });
});
