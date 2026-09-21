import type { Block, BlockType, Concept, Domain } from './types';
import { BLOCK_TYPES } from './types';

/**
 * 内容质量门禁（PRD §5.3 的 11 条检查 + Block 结构校验）
 *
 * 这份校验同时被两处使用：
 *   1. tools/validate-content.ts —— 内容提交前的守卫
 *   2. 内容导入管道 —— 联网下载或手动导入的内容必须过同一道门
 * 两边共用同一份实现，避免"门槛只在本地严、线上松"。
 */

export interface ValidationIssue {
  level: 'error' | 'warn';
  code: string;
  id?: string;
  message: string;
}

const count = (s: string) => [...s].length;

const LIMITS = {
  title: 20,
  oneLiner: 40,
  keyPoint: 30,
  keyPointsMin: 1,
  keyPointsMax: 3,
  blocksMin: 3,
  blocksMax: 5,
  recipeMin: 3,
  recipeMax: 5,
};

const ID_RE = /^(econ|finance|hotspot)\.(macro|micro|econometrics|equity|bond|fund|quant|event|data)\.[a-z0-9-]+$/;
const DOMAIN_TRACKS: Record<Domain, string[]> = {
  econ: ['macro', 'micro', 'econometrics'],
  finance: ['equity', 'bond', 'fund', 'quant'],
  hotspot: ['event', 'data'],
};

const DOMAIN_REQUIRED: Record<Domain, BlockType[]> = {
  econ: ['curve', 'flow'],
  finance: ['formula', 'calc', 'dataviz'],
  hotspot: ['timeline'],
};

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}
function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}

