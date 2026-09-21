import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Concept } from '../../src/shared/types';

export interface LoadResult {
  concepts: Concept[];
  /** 每个源文件到概念的映射，便于报错时指出是哪个文件 */
  sources: { file: string; ids: string[] }[];
  parseErrors: { file: string; message: string }[];
}

/**
 * 读取 `content/**\/*.yaml`。
 *
 * 一个文件可以放一个概念（数组形式）——两种写法都支持，避免内容组织方式被工具限制。
 * 解析失败不抛异常，而是收集到 parseErrors，让门禁一次性把所有问题报出来。
 */
export function loadContent(root: string): LoadResult {
  const files: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.yaml') || name.endsWith('.yml')) files.push(p);
    }
  };
  walk(root);
  files.sort();

  const concepts: Concept[] = [];
  const sources: LoadResult['sources'] = [];
  const parseErrors: LoadResult['parseErrors'] = [];

  for (const file of files) {
    const rel = relative(process.cwd(), file) || file;
    let data: unknown;
    try {
      data = parseYaml(readFileSync(file, 'utf8'));
    } catch (e) {
      parseErrors.push({ file: rel, message: (e as Error).message });
      continue;
    }
    const items = Array.isArray(data) ? data : [data];
    const ids: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object') {
        parseErrors.push({ file: rel, message: '文件内容不是对象也不是对象数组' });
        continue;
      }
      const c = item as Concept;
      concepts.push(c);
      if (typeof c.id === 'string') ids.push(c.id);
    }
    sources.push({ file: rel, ids });
  }

  // 单文件内的顺序即展示顺序，这里统一按 order 字段排（缺失则保持文件顺序）
  concepts.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return { concepts, sources, parseErrors };
}

export function listContentFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.yaml') || name.endsWith('.yml')) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}
