import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Concept, ContentMeta, Domain, UpdateInfo } from '../../src/shared/types';
import { validateContent, summarize } from '../../src/shared/validate';

/** 只依赖这几个方法，便于测试注入假实现 */
export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{
  ok: boolean; status: number; text(): Promise<string>;
}>;

export type CheckResult =
  | { kind: 'skipped'; reason: 'not-configured' | 'no-network' | 'timeout' | 'bad-manifest' | 'up-to-date' }
  | { kind: 'update'; info: UpdateInfo };

export interface UpdaterPaths {
  contentDb: string;
  userDb: string;
  cacheDir: string;
  backupsDir: string;
}

export interface UpdaterDeps {
  fetch: Fetcher;
  paths: UpdaterPaths;
  /** 替换内容库前先断开连接，替换后重新打开；由调用方提供 */
  closeContentDb: () => void;
  openContentDb: (path: string) => void;
  now?: () => Date;
}

export const BACKUP_KEEP = 5;

/** 比较内容版本号：只做"是否不同 / 是否更新"，不做语义化版本推理（架构 §4.8） */
export function compareVersion(a: string, b: string): number {
  const norm = (s: string) => s.trim().replace(/^v/, '');
  const x = norm(a), y = norm(b);
  if (x === y) return 0;
  return x > y ? 1 : -1;
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function parseManifest(text: string): ContentMeta & { file: string; sha256: string; size: number } | null {
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { return null; }
  // 清单来自网络：可能是 null、数组、字符串 —— 一律当作非法，不能直接取属性
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const m = obj as Record<string, unknown>;
  if (typeof m.version !== 'string' || !m.version) return null;
  if (typeof m.updatedAt !== 'string') return null;
  if (typeof m.sha256 !== 'string' || m.sha256.length !== 64) return null;
  if (typeof m.file !== 'string' || !m.file) return null;
  const counts = m.counts as Record<string, number> | undefined;
  return {
    version: m.version,
    updated_at: m.updatedAt,
    schema_version: typeof m.schemaVersion === 'number' ? m.schemaVersion : 1,
    counts: {
      econ: counts?.econ ?? 0,
      finance: counts?.finance ?? 0,
      hotspot: counts?.hotspot ?? 0,
      total: counts?.total ?? 0,
    },
    file: m.file,
    sha256: m.sha256,
    size: typeof m.size === 'number' ? m.size : 0,
  };
}

/** 解析 concepts.jsonl：首行 _meta，其后每行一个 concept（架构 §4.2） */
export function parseJsonl(text: string): { meta: Record<string, unknown> | null; concepts: Concept[]; badLines: number[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let meta: Record<string, unknown> | null = null;
  const concepts: Concept[] = [];
  const badLines: number[] = [];
  lines.forEach((line, i) => {
    let obj: unknown;
    try { obj = JSON.parse(line); } catch { badLines.push(i + 1); return; }
    if (i === 0 && obj && typeof obj === 'object' && '_meta' in (obj as object)) {
      meta = (obj as { _meta: Record<string, unknown> })._meta;
      return;
    }
    if (obj && typeof obj === 'object' && typeof (obj as Concept).id === 'string') {
      concepts.push(obj as Concept);
    } else {
      badLines.push(i + 1);
    }
  });
  return { meta, concepts, badLines };
}

export class Updater {
  constructor(private deps: UpdaterDeps) {}

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  /**
   * 检查更新。离线优先：任何失败都返回 skipped，绝不抛异常、绝不阻塞 UI。
   * 失败矩阵见架构 §4.6。
   */
  async check(manifestUrl: string, localVersion: string, timeoutMs = 5000): Promise<CheckResult> {
    if (!manifestUrl || !manifestUrl.trim()) return { kind: 'skipped', reason: 'not-configured' };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let text: string;
    try {
      const res = await this.deps.fetch(manifestUrl, { signal: ac.signal });
      if (!res.ok) return { kind: 'skipped', reason: 'bad-manifest' };
      text = await res.text();
    } catch (e) {
      const aborted = (e as { name?: string })?.name === 'AbortError';
      return { kind: 'skipped', reason: aborted ? 'timeout' : 'no-network' };
    } finally {
      clearTimeout(timer);
    }

    const m = parseManifest(text);
    if (!m) return { kind: 'skipped', reason: 'bad-manifest' };

    // 版本不比本地新（含 CDN 返回旧缓存的情况）→ 视为无更新
    if (compareVersion(m.version, localVersion) <= 0) return { kind: 'skipped', reason: 'up-to-date' };

    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    return {
      kind: 'update',
      info: {
        version: m.version,
        updated_at: m.updated_at,
        counts: m.counts,
        diff: [],
        fileUrl: `${base}${m.file}`,
        sha256: m.sha256,
        size: m.size,
      },
    };
  }

  /** 下载并校验正文。校验不过 → 抛错，调用方保留旧库 */
  async downloadAndVerify(fileUrl: string, sha256Expected: string, sizeExpected: number, timeoutMs = 20000): Promise<string> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let text: string;
    try {
      const res = await this.deps.fetch(fileUrl, { signal: ac.signal });
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    const actualSize = Buffer.byteLength(text, 'utf8');
    if (sizeExpected > 0 && actualSize !== sizeExpected) {
      throw new Error(`内容校验失败：大小不符（期望 ${sizeExpected}，实际 ${actualSize}）`);
    }
    const actual = sha256(text);
    if (actual !== sha256Expected) {
      throw new Error('内容校验失败：sha256 不匹配');
    }
    return text;
  }

  /** 替换内容库前自动备份 user.db；失败则中止更新（PRD §6.4） */
  backupUserDb(): string {
    const { userDb, backupsDir } = this.deps.paths;
    if (!existsSync(userDb)) throw new Error('备份失败：user.db 不存在');
    if (!existsSync(backupsDir)) mkdirSync(backupsDir, { recursive: true });
    const d = this.now();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
    const target = join(backupsDir, `user-${stamp}.db`);
    copyFileSync(userDb, target);
    if (!existsSync(target)) throw new Error('备份失败：写入后文件不存在');
    this.pruneBackups();
    return target;
  }

  listBackups(): string[] {
    const { backupsDir } = this.deps.paths;
    if (!existsSync(backupsDir)) return [];
    return readdirSync(backupsDir).filter((f) => f.startsWith('user-') && f.endsWith('.db')).sort();
  }

  private pruneBackups(): void {
    const files = this.listBackups();
    while (files.length > BACKUP_KEEP) {
      const oldest = files.shift()!;
      rmSync(join(this.deps.paths.backupsDir, oldest), { force: true });
    }
  }

  /**
   * 完整的内容更新事务：
   * 备份 → 下载 → 校验 → 解析 → 门禁 → 建新库 → 原子替换
   * 任一步失败都保证 content.db 完好、user.db 未被改动。
   */
  async applyUpdate(
    fileUrl: string,
    sha256Expected: string,
    sizeExpected: number,
    version: string,
    updatedAt: string,
    buildNewDb: (targetPath: string, concepts: Concept[], meta: { version: string; updated_at: string; schema_version: number }) => void,
  ): Promise<{ ok: true; version: string; backup: string } | { ok: false; reason: string }> {
    const { contentDb, cacheDir } = this.deps.paths;
    const pendingDir = join(cacheDir, 'pending');
    const tmpNew = `${contentDb}.new`;
    const tmpOld = `${contentDb}.old`;

    let backup: string;
    try {
      backup = this.backupUserDb();
    } catch (e) {
      return { ok: false, reason: `备份失败，已中止更新：${(e as Error).message}` };
    }

    try {
      const text = await this.downloadAndVerify(fileUrl, sha256Expected, sizeExpected);
      if (!existsSync(pendingDir)) mkdirSync(pendingDir, { recursive: true });
      writeFileSync(join(pendingDir, 'concepts.jsonl'), text, 'utf8');

      const { concepts, badLines } = parseJsonl(text);
      if (badLines.length > 0) {
        return { ok: false, reason: `内容解析失败：第 ${badLines.slice(0, 5).join('、')} 行不是合法 JSON` };
      }
      if (concepts.length === 0) return { ok: false, reason: '内容解析失败：没有任何概念' };

      const issues = summarize(validateContent(concepts));
      if (issues.errors.length > 0) {
        return { ok: false, reason: `内容未通过校验（${issues.errors.length} 项）：${issues.errors[0].message}` };
      }

      rmSync(tmpNew, { force: true });
      buildNewDb(tmpNew, concepts, { version, updated_at: updatedAt, schema_version: 1 });

      // 原子替换：先断开连接，再 rename
      this.deps.closeContentDb();
      rmSync(tmpOld, { force: true });
      renameSync(contentDb, tmpOld);
      try {
        renameSync(tmpNew, contentDb);
      } catch (e) {
        renameSync(tmpOld, contentDb); // 回滚
        this.deps.openContentDb(contentDb);
        return { ok: false, reason: `替换失败已回滚：${(e as Error).message}` };
      }
      rmSync(tmpOld, { force: true });
      this.deps.openContentDb(contentDb);
      return { ok: true, version, backup };
    } catch (e) {
      try { this.deps.openContentDb(contentDb); } catch { /* 已打开则忽略 */ }
      return { ok: false, reason: (e as Error).message };
    }
  }
}

export function domainDiff(oldCounts: ContentMeta['counts'], nextCounts: ContentMeta['counts']) {
  return (['econ', 'finance', 'hotspot'] as Domain[]).map((d) => ({
    domain: d,
    added: Math.max(0, nextCounts[d] - oldCounts[d]),
    changed: 0,
  }));
}
