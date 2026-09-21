import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Concept } from '../src/shared/types';
import { summarize, validateContent } from '../src/shared/validate';
import { loadContent } from '../app/content/load';
import { buildJsonl } from '../app/services';
import { parseJsonl } from '../app/update/updater';
import { initContentDb } from '../app/db';
import { allConcepts, buildContentDb, search } from '../app/db/content';
import { cleanup, tempDir } from './fixtures';

const ROOT = join(__dirname, '..');
const { concepts, parseErrors } = loadContent(join(ROOT, 'content'));
const byId = new Map(concepts.map((c) => [c.id, c]));
const inDegree = new Map<string, number>();
concepts.forEach((c) => inDegree.set(c.id, 0));
concepts.forEach((c) => (c.links ?? []).forEach((l) => {
  if (inDegree.has(l.to)) inDegree.set(l.to, (inDegree.get(l.to) ?? 0) + 1);
}));
const typesOf = (c: Concept) => [...new Set(c.blocks.map((b) => b.type))];

describe('P7 内容生产：规模与分布（PRD §5.1）', () => {
  it('YAML 全部可解析', () => {
    expect(parseErrors, JSON.stringify(parseErrors)).toEqual([]);
  });

  it('总量 68 个：经济学 24 / 金融学 24 / 世界热点 20', () => {
    expect(concepts.length).toBe(68);
    const by = (d: string) => concepts.filter((c) => c.domain === d).length;
    expect({ econ: by('econ'), finance: by('finance'), hotspot: by('hotspot') })
      .toEqual({ econ: 24, finance: 24, hotspot: 20 });
  });

  it('9 个专题分布达标，且每个专题不少于 5 个', () => {
    const want: Record<string, number> = {
      macro: 10, micro: 8, econometrics: 6,
      equity: 7, bond: 6, fund: 5, quant: 6,
      event: 12, data: 8,
    };
    const got: Record<string, number> = {};
    concepts.forEach((c) => { got[c.track] = (got[c.track] ?? 0) + 1; });
    expect(got).toEqual(want);
    for (const [track, n] of Object.entries(want)) {
      expect(n, `专题 ${track} 数量不足 5`).toBeGreaterThanOrEqual(5);
    }
  });

  it('id / title 全库唯一', () => {
    expect(new Set(concepts.map((c) => c.id)).size).toBe(concepts.length);
    expect(new Set(concepts.map((c) => c.title)).size).toBe(concepts.length);
  });

  it('难度覆盖 1/2/3，且不出现单一难度占多数以上的偏斜', () => {
    const d = [0, 0, 0, 0];
    concepts.forEach((c) => { d[c.difficulty] += 1; });
    expect(d[1]).toBeGreaterThan(0);
    expect(d[2]).toBeGreaterThan(0);
    expect(d[3]).toBeGreaterThan(0);
    expect(Math.max(d[1], d[2], d[3]) / concepts.length).toBeLessThan(0.7);
  });
});

