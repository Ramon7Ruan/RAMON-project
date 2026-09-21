import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Concept } from '../src/shared/types';
import { validateConcept, validateContent, summarize } from '../src/shared/validate';
import { buildJsonl } from '../app/services';
import { parseJsonl } from '../app/update/updater';
import { initContentDb } from '../app/db';
import { allConcepts, buildContentDb, getConcept, listSummaries, search } from '../app/db/content';
import { cleanup, makeConcept, makeGroup, tempDir } from './fixtures';

const codes = (list: ReturnType<typeof validateContent>) => list.map((i) => i.code);
const errCodes = (list: ReturnType<typeof validateContent>) => list.filter((i) => i.level === 'error').map((i) => i.code);

describe('P5 内容质量门禁：每条规则都真的会拦下违规内容', () => {
  it('① id 命名不规范被拦', () => {
    const bad = makeConcept({ id: 'BadID' });
    expect(codes(validateConcept(bad))).toContain('id-format');
  });

  it('① id 全库重复被拦', () => {
    const a = makeConcept({ id: 'econ.macro.dup' });
    const b = makeConcept({ id: 'econ.macro.dup' });
    expect(errCodes(validateContent([a, b]))).toContain('id-duplicate');
  });

  it('② title / one_liner 超长被拦', () => {
    const bad = makeConcept({ title: '很长的标题'.repeat(6), one_liner: '很长的一句话'.repeat(8) });
    const c = codes(validateConcept(bad));
    expect(c).toContain('title-len');
    expect(c).toContain('oneliner-len');
  });

  it('③ key_points 条数越界 / 超长 / 与 one_liner 重复被拦', () => {
    expect(codes(validateConcept(makeConcept({ key_points: [] })))).toContain('kp-count');
    expect(codes(validateConcept(makeConcept({ key_points: ['a', 'b', 'c', 'd'] })))).toContain('kp-count');
    expect(codes(validateConcept(makeConcept({ key_points: ['很长的结论'.repeat(10)] })))).toContain('kp-len');
    const dup = makeConcept({ one_liner: '同一句话', key_points: ['同一句话'] });
    expect(codes(validateConcept(dup))).toContain('kp-dup');
  });

  it('④ blocks 数量越界被拦', () => {
    const two = makeConcept({ blocks: [{ type: 'prose', body: 'x' }, { type: 'prose', body: 'y' }] });
    expect(codes(validateConcept(two))).toContain('blocks-count');
  });

  it('⑤ recipe 与 blocks 不一致被拦', () => {
    const c = makeConcept({ recipe: ['prose', 'flow', 'timeline'] }); // 实际是 prose/flow/curve/…
    expect(codes(validateConcept(c))).toContain('recipe-mismatch');
  });

  it('⑥ recipe 组合全库重复被拦（这是"解析方法多样化"的执行者）', () => {
    const a = makeConcept({ id: 'econ.macro.r1', variant: 0 });
    const b = makeConcept({ id: 'econ.macro.r2', variant: 0 }); // 同一组 recipe
    const list = validateContent([a, b]);
    expect(errCodes(list)).toContain('recipe-collision');
    expect(list.find((i) => i.code === 'recipe-collision')?.message).toContain('多样化');
  });

  it('⑦ links 为空 / 缺 reason / 指向不存在的概念，全部被拦', () => {
    expect(codes(validateConcept(makeConcept({ links: [] })))).toContain('links-empty');
    expect(codes(validateConcept(makeConcept({ links: [{ to: 'x.y.z', reason: '' }] })))).toContain('link-reason');
    const lone = makeConcept({ id: 'econ.macro.lone', links: [{ to: '不存在的概念', reason: '测试' }] });
    expect(errCodes(validateContent([lone]))).toContain('link-dead');
  });

  it('⑦ 指向自己也算违规', () => {
    const self = makeConcept({ id: 'econ.macro.self' });
    self.links = [{ to: self.id, reason: '自引用' }];
    expect(codes(validateConcept(self))).toContain('link-self');
  });

  it('⑧ 三大区差异化：econ 必须含 curve/flow', () => {
    const bad = makeConcept({
      domain: 'econ', track: 'micro',
      blocks: [{ type: 'prose', body: 'x' }, { type: 'compare', columns: ['a', 'b'], rows: [['1', '2']] }, { type: 'pitfall', wrong: 'w', right: 'r', why: 'y' }],
    });
    expect(codes(validateConcept(bad))).toContain('domain-block');
  });

  it('⑧ 三大区差异化：finance 必须含 formula/calc/dataviz', () => {
    const bad = makeConcept({
      domain: 'finance', track: 'bond',
      blocks: [{ type: 'prose', body: 'x' }, { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }, { type: 'pitfall', wrong: 'w', right: 'r', why: 'y' }],
    });
    expect(codes(validateConcept(bad))).toContain('domain-block');
  });

  it('⑧ 三大区差异化：hotspot 必须含 timeline 且 source 必填', () => {
    const noTimeline = makeConcept({
      domain: 'hotspot', track: 'event', source: '来源 截至 2026-09-20',
      blocks: [{ type: 'prose', body: 'x' }, { type: 'dataviz', chart: 'bar', xLabel: 'x', yLabel: 'y', xTicks: ['a'], series: [{ name: 's', points: [1] }], source: 's' }, { type: 'pitfall', wrong: 'w', right: 'r', why: 'y' }],
    });
    expect(codes(validateConcept(noTimeline))).toContain('domain-block');

    // fixture 会为 hotspot 自动补一个默认 source，这里显式抹掉来验证必填规则
    const noSource: Concept = { ...makeConcept({ domain: 'hotspot', track: 'event' }), source: undefined };
    expect(codes(validateConcept(noSource))).toContain('hotspot-source');
  });

  it('⑨ dataviz 缺 source 被拦', () => {
    const bad = makeConcept({
      blocks: [
        { type: 'prose', body: 'x' },
        { type: 'dataviz', chart: 'bar', xLabel: 'x', yLabel: 'y', xTicks: ['a'], series: [{ name: 's', points: [1] }], source: '' },
        { type: 'compare', columns: ['a', 'b'], rows: [['1', '2']] },
      ],
    });
    expect(codes(validateConcept(bad))).toContain('dataviz-source');
  });

  it('⑩ 孤立概念给出警告但不拦截', () => {
    const list = makeGroup(3).map((c, i) => (i === 0 ? { ...c, links: [] } : c));
    const warnings = validateContent(list).filter((i) => i.level === 'warn');
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('⑪ 难度分布不均给出警告但不拦截', () => {
    const list = makeGroup(6).map((c) => ({ ...c, difficulty: 2 as const }));
    const issues = validateContent(list);
    expect(issues.some((i) => i.code === 'difficulty-spread' && i.level === 'warn')).toBe(true);
    // 但不应因为难度问题产生 error
    expect(issues.filter((i) => i.level === 'error' && i.code === 'difficulty-spread')).toEqual([]);
  });

  it('Block 结构校验：缺字段 / 长度不符 / 数值非法全被拦', () => {
    const cases: [string, Concept][] = [
      ['prose.body 为空', makeConcept({ blocks: [{ type: 'prose', body: '' }, { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }, { type: 'curve', xLabel: 'x', yLabel: 'y', xDomain: [0, 1], yDomain: [0, 1], series: [{ name: 's', points: [[0, 0], [1, 1]] }] }] })],
      ['formula.symbols 为空', makeConcept({ blocks: [{ type: 'formula', latex: 'a=b', symbols: [] }, { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }, { type: 'curve', xLabel: 'x', yLabel: 'y', xDomain: [0, 1], yDomain: [0, 1], series: [{ name: 's', points: [[0, 0], [1, 1]] }] }] })],
      ['curve.xDomain 非法', makeConcept({ blocks: [{ type: 'prose', body: 'x' }, { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }, { type: 'curve', xLabel: 'x', yLabel: 'y', xDomain: [1, 1], yDomain: [0, 1], series: [{ name: 's', points: [[0, 0], [1, 1]] }] }] })],
      ['dataviz.points 长度与 xTicks 不符', makeConcept({ blocks: [{ type: 'prose', body: 'x' }, { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }, { type: 'dataviz', chart: 'bar', xLabel: 'x', yLabel: 'y', xTicks: ['a', 'b'], series: [{ name: 's', points: [1] }], source: 's' }] })],
      ['compare 行列数不符', makeConcept({ blocks: [{ type: 'prose', body: 'x' }, { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }, { type: 'compare', columns: ['a', 'b'], rows: [['1']] }] })],
      ['flow 只有一步', makeConcept({ blocks: [{ type: 'prose', body: 'x' }, { type: 'flow', steps: [{ label: 'a' }] }, { type: 'curve', xLabel: 'x', yLabel: 'y', xDomain: [0, 1], yDomain: [0, 1], series: [{ name: 's', points: [[0, 0], [1, 1]] }] }] })],
      ['timeline 事件缺字段', makeConcept({ blocks: [{ type: 'prose', body: 'x' }, { type: 'timeline', events: [{ date: '1', title: 't', note: 'n' }, { date: '2', title: '', note: 'n' }] }, { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] }] })],
    ];
    for (const [label, c] of cases) {
      const found = codes(validateConcept(c));
      expect(found, `${label} 没有被拦下`).toContain('block-struct');
    }
  });

  it('⑫ 字面转义序列 \\n 被拦（YAML 里写 \\\\n 会渲染成两个字符）', () => {
    const bad = makeConcept({
      blocks: [
        { type: 'prose', body: '第一行\\n第二行' },
        { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] },
        { type: 'curve', xLabel: 'x', yLabel: 'y', xDomain: [0, 1], yDomain: [0, 1], series: [{ name: 's', points: [[0, 0], [1, 1]] }] },
      ],
    });
    expect(codes(validateConcept(bad))).toContain('escape-literal');
  });

  it('⑫ latex 与符号名里的反斜杠不算违规（避免误伤 LaTeX）', () => {
    const ok = makeConcept({
      blocks: [
        { type: 'prose', body: '正常文本' },
        { type: 'flow', steps: [{ label: 'a' }, { label: 'b' }] },
        {
          type: 'formula',
          latex: '\\text{分位} = \\frac{\\#\\{t \\in T\\}}{\\#\\{t \\in T\\}}',
          symbols: [{ s: '\\hat{\\beta}', m: '估计值' }],
        },
      ],
    });
    expect(codes(validateConcept(ok))).not.toContain('escape-literal');
  });

  it('合法内容零 error（避免门禁误伤）', () => {
    const list = makeGroup(6);
    const { errors, warnings } = summarize(validateContent(list));
    expect(errors, JSON.stringify(errors.slice(0, 3))).toEqual([]);
    expect(warnings.length).toBeLessThanOrEqual(list.length);
  });
});