/** 校验单个 block 的必需字段；返回错误描述数组（空数组 = 通过） */
export function validateBlock(b: Block): string[] {
  const e: string[] = [];
  const any = b as unknown as Record<string, unknown>;
  switch (b.type) {
    case 'prose':
      if (!isStr(any.body)) e.push('prose.body 必须是非空字符串');
      break;
    case 'formula':
      if (!isStr(any.latex)) e.push('formula.latex 必须是非空字符串');
      if (!isArr(any.symbols) || any.symbols.length === 0) {
        e.push('formula.symbols 至少 1 条符号注释');
      } else {
        (any.symbols as Record<string, unknown>[]).forEach((s, i) => {
          if (!isStr(s.s) || !isStr(s.m)) e.push(`formula.symbols[${i}] 需要 s 与 m`);
        });
      }
      break;
    case 'curve': {
      if (!isStr(any.xLabel) || !isStr(any.yLabel)) e.push('curve 需要 xLabel 与 yLabel');
      for (const k of ['xDomain', 'yDomain'] as const) {
        const d = any[k];
        if (!isArr(d) || d.length !== 2 || !isNum(d[0]) || !isNum(d[1]) || d[1] <= d[0]) {
          e.push(`curve.${k} 必须是 [min, max] 且 max > min`);
        }
      }
      // interactive 曲线的数据由运行时按参数生成（如需求弹性），允许 series 为空
      if (any.interactive) {
        // 跳过 series 检查
      } else if (!isArr(any.series) || any.series.length === 0) {
        e.push('curve.series 至少 1 条');
      } else {
        (any.series as Record<string, unknown>[]).forEach((s, i) => {
          if (!isStr(s.name)) e.push(`curve.series[${i}].name 缺失`);
          const pts = s.points;
          if (!isArr(pts) || pts.length < 2) {
            e.push(`curve.series[${i}].points 至少 2 个点`);
          } else {
            (pts as unknown[]).forEach((p, j) => {
              if (!isArr(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) {
                e.push(`curve.series[${i}].points[${j}] 必须是 [x, y] 数字对`);
              }
            });
          }
        });
      }
      break;
    }
    case 'dataviz': {
      if (any.chart !== 'line' && any.chart !== 'bar') e.push('dataviz.chart 必须是 line 或 bar');
      if (!isStr(any.source)) e.push('dataviz.source 必填（数据类图表必须标来源）');
      if (!isArr(any.xTicks) || any.xTicks.length === 0) e.push('dataviz.xTicks 不能为空');
      if (!isArr(any.series) || any.series.length === 0) {
        e.push('dataviz.series 至少 1 条');
      } else {
        const n = any.xTicks && isArr(any.xTicks) ? any.xTicks.length : 0;
        (any.series as Record<string, unknown>[]).forEach((s, i) => {
          if (!isStr(s.name)) e.push(`dataviz.series[${i}].name 缺失`);
          if (!isArr(s.points) || s.points.length !== n) {
            e.push(`dataviz.series[${i}].points 长度必须等于 xTicks 长度（${n}）`);
          } else if ((s.points as unknown[]).some((v) => !isNum(v))) {
            e.push(`dataviz.series[${i}].points 必须全为数字`);
          }
        });
      }
      break;
    }
    case 'compare': {
      const cols = any.columns;
      const rows = any.rows;
      if (!isArr(cols) || cols.length < 2) e.push('compare.columns 至少 2 列');
      if (!isArr(rows) || rows.length === 0) {
        e.push('compare.rows 至少 1 行');
      } else if (isArr(cols)) {
        (rows as unknown[]).forEach((r, i) => {
          if (!isArr(r) || r.length !== cols.length) {
            e.push(`compare.rows[${i}] 的列数必须等于 columns 的列数（${cols.length}）`);
          }
        });
      }
      break;
    }
    case 'flow':
      if (!isArr(any.steps) || any.steps.length < 2) e.push('flow.steps 至少 2 步');
      else (any.steps as Record<string, unknown>[]).forEach((s, i) => {
        if (!isStr(s.label)) e.push(`flow.steps[${i}].label 缺失`);
      });
      break;
    case 'timeline':
      if (!isArr(any.events) || any.events.length < 2) e.push('timeline.events 至少 2 条');
      else (any.events as Record<string, unknown>[]).forEach((ev, i) => {
        for (const k of ['date', 'title', 'note'] as const) {
          if (!isStr(ev[k])) e.push(`timeline.events[${i}].${k} 缺失`);
        }
      });
      break;
    case 'pitfall':
      for (const k of ['wrong', 'right', 'why'] as const) {
        if (!isStr(any[k])) e.push(`pitfall.${k} 缺失`);
      }
      break;
    case 'case':
      if (!isStr(any.title)) e.push('case.title 缺失');
      if (!isStr(any.body)) e.push('case.body 缺失');
      break;
    case 'scale':
      if (!isArr(any.ticks) || any.ticks.length < 2 || any.ticks.length > 4) {
        e.push('scale.ticks 需要 2–4 档');
      } else (any.ticks as Record<string, unknown>[]).forEach((t, i) => {
        if (!isStr(t.v) || !isStr(t.t)) e.push(`scale.ticks[${i}] 需要 v 与 t`);
      });
      break;
    case 'calc':
      if (any.calc !== 'duration') e.push(`calc.calc 只支持 duration（收到 ${String(any.calc)}）`);
      if (!isArr(any.inputs) || any.inputs.length === 0) {
        e.push('calc.inputs 至少 1 个输入项');
      } else (any.inputs as Record<string, unknown>[]).forEach((inp, i) => {
        for (const k of ['key', 'label', 'unit'] as const) {
          if (!isStr(inp[k])) e.push(`calc.inputs[${i}].${k} 缺失`);
        }
        for (const k of ['min', 'max', 'step', 'v'] as const) {
          if (!isNum(inp[k])) e.push(`calc.inputs[${i}].${k} 必须是数字`);
        }
      });
      break;
    default:
      e.push(`未知的 block 类型：${String((b as { type?: unknown }).type)}`);
  }
  return e;
}

/**
 * 扫描概念里所有字符串，找出**字面**的反斜杠转义序列（\n / \t / \r）。
 *
 * 为什么会需要这条：在 YAML 双引号串里写 `\\n`，解析结果是「反斜杠 + n」两个字符，
 * 而不是换行；渲染器按真实换行切分，于是页面上会直接显示 "\n" 文本。
 * 这类问题此前的所有检查都拦不住，只有人读的时候才看得见，所以补成硬规则。
 *
 * 跳过 `latex` 与符号名 `s`：LaTeX 里 `\text`、`\hat{\beta}` 本来就是反斜杠开头，
 * 在这两个字段上检查只会全是误报。
 */
const ESCAPE_SKIP_KEYS = new Set(['latex', 's']);

function literalEscapes(concept: Concept): string[] {
  const out: string[] = [];
  const walk = (node: unknown, path: string, key: string): void => {
    if (typeof node === 'string') {
      if (ESCAPE_SKIP_KEYS.has(key)) return;
      const m = node.match(/\\[ntr]/);
      if (m) {
        out.push(`${path || '(root)'} 里出现字面的 "${m[0]}" —— 应写成 YAML 的真实换行，否则页面会直接显示这两个字符`);
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, key));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, k);
      }
    }
  };
  walk(concept as unknown, '', '');
  return out;
}

