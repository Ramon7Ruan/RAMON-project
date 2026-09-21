#!/usr/bin/env tsx
/**
 * 内容打包（架构 §4.2、§4.4）
 *
 * YAML → content-dist/ 两个裸文件：
 *   manifest.json   ~1KB 版本头，检查更新时只拉它
 *   concepts.jsonl  正文，首行是 _meta
 *
 * 不用 zip：GitHub Release 附件走 objects.githubusercontent.com，大陆长期不稳，
 * jsDelivr 也代理不了；裸文件才能走 CDN。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadContent } from '../app/content/load';
import { buildJsonl } from '../app/services';
import { summarize, validateContent } from '../src/shared/validate';

const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'content');
const OUT_DIR = join(ROOT, 'content-dist');
const MANIFEST = join(OUT_DIR, 'manifest.json');

function todayVersion(): string {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function main(): number {
  const { concepts, parseErrors } = loadContent(CONTENT_DIR);
  if (parseErrors.length) {
    console.error('✗ YAML 解析失败：');
    parseErrors.forEach((e) => console.error(`  ${e.file}: ${e.message}`));
    return 1;
  }
  if (!concepts.length) {
    console.error('✗ content/ 下没有概念');
    return 1;
  }

  const { errors } = summarize(validateContent(concepts));
  if (errors.length) {
    console.error(`✗ 未通过门禁（${errors.length} 项），先跑 npm run gate 修好再来打包`);
    return 1;
  }

  const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const version = arg ?? todayVersion();
  const updatedAt = new Date().toISOString();

  // 版本号必须单调递增（架构 §4.8）
  if (existsSync(MANIFEST)) {
    try {
      const prev = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version?: string };
      if (prev.version && version <= prev.version) {
        console.error(`✗ 版本号必须递增：当前 ${version} 不大于已发布的 ${prev.version}`);
        return 1;
      }
    } catch { /* 旧文件损坏则忽略 */ }
  }

  const jsonl = buildJsonl(concepts, version, updatedAt);
  const sha = createHash('sha256').update(jsonl).digest('hex');
  const size = Buffer.byteLength(jsonl, 'utf8');

  const counts = { econ: 0, finance: 0, hotspot: 0, total: concepts.length } as
    Record<'econ' | 'finance' | 'hotspot' | 'total', number>;
  for (const c of concepts) counts[c.domain] += 1;

  const manifest = {
    version, updatedAt, schemaVersion: 1, counts,
    file: 'concepts.jsonl', sha256: sha, size,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'concepts.jsonl'), jsonl, 'utf8');
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  console.log(`✓ 已生成 content-dist/`);
  console.log(`  版本     ${version}`);
  console.log(`  概念数   ${concepts.length}（经济 ${counts.econ} / 金融 ${counts.finance} / 热点 ${counts.hotspot}）`);
  console.log(`  大小     ${(size / 1024).toFixed(1)} KB`);
  console.log(`  sha256   ${sha.slice(0, 16)}…`);
  console.log(`\n下一步：git add content-dist && git commit && git push，然后打 tag content-v${version}`);
  return 0;
}

process.exit(main());