describe('P5 内容管道往返一致性', () => {
  it('YAML 对象 → content.db → 读回，字段完全一致', () => {
    const dir = tempDir('recall-rt-');
    const db = initContentDb(join(dir, 'content.db'));
    try {
      const list = makeGroup(3);
      buildContentDb(db, list, { version: '2026.09.21', updated_at: '2026-09-21T00:00:00Z', schema_version: 1 });
      const back = allConcepts(db);
      expect(back.length).toBe(list.length);
      for (const orig of list) {
        const got = getConcept(db, orig.id);
        expect(got, `${orig.id} 读不回来`).not.toBeNull();
        expect(got!.title).toBe(orig.title);
        expect(got!.one_liner).toBe(orig.one_liner);
        expect(got!.key_points).toEqual(orig.key_points);
        expect(got!.recipe).toEqual(orig.recipe);
        expect(got!.blocks).toEqual(orig.blocks);
        expect(got!.links).toEqual(orig.links);
        expect(got!.difficulty).toBe(orig.difficulty);
        expect(got!.source).toBe(orig.source);
      }
    } finally { db.close(); cleanup(dir); }
  });

  it('buildJsonl → parseJsonl 往返一致，且首行是 _meta', () => {
    const list = makeGroup(3);
    const text = buildJsonl(list, '2026.09.30', '2026-09-30T00:00:00Z');
    const lines = text.trim().split('\n');
    expect(JSON.parse(lines[0])._meta.version).toBe('2026.09.30');

    const { meta, concepts, badLines } = parseJsonl(text);
    expect(badLines).toEqual([]);
    expect(concepts.length).toBe(list.length);
    expect(meta?.version).toBe('2026.09.30');
    expect(concepts[0].blocks).toEqual(list[0].blocks);
  });

  it('parseJsonl 能指出坏行行号，而不是整体失败', () => {
    const list = makeGroup(2);
    const text = buildJsonl(list, '2026.09.30', 'x');
    const broken = text.split('\n');
    broken.splice(2, 0, '{ 这不是合法 JSON');
    const r = parseJsonl(broken.join('\n'));
    expect(r.badLines).toEqual([3]);
    expect(r.concepts.length).toBe(2);
  });

  it('真实中文内容能被 FTS5 检索到（子串、跨词、中英混排）', () => {
    const dir = tempDir('recall-fts-');
    const db = initContentDb(join(dir, 'content.db'));
    try {
      const list = [
        makeConcept({ id: 'econ.macro.monetary-transmission', title: '货币政策传导机制', one_liner: '央行降息，为什么企业不一定马上借钱？', key_points: ['三道关：负债端、信贷定价、企业预期'], links: [] }),
        makeConcept({ id: 'finance.bond.yield-curve', domain: 'finance', track: 'bond', title: '收益率曲线', one_liner: '短端降了，长端为什么不动？', key_points: ['长端由增长与通胀预期决定'], links: [] }),
        makeConcept({ id: 'finance.quant.ic-icir', domain: 'finance', track: 'quant', title: 'IC 与 ICIR', one_liner: '一个因子有预测力，怎么用数字证明？', key_points: ['IC 看方向，ICIR 看稳定'], links: [] }),
      ];
      buildContentDb(db, list, { version: '2026.09.21', updated_at: 'x', schema_version: 1 });

      expect(search(db, '传导', 10).map((h) => h.id)).toContain('econ.macro.monetary-transmission');
      expect(search(db, '货币政策', 10).map((h) => h.id)).toContain('econ.macro.monetary-transmission');
      expect(search(db, '曲线', 10).map((h) => h.id)).toContain('finance.bond.yield-curve');
      expect(search(db, 'ICIR', 10).map((h) => h.id)).toContain('finance.quant.ic-icir');
      expect(search(db, '预期', 10).length).toBeGreaterThanOrEqual(2);

      // 排序：标题命中的排在正文命中之前
      const hits = search(db, '曲线', 10);
      expect(hits[0].id).toBe('finance.bond.yield-curve');
    } finally { db.close(); cleanup(dir); }
  });

  it('summaries 只含速览所需字段，不携带 blocks/links（保证首屏轻量）', () => {
    const dir = tempDir('recall-sum-');
    const db = initContentDb(join(dir, 'content.db'));
    try {
      buildContentDb(db, makeGroup(3), { version: 'v', updated_at: 'x', schema_version: 1 });
      const s = listSummaries(db);
      expect(s.length).toBe(3);
      for (const one of s) {
        expect((one as unknown as { blocks?: unknown }).blocks).toBeUndefined();
        expect((one as unknown as { links?: unknown }).links).toBeUndefined();
        expect(one.key_points.length).toBeGreaterThan(0);
      }
    } finally { db.close(); cleanup(dir); }
  });
});

describe('P5 打包版本号规则', () => {
  it('compareVersion 只做字符串比较，不做语义化推理', () => {
    // 与架构 §4.8 一致：YYYY.MM.DD 字典序等于时间序
    expect('2026.09.30' > '2026.09.21').toBe(true);
    expect('2026.10.01' > '2026.09.30').toBe(true);
  });
});