export function validateConcept(c: Concept): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const push = (code: string, message: string, level: 'error' | 'warn' = 'error') =>
    out.push({ level, code, id: c.id, message });

  // ---- 检查 1：id 规范 ----
  if (!isStr(c.id) || !ID_RE.test(c.id)) {
    push('id-format', `id 不符合 domain.track.slug 规范：${String(c.id)}`);
  } else {
    const [dom, track] = c.id.split('.');
    if (c.domain && c.domain !== dom) push('id-domain', `id 前缀 ${dom} 与 domain ${c.domain} 不一致`);
    if (c.track && c.track !== track) push('id-track', `id 中的 track ${track} 与 track ${c.track} 不一致`);
  }

  // ---- 检查 2：标题与一句话长度 ----
  if (!isStr(c.title)) push('title-empty', 'title 不能为空');
  else if (count(c.title) > LIMITS.title) push('title-len', `title 超过 ${LIMITS.title} 字（${count(c.title)}）`);

  if (!isStr(c.one_liner)) push('oneliner-empty', 'one_liner 不能为空');
  else if (count(c.one_liner) > LIMITS.oneLiner) {
    push('oneliner-len', `one_liner 超过 ${LIMITS.oneLiner} 字（${count(c.one_liner)}）`);
  }

  // ---- 检查 3：key_points ----
  if (!isArr(c.key_points) || c.key_points.length < LIMITS.keyPointsMin || c.key_points.length > LIMITS.keyPointsMax) {
    push('kp-count', `key_points 必须是 ${LIMITS.keyPointsMin}–${LIMITS.keyPointsMax} 条（当前 ${isArr(c.key_points) ? c.key_points.length : 0}）`);
  } else {
    c.key_points.forEach((p, i) => {
      if (!isStr(p)) push('kp-empty', `key_points[${i}] 不能为空`);
      else if (count(p) > LIMITS.keyPoint) {
        push('kp-len', `key_points[${i}] 超过 ${LIMITS.keyPoint} 字（${count(p)}）`);
      }
      if (isStr(p) && isStr(c.one_liner) && p.trim() === c.one_liner.trim()) {
        push('kp-dup', `key_points[${i}] 与 one_liner 完全相同`);
      }
    });
  }

  // ---- 检查 4：blocks 数量与类型 ----
  const blocks = isArr(c.blocks) ? c.blocks : [];
  if (blocks.length < LIMITS.blocksMin || blocks.length > LIMITS.blocksMax) {
    push('blocks-count', `blocks 必须是 ${LIMITS.blocksMin}–${LIMITS.blocksMax} 个（当前 ${blocks.length}）`);
  }
  blocks.forEach((b, i) => {
    if (!BLOCK_TYPES.includes(b?.type)) {
      push('block-type', `blocks[${i}] 类型非法：${String(b?.type)}`);
      return;
    }
    validateBlock(b).forEach((m) => push('block-struct', `blocks[${i}] ${m}`));
  });

  // ---- 检查 5：recipe 与实际 blocks 一致 ----
  const actual = [...new Set(blocks.map((b) => b?.type).filter(Boolean))] as BlockType[];
  const recipe = isArr(c.recipe) ? c.recipe : [];
  if (recipe.length < LIMITS.recipeMin || recipe.length > LIMITS.recipeMax) {
    push('recipe-count', `recipe 必须是 ${LIMITS.recipeMin}–${LIMITS.recipeMax} 种（当前 ${recipe.length}）`);
  }
  const rset = new Set(recipe);
  if (rset.size !== recipe.length) push('recipe-dup', 'recipe 里出现重复类型');
  actual.forEach((t) => {
    if (!rset.has(t)) push('recipe-mismatch', `recipe 缺少实际存在的讲解方式 ${t}`);
  });
  recipe.forEach((t) => {
    if (!actual.includes(t)) push('recipe-mismatch', `recipe 声明了 ${t} 但 blocks 里没有`);
  });

  // ---- 检查 7：links ----
  if (!isArr(c.links) || c.links.length < 1) {
    push('links-empty', 'links 至少 1 条（每个概念都必须能挂到别处）');
  } else {
    c.links.forEach((l, i) => {
      if (!isStr(l?.to)) push('link-to', `links[${i}].to 缺失`);
      if (!isStr(l?.reason)) push('link-reason', `links[${i}] 缺少 reason（禁止裸链接）`);
      if (isStr(l?.to) && l.to === c.id) push('link-self', `links[${i}] 指向自己`);
    });
  }

  // ---- 检查 8：三大区差异化 ----
  if (c.domain && DOMAIN_TRACKS[c.domain] && !DOMAIN_TRACKS[c.domain].includes(c.track)) {
    push('track-domain', `track ${c.track} 不属于 domain ${c.domain}`);
  }
  if (c.domain && DOMAIN_REQUIRED[c.domain]) {
    const need = DOMAIN_REQUIRED[c.domain];
    if (!need.some((t) => actual.includes(t))) {
      push('domain-block', `${c.domain} 区必须包含 ${need.join(' / ')} 之一`);
    }
    if (c.domain === 'hotspot' && !isStr(c.source)) {
      push('hotspot-source', 'hotspot 区 source 必填');
    }
  }

  // ---- 检查 9：dataviz 必须有 source（已在 validateBlock 覆盖，此处再兜一层） ----
  blocks.filter((b) => b?.type === 'dataviz').forEach((b, i) => {
    if (!isStr((b as { source?: unknown }).source)) {
      push('dataviz-source', `第 ${i + 1} 个 dataviz 缺少 source`);
    }
  });

  // ---- 检查 10：字面转义序列 ----
  // 真事：YAML 双引号串里写 `\\n` 会被解析成**反斜杠 + n 两个字符**，
  // 而渲染器是按真实换行切分的，于是页面上会直接显示 "\n" 文本。
  // 这类错误此前能静默通过全套检查，用户只有在阅读时才看得到，所以补一条硬规则。
  literalEscapes(c).forEach((m) => push('escape-literal', m));

  // ---- 其他字段 ----
  if (!isStr(c.updated_at)) push('updated-empty', 'updated_at 必填');
  if (![1, 2, 3].includes(c.difficulty)) push('difficulty', `difficulty 必须是 1/2/3（当前 ${String(c.difficulty)}）`);
  if (!isArr(c.tags) || c.tags.length === 0) push('tags-empty', 'tags 至少 1 个', 'warn');
  if (!isNum(c.order)) push('order', 'order 必须是数字');

  return out;
}

