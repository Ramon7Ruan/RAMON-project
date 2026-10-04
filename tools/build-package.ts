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
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadContent } from '../app/content/load';
import { buildJsonl } from '../app/services';
import { checkContentVersion, contentTagForVersion } from '../src/shared/repo';
import { summarize, validateContent } from '../src/shared/validate';

const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'content');
const OUT_DIR = join(ROOT, 'content-dist');
const MANIFEST = join(OUT_DIR, 'manifest.json');

function todayVersion(): string {
  const d = new Date();
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 该版本号是否**已对外发布过**。
 *
 * 判据是 **tag 是否存在**，而不是本地 manifest 是什么版本 —— tag 才唯一标识一次发布
 * （publish.sh 打 `content-v<版本>`，App 下载正文也走这个 tag）。
 *
 * 用本地文件当替身会误拦一个很正常的流程：先 `build:content` 本地看一眼、
 * 确认后再 `publish:content`。两次都是当天版本号，于是 publish 被自己拦下 ——
 * 而那时**什么都还没发布**。这个缺陷真实发生过（2026-10-04）。
 *
 * 只查**本地** git，不走网络：单机项目里 publish.sh 会推送它自己创建的 tag，
 * 因此本地 tag 集合足以判断。查不到（非 git 仓库 / 未初始化）时按"未发布"处理。
 */
function tagExists(tag: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** 本地已有构建的版本号（`content-dist/manifest.json`）；读不到返回 null。 */
function localContentVersion(): string | null {
  if (!existsSync(MANIFEST)) return null;
  try {
    const prev = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { version?: string };
    return prev.version ?? null;
  } catch {
    return null; // 旧文件损坏则忽略
  }
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

  // 版本号守卫（架构 §4.8）。**判定逻辑在 `src/shared/repo.ts` 的 `checkContentVersion`**——
  // 那是个纯函数、有测试覆盖；这里只负责把"环境事实"喂进去。
  // 之所以要分开：这个判据曾写错（用本地文件当"已发布"的替身），
  // 而那种错误不会让任何测试变红，只会让一个正常流程某天突然走不通。
  const verdict = checkContentVersion({
    version,
    tagExists: tagExists(contentTagForVersion(version)),
    localVersion: localContentVersion(),
  });
  if (!verdict.ok) {
    console.error(`✗ ${verdict.reason}`);
    return 1;
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
