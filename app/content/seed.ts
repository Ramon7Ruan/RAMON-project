/**
 * 首启内容内置（PRD §4.5 / A2 / A8）
 *
 * 问题：联网通道是可选的，且内容库随包发布时是空的。
 * 若首次启动不导入任何内容，用户在无网环境下打开会看到一个空壳 App。
 *
 * 方案：把发布产物里的 `content-dist/concepts.jsonl` 一起打进包，
 * 首启发现内容库为空就从本地导入 —— 走**与手动导入完全相同**的校验管道
 * （逐行 schema 校验 + 内容门禁），因此内置内容做不到「绕过校验」。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Services } from '../services';

/**
 * 按优先级列出内置内容可能的位置。三种运行形态各对应一条：
 *   - 打包后：Resources/content-dist/concepts.jsonl（extraResources）
 *   - 本地 `electron .`：项目根的 content-dist/
 *   - 编译产物 dist-electron/app/ 往下两级也是项目根
 */
export function seedCandidates(opts: {
  resourcesPath?: string;
  appPath?: string;
  moduleDir?: string;
} = {}): string[] {
  const out: string[] = [];
  if (opts.resourcesPath) out.push(join(opts.resourcesPath, 'content-dist', 'concepts.jsonl'));
  if (opts.appPath) out.push(join(opts.appPath, 'content-dist', 'concepts.jsonl'));
  if (opts.moduleDir) out.push(join(opts.moduleDir, '..', '..', 'content-dist', 'concepts.jsonl'));
  // join 会归一化路径，本地运行时 appPath 与 moduleDir 两条常常是同一个位置，去重避免重复探测
  return [...new Set(out)];
}

export interface SeedResult {
  imported: boolean;
  reason?: string;
  version?: string;
  count?: number;
  path?: string;
}

/**
 * 内容库为空时导入内置内容。**只在为空时执行**——绝不用内置内容覆盖
 * 用户已经更新过（或自己导入过）的内容库。
 */
export function ensureSeedContent(svc: Services, candidates: string[]): SeedResult {
  const meta = svc.meta();
  if (Number(meta.counts?.total ?? 0) > 0) {
    return { imported: false, reason: '内容库非空，跳过内置导入' };
  }

  const seed = candidates.find((p) => existsSync(p));
  if (!seed) return { imported: false, reason: '未找到内置内容文件' };

  let text: string;
  try {
    text = readFileSync(seed, 'utf8');
  } catch (e) {
    return { imported: false, reason: `读取内置内容失败：${(e as Error).message}` };
  }

  const r = svc.importContentText(text, { filename: seed });
  if (!r.ok) {
    // 内置内容有问题也不该拦住启动：应用照常可用，只是内容为空
    return { imported: false, reason: r.reason, path: seed };
  }
  return { imported: true, version: r.version, count: r.count, path: seed };
}
