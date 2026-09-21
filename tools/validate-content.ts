#!/usr/bin/env tsx
/**
 * 内容质量门禁 CLI（PRD §5.3）
 *
 * 用法：npm run gate
 * 退出码非 0 表示有 error，CI / 发布脚本据此拦截。
 * warning 只提示、不拦截（例如孤立节点、难度分布）。
 */
import { join } from 'node:path';
import { loadContent } from '../app/content/load';
import { summarize, validateContent } from '../src/shared/validate';
import { DOMAIN_LABEL } from '../src/shared/types';

const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'content');

function main(): number {
  const { concepts, sources, parseErrors } = loadContent(CONTENT_DIR);

  if (parseErrors.length > 0) {
    console.error(`\n✗ YAML 解析失败（${parseErrors.length} 个文件）`);
    for (const e of parseErrors) console.error(`  ${e.file}: ${e.message}`);
    return 1;
  }

  if (concepts.length === 0) {
    console.error(`\n✗ ${CONTENT_DIR} 下没有找到任何概念`);
    return 1;
  }

  const issues = validateContent(concepts);
  const { errors, warnings } = summarize(issues);

  // 按概念分组输出，便于一次改完
  const byId = new Map<string, typeof issues>();
  for (const i of issues) {
    const key = i.id ?? '(全库)';
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key)!.push(i);
  }

  console.log(`\n内容门禁：${concepts.length} 个概念，来自 ${sources.length} 个文件\n`);

  const counts = { econ: 0, finance: 0, hotspot: 0 } as Record<string, number>;
  const tracks = new Map<string, number>();
  for (const c of concepts) {
    counts[c.domain] = (counts[c.domain] ?? 0) + 1;
    tracks.set(c.track, (tracks.get(c.track) ?? 0) + 1);
  }
  for (const [d, label] of Object.entries(DOMAIN_LABEL)) {
    console.log(`  ${label}：${counts[d] ?? 0} 个`);
  }
  console.log('');
  for (const [t, n] of [...tracks.entries()].sort()) console.log(`    ${t.padEnd(14)} ${n}`);
  console.log('');

  if (errors.length > 0) {
    console.error(`✗ ${errors.length} 项错误：\n`);
    for (const [id, list] of byId) {
      const errs = list.filter((i) => i.level === 'error');
      if (errs.length === 0) continue;
      console.error(`  ${id}`);
      for (const e of errs) console.error(`    [${e.code}] ${e.message}`);
    }
    console.error('');
  }

  if (warnings.length > 0) {
    console.warn(`△ ${warnings.length} 项提醒：\n`);
    for (const [id, list] of byId) {
      const warns = list.filter((i) => i.level === 'warn');
      if (warns.length === 0) continue;
      console.warn(`  ${id}`);
      for (const w of warns) console.warn(`    [${w.code}] ${w.message}`);
    }
    console.warn('');
  }

  if (errors.length === 0) {
    console.log(`✓ 门禁通过（0 error${warnings.length ? `，${warnings.length} warn` : ''}）\n`);
    return 0;
  }
  console.error(`✗ 门禁未通过：${errors.length} 个 error\n`);
  return 1;
}

process.exit(main());