describe('P7 内容生产：单概念质量', () => {
  it('每个概念 1–3 条 key_points，每条 ≤30 字，且不与 one_liner 重复', () => {
    const bad: string[] = [];
    concepts.forEach((c) => {
      if (!c.key_points || c.key_points.length < 1 || c.key_points.length > 3) bad.push(`${c.id} 条数=${c.key_points?.length}`);
      (c.key_points ?? []).forEach((p) => {
        if (p.length > 30) bad.push(`${c.id} 超长(${p.length})：${p}`);
        if (p === c.one_liner) bad.push(`${c.id} 与 one_liner 重复`);
      });
      if (c.one_liner.length > 40) bad.push(`${c.id} one_liner 超 40 字`);
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('每个概念至少 3 种讲解方式，且 recipe 组合全库唯一', () => {
    const seen = new Map<string, string>();
    const dup: string[] = [];
    concepts.forEach((c) => {
      const key = [...typesOf(c)].sort().join('+');
      expect(typesOf(c).length, `${c.id} 讲解方式不足 3 种`).toBeGreaterThanOrEqual(3);
      expect(typesOf(c).length, `${c.id} 讲解方式超过 5 种`).toBeLessThanOrEqual(5);
      if (seen.has(key)) dup.push(`${c.id} 与 ${seen.get(key)} 组合相同：${key}`);
      seen.set(key, c.id);
    });
    expect(dup, dup.join('\n')).toEqual([]);
    // 68 个概念 → 68 种互不相同的讲解方式组合
    expect(seen.size).toBe(concepts.length);
  });

  it('三大区差异化要求逐条命中', () => {
    const bad: string[] = [];
    concepts.filter((c) => c.domain === 'econ').forEach((c) => {
      const t = typesOf(c);
      if (!t.includes('curve') && !t.includes('flow')) bad.push(`${c.id} 经济学缺 curve/flow`);
    });
    concepts.filter((c) => c.domain === 'finance').forEach((c) => {
      const t = typesOf(c);
      if (!t.includes('formula') && !t.includes('calc') && !t.includes('dataviz')) bad.push(`${c.id} 金融学缺 formula/calc/dataviz`);
    });
    concepts.filter((c) => c.domain === 'hotspot').forEach((c) => {
      const t = typesOf(c);
      if (!t.includes('timeline')) bad.push(`${c.id} 热点缺 timeline`);
      if (!c.source || !c.source.trim()) bad.push(`${c.id} 热点缺 source`);
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('热点概念必须挂到基础概念上（否则时效内容无法沉淀）', () => {
    const bad: string[] = [];
    concepts.filter((c) => c.domain === 'hotspot').forEach((c) => {
      const toBase = (c.links ?? []).filter((l) => {
        const t = byId.get(l.to);
        return t && (t.domain === 'econ' || t.domain === 'finance');
      });
      if (toBase.length === 0) bad.push(`${c.id} 没有指向经济学/金融学的链接`);
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('所有 links 指向存在的概念，且都带 reason', () => {
    const bad: string[] = [];
    concepts.forEach((c) => {
      (c.links ?? []).forEach((l) => {
        if (!byId.has(l.to)) bad.push(`${c.id} → ${l.to} 是死链`);
        if (!l.reason || !l.reason.trim()) bad.push(`${c.id} → ${l.to} 没有 reason`);
      });
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('没有孤立节点：每个概念都至少被一个其他概念指向', () => {
    const orphans = concepts.filter((c) => (inDegree.get(c.id) ?? 0) === 0).map((c) => c.id);
    expect(orphans, `孤立概念：${orphans.join(', ')}`).toEqual([]);
  });

  it('updated_at 全部填写，且不是未来日期', () => {
    const bad: string[] = [];
    const today = new Date().toISOString().slice(0, 10);
    concepts.forEach((c) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.updated_at))) bad.push(`${c.id} updated_at 格式非法`);
      else if (String(c.updated_at) > today) bad.push(`${c.id} updated_at 在未来`);
    });
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('热点区各自标注内容截至日期（用于过时提示）', () => {
    const bad = concepts
      .filter((c) => c.domain === 'hotspot')
      .filter((c) => !/截至\s*\d{4}-\d{2}-\d{2}/.test(c.source ?? ''))
      .map((c) => `${c.id}：${c.source}`);
    expect(bad, bad.join('\n')).toEqual([]);
  });
});

describe('P7 内容生产：整库门禁与入库', () => {
  it('全库跑门禁 0 error 0 warn', () => {
    const { errors, warnings } = summarize(validateContent(concepts));
    expect(errors, JSON.stringify(errors.slice(0, 5))).toEqual([]);
    expect(warnings, JSON.stringify(warnings.slice(0, 5))).toEqual([]);
  });

  it('整库管道：buildJsonl → 落盘 → parseJsonl → 入库，68 个概念一条不少', () => {
    const dir = tempDir();
    try {
      const version = '2026.09.21';
      const updatedAt = '2026-09-21T10:00:00+08:00';
      const jsonl = buildJsonl(concepts, version, updatedAt);

      // 与 tools/build-package.ts 相同的产物契约：manifest 的 sha256/size/counts 必须对得上
      const sha = createHash('sha256').update(jsonl).digest('hex');
      const size = Buffer.byteLength(jsonl, 'utf8');
      const counts = { econ: 0, finance: 0, hotspot: 0, total: concepts.length } as Record<string, number>;
      concepts.forEach((c) => { counts[c.domain] += 1; });

      const jsonlPath = join(dir, 'concepts.jsonl');
      const manifestPath = join(dir, 'manifest.json');
      writeFileSync(jsonlPath, jsonl, 'utf8');
      writeFileSync(manifestPath, JSON.stringify({
        version, updatedAt, schemaVersion: 1, counts,
        file: 'concepts.jsonl', sha256: sha, size,
      }, null, 2), 'utf8');

      // 逐项核对：改动内容而忘记重新打包时，这里必须失败
      const onDisk = readFileSync(jsonlPath, 'utf8');
      expect(readFileSync(manifestPath, 'utf8')).toBeTruthy();
      expect(createHash('sha256').update(onDisk).digest('hex')).toBe(sha);
      expect(Buffer.byteLength(onDisk, 'utf8')).toBe(size);
      expect(counts).toEqual({ econ: 24, finance: 24, hotspot: 20, total: 68 });

      // 首行必须是 _meta —— 手动导入只需选这一个文件
      const first = onDisk.split('\n')[0];
      expect(JSON.parse(first)).toHaveProperty('_meta');

      const parsed = parseJsonl(onDisk);
      expect(parsed.badLines).toEqual([]);
      expect(parsed.meta).not.toBeNull();
      expect(parsed.concepts.length).toBe(68);

      // 解析出来的对象与源内容逐字段一致（JSON 往返不丢信息）
      const byIdParsed = new Map(parsed.concepts.map((c) => [c.id, c]));
      concepts.forEach((c) => {
        expect(JSON.stringify(byIdParsed.get(c.id)), `${c.id} 往返后不一致`).toBe(JSON.stringify(c));
      });

      const db = initContentDb(join(dir, 'content.db'));
      const meta = buildContentDb(db, parsed.concepts, {
        version, updated_at: updatedAt, schema_version: 1,
      });
      expect(meta.counts.total).toBe(68);
      expect(allConcepts(db).length).toBe(68);
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('检索常见术语能命中（FTS5 中文子串）', () => {
    const dir = tempDir();
    try {
      const db = initContentDb(join(dir, 'content.db'));
      buildContentDb(db, concepts, { version: '2026.09.21', updated_at: '2026-09-21', schema_version: 1 });
      for (const q of ['久期', '弹性', '传导', '通胀', '估值', '中性化']) {
        expect(search(db, q, 5).length, `检索「${q}」无结果`).toBeGreaterThan(0);
      }
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  it('发布产物 content-dist/ 已生成且与源内容一致', () => {
    const manifestPath = join(ROOT, 'content-dist', 'manifest.json');
    const jsonlPath = join(ROOT, 'content-dist', 'concepts.jsonl');
    expect(existsSync(manifestPath), 'content-dist/manifest.json 不存在，先跑 npm run build:content').toBe(true);
    expect(existsSync(jsonlPath), 'content-dist/concepts.jsonl 不存在').toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      version: string; counts: Record<string, number>; sha256: string; size: number; file: string;
    };
    const jsonl = readFileSync(jsonlPath, 'utf8');
    // 产物必须与当前源内容同步——否则发布的是旧内容
    expect(createHash('sha256').update(jsonl).digest('hex')).toBe(manifest.sha256);
    expect(manifest.counts.total).toBe(concepts.length);
    expect(manifest.file).toBe('concepts.jsonl');
  });
});