export interface ValidateOptions {
  /** 是否做全库级检查（唯一性、死链、recipe 组合唯一、难度分布） */
  wholeLibrary?: boolean;
}

export function validateContent(concepts: Concept[], opts: ValidateOptions = {}): ValidationIssue[] {
  const whole = opts.wholeLibrary !== false;
  const issues: ValidationIssue[] = [];

  concepts.forEach((c) => issues.push(...validateConcept(c)));

  if (!whole) return issues;

  const push = (code: string, message: string, id?: string, level: 'error' | 'warn' = 'error') =>
    issues.push({ level, code, id, message });

  // ---- 检查 1（续）：id 全库唯一 ----
  const seen = new Map<string, number>();
  concepts.forEach((c) => seen.set(c.id, (seen.get(c.id) ?? 0) + 1));
  seen.forEach((n, id) => {
    if (n > 1) push('id-duplicate', `id 重复出现 ${n} 次`, id);
  });

  // ---- 检查 6：recipe 组合全库唯一 ----
  const recipeSeen = new Map<string, string>();
  concepts.forEach((c) => {
    const key = [...(c.recipe ?? [])].sort().join('+');
    if (!key) return;
    const prev = recipeSeen.get(key);
    if (prev) {
      push('recipe-collision',
        `recipe 组合与「${prev}」完全相同（${key}）——「解析方法多样化」要求任意两条概念的讲解方式组合不得相同`,
        c.id);
    } else {
      recipeSeen.set(key, c.id);
    }
  });

  // ---- 检查 7（续）：死链 ----
  const ids = new Set(concepts.map((c) => c.id));
  concepts.forEach((c) => {
    (c.links ?? []).forEach((l) => {
      if (isStr(l?.to) && !ids.has(l.to)) {
        push('link-dead', `links 指向不存在的概念：${l.to}`, c.id);
      }
    });
  });

  // ---- 检查 10：孤立概念（警告） ----
  const pointed = new Set<string>();
  concepts.forEach((c) => (c.links ?? []).forEach((l) => pointed.add(l.to)));
  concepts.forEach((c) => {
    if (!pointed.has(c.id)) push('orphan', '该概念没有任何其他概念指向它（孤立节点）', c.id, 'warn');
  });

  // ---- 检查 11：难度分布（警告） ----
  const diffCount = { 1: 0, 2: 0, 3: 0 } as Record<number, number>;
  concepts.forEach((c) => { diffCount[c.difficulty] = (diffCount[c.difficulty] ?? 0) + 1; });
  ([1, 2, 3] as const).forEach((d) => {
    if (concepts.length >= 6 && diffCount[d] === 0) {
      push('difficulty-spread', `难度 ${d} 档一个概念都没有，三档都应覆盖`, undefined, 'warn');
    }
  });

  return issues;
}

export function summarize(issues: ValidationIssue[]) {
  return {
    errors: issues.filter((i) => i.level === 'error'),
    warnings: issues.filter((i) => i.level === 'warn'),
  };
}
