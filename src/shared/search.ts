import type { Concept } from './types';

/**
 * FTS5 的中文检索支持。
 *
 * 问题：FTS5 的 unicode61 分词器把一整串汉字当成**一个** token，
 * 于是「货币政策传导机制」只有整串能命中，搜「传导」永远搜不到。
 *
 * 方案：写入索引前把 CJK 逐字拆开（"货 币 政 策 传 导 机 制"），
 * 查询串做同样处理，FTS5 的短语匹配即可命中任意子串。
 * ASCII（PE、ICIR、LPR…）保持原样，因此中英混排也能命中。
 *
 * 这是 PRD §4.4「FTS5 能搜到中文子串」的实现基础。
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff]/g;

export function segment(text: string): string {
  if (!text) return '';
  return text
    .replace(CJK, (ch) => ` ${ch} `)
    .replace(/[\s\u3000]+/g, ' ')
    .trim();
}

/** 把查询串转成 FTS5 查询：每个 token 加双引号避免特殊字符被当语法 */
export function toMatchQuery(text: string): string {
  const seg = segment(text);
  if (!seg) return '';
  return seg
    .split(' ')
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** 用于建立索引的正文扁平化：把 blocks 里所有可读文字抽出来 */
export function flatBody(c: Concept): string {
  const parts: string[] = [c.title, c.one_liner, ...c.key_points, ...c.tags];
  for (const b of c.blocks) {
    switch (b.type) {
      case 'prose': parts.push(b.body); break;
      case 'formula': parts.push(b.latex, b.note ?? '', ...b.symbols.map((s) => `${s.s} ${s.m}`)); break;
      case 'curve': parts.push(b.note ?? '', b.xLabel, b.yLabel, ...b.series.map((s) => s.name)); break;
      case 'dataviz': parts.push(b.xLabel, b.yLabel, b.source, ...b.series.map((s) => s.name)); break;
      case 'compare': parts.push(...b.columns, ...b.rows.flat()); break;
      case 'flow': parts.push(...b.steps.map((s) => `${s.label} ${s.note ?? ''}`)); break;
      case 'timeline': parts.push(...b.events.map((e) => `${e.date} ${e.title} ${e.note}`)); break;
      case 'pitfall': parts.push(b.wrong, b.right, b.why); break;
      case 'case': parts.push(b.title, b.body, ...(b.nums ?? []).map((n) => `${n.label} ${n.v}`)); break;
      case 'scale': parts.push(...b.ticks.map((t) => `${t.v} ${t.t}`)); break;
      case 'calc': parts.push(...b.inputs.map((i) => i.label)); break;
    }
  }
  parts.push(...c.links.map((l) => l.reason));
  return parts.filter(Boolean).join(' ');
}

/**
 * 结果排序权重。FTS5 的 bm25 对不同列给权重，这里用「命中在哪一列」
 * 做一层业务加权：标题命中 > 一句话 > 标签 > 正文。
 * 返回分数越大越靠前。
 */
export function relevance(c: Concept, q: string): number {
  const needle = q.trim().toLowerCase();
  if (!needle) return 0;
  let score = 0;
  if (c.title.toLowerCase().includes(needle)) score += 100;
  if (c.one_liner.toLowerCase().includes(needle)) score += 40;
  if (c.tags.some((t) => t.toLowerCase().includes(needle))) score += 25;
  if (c.key_points.some((k) => k.toLowerCase().includes(needle))) score += 15;
  if (flatBody(c).toLowerCase().includes(needle)) score += 5;
  return score;
}
