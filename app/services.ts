import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import type { Concept, ConceptState, ConceptStatus, Rating, SearchHit } from '../src/shared/types';
import { review as runReview, defaultState, isDue, isoDay } from '../src/shared/scheduler';
import { validateContent, summarize, type ValidationIssue } from '../src/shared/validate';
import { buildContentDb, countsOf, allConcepts, getConcept, listSummaries, listTracks, readMeta, search, type ConceptSummary } from './db/content';
import { initContentDb, initUserDb, removeDbFiles, type Db } from './db/index';
import { UserRepo, type ExportPayload, type ImportPreview } from './db/user';
import { Updater, domainDiff, parseJsonl, type CheckResult, type Fetcher } from './update/updater';

export interface ServicePaths {
  root: string;
  contentDb: string;
  userDb: string;
  cacheDir: string;
  backupsDir: string;
}

export function makePaths(root: string): ServicePaths {
  return {
    root,
    contentDb: join(root, 'content.db'),
    userDb: join(root, 'user.db'),
    cacheDir: join(root, 'cache'),
    backupsDir: join(root, 'backups'),
  };
}

export interface SettingsView {
  theme: string;
  autoCheckUpdate: boolean;
  manifestUrl: string;
  lastCheck: string;
  lastExport: string;
}

export const SETTING_KEYS = {
  theme: 'theme',
  autoCheckUpdate: 'auto_check_update',
  manifestUrl: 'content_manifest_url',
  lastCheck: 'last_check_at',
  lastExport: 'last_export_at',
} as const;

/**
 * 应用服务层 —— **不依赖 Electron**。
 * 主进程只是把它挂到 ipcMain 上；测试直接 new 一个就能跑完整逻辑。
 * 这是"数据与备份"相关测试可以脱离 GUI 运行的关键。
 */
/**
 * 校验来自 IPC 的文件路径。
 *
 * 为什么必须校验：渲染层传进来的路径是**不可信输入**（内容来自网络）。
 * 之前用 `String(payload.path)` 直接强转，`{ path: 42 }` 会变成相对路径 "42"，
 * 于是文件被写到**进程当前目录**——既是越界写入，也违反 PRD §6.1
 * 「只写数据目录，不碰用户其他目录」。
 *
 * 真实流程里路径一律来自原生文件对话框，必然是绝对路径；
 * 所以拒绝非绝对路径不会误伤正常用法。
 */
function resolvePathArg(value: unknown): { ok: true; path: string } | { ok: false; reason: string } {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reason: '未提供文件路径' };
  }
  if (!isAbsolute(value)) {
    return { ok: false, reason: `文件路径必须是绝对路径：${value}` };
  }
  return { ok: true, path: value };
}

export class Services {
  readonly paths: ServicePaths;
  readonly user: UserRepo;
  readonly updater: Updater;
  private contentDb!: Db;
  private appVersion: string;
  /** 内置的内容仓库地址：用户没在设置里填过就用它（架构 §4.3） */
  private defaultManifestUrl: string;

  constructor(opts: {
    root: string;
    appVersion?: string;
    fetchImpl: Fetcher;
    now?: () => Date;
    defaultManifestUrl?: string;
  }) {
    this.paths = makePaths(opts.root);
    this.appVersion = opts.appVersion ?? '1.0.0';
    this.defaultManifestUrl = opts.defaultManifestUrl ?? '';
    mkdirSync(this.paths.root, { recursive: true });
    mkdirSync(this.paths.cacheDir, { recursive: true });
    mkdirSync(this.paths.backupsDir, { recursive: true });

    this.contentDb = initContentDb(this.paths.contentDb);
    this.user = new UserRepo(initUserDb(this.paths.userDb));
    this.updater = new Updater({
      fetch: opts.fetchImpl,
      paths: this.paths,
      now: opts.now,
      closeContentDb: () => { try { this.contentDb.close(); } catch { /* 已关闭 */ } },
      openContentDb: (p) => { this.contentDb = initContentDb(p); },
    });
  }

  close(): void {
    try { this.contentDb.close(); } catch { /* ignore */ }
  }

  // ---------------- 内容读取 ----------------
  meta() { return readMeta(this.contentDb); }
  tracks() { return listTracks(this.contentDb); }
  summaries(): ConceptSummary[] { return listSummaries(this.contentDb); }
  concept(id: string): Concept | null { return getConcept(this.contentDb, id); }
  searchHits(q: string, limit = 40): SearchHit[] {
    const states = this.user.getAllStates();
    return search(this.contentDb, q, limit).map((h) => ({
      ...h,
      status: (states[h.id]?.status ?? 'unread') as ConceptStatus,
    }));
  }
  private titles(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of listSummaries(this.contentDb)) out[s.id] = s.title;
    return out;
  }

  // ---------------- 进度 ----------------
  states(): Record<string, ConceptState> { return this.user.getAllStates(); }

  stateOf(id: string): ConceptState {
    const c = getConcept(this.contentDb, id);
    return c ? this.user.getState(id) : this.user.getState(id);
  }

  setStatus(id: string, status: ConceptStatus): ConceptState {
    return this.user.setStatus(id, status);
  }

  /** 打开概念页：未读 → 在读（PRD §3.5 唯一一处系统自动改状态） */
  markRead(id: string): ConceptState {
    const cur = this.user.getState(id);
    if (cur.status === 'unread') return this.user.setStatus(id, 'reading');
    return cur;
  }

  toggleFavorite(id: string): boolean { return this.user.toggleFavorite(id); }
  favorites(): string[] { return this.user.getFavorites(); }

  /** 复习评分：算法是纯函数，这里只负责取旧状态、算、落库 */
  rate(id: string, rating: Rating, now = new Date()): ConceptState {
    const prev = this.user.getState(id);
    const out = runReview({
      prev: { ease: prev.ease, interval_days: prev.interval_days, reps: prev.reps, lapses: prev.lapses },
      rating,
      now,
    });
    return this.user.applyReview(id, out, rating);
  }

  /**
   * 今日复习队列（PRD §4.3）：
   *   - due_at <= 今天的全部入队（不论 status，见 scheduler.isDue 的语义说明）
   *   - 「不懂」的排最前
   * due_at 为空 = 从未安排过，或是被"我掌握了"主动清空 → 不入队
   */
  dueQueue(now = new Date()): string[] {
    const states = this.user.getAllStates();
    const ids = listSummaries(this.contentDb).map((c) => c.id);
    const stateOf = (id: string) => states[id] ?? defaultState(id);
    const candidates = ids.filter((id) => isDue(stateOf(id), now));
    const front = candidates.filter((id) => stateOf(id).status === 'fuzzy');
    const rest = candidates
      .filter((id) => stateOf(id).status !== 'fuzzy')
      .sort((a, b) => (stateOf(a).due_at ?? '').localeCompare(stateOf(b).due_at ?? ''));
    return [...front, ...rest];
  }

  // ---------------- 设置 ----------------
  settings(): SettingsView {
    return {
      theme: this.user.getSetting(SETTING_KEYS.theme, 'system'),
      autoCheckUpdate: this.user.getSetting(SETTING_KEYS.autoCheckUpdate, '1') === '1',
      // 用户没填过就回落到内置地址：这样装完即带可用的更新通道，不必手工敲 URL
      manifestUrl: this.user.getSetting(SETTING_KEYS.manifestUrl, this.defaultManifestUrl),
      lastCheck: this.user.getSetting(SETTING_KEYS.lastCheck, ''),
      lastExport: this.user.getSetting(SETTING_KEYS.lastExport, ''),
    };
  }

  updateSettings(patch: Partial<SettingsView>): SettingsView {
    if (patch.theme !== undefined) this.user.setSetting(SETTING_KEYS.theme, patch.theme);
    if (patch.autoCheckUpdate !== undefined) {
      this.user.setSetting(SETTING_KEYS.autoCheckUpdate, patch.autoCheckUpdate ? '1' : '0');
    }
    if (patch.manifestUrl !== undefined) this.user.setSetting(SETTING_KEYS.manifestUrl, patch.manifestUrl);
    if (patch.lastExport !== undefined) this.user.setSetting(SETTING_KEYS.lastExport, patch.lastExport);
    return this.settings();
  }

  // ---------------- 更新 ----------------
  async checkUpdate(now = new Date()): Promise<CheckResult> {
    const s = this.settings();
    const res = await this.updater.check(s.manifestUrl, this.meta().version);
    if (res.kind === 'update') {
      res.info.diff = domainDiff(this.meta().counts, res.info.counts);
    }
    this.user.setSetting(SETTING_KEYS.lastCheck, now.toISOString());
    return res;
  }

  async applyUpdate(info: { fileUrl: string; sha256: string; size: number; version: string; updated_at: string }) {
    const r = await this.updater.applyUpdate(
      info.fileUrl, info.sha256, info.size, info.version, info.updated_at,
      (target, concepts, meta) => {
        const db = initContentDb(target);
        try { buildContentDb(db, concepts, meta); } finally { db.close(); }
      },
    );
    if (r.ok) this.user.setSetting('content_version', r.version);
    return r;
  }

  // ---------------- 手动导入内容 ----------------
  /** 手动导入走与联网更新**完全相同**的校验与替换流程（架构 §4.7） */
  importContentText(text: string, opts: { filename?: string } = {}): {
    ok: true; version: string; count: number; backup: string;
  } | { ok: false; reason: string; issues?: ValidationIssue[] } {
    const { meta, concepts, badLines } = parseJsonl(text);
    if (badLines.length > 0) {
      return { ok: false, reason: `第 ${badLines.slice(0, 5).join('、')} 行不是合法 JSON` };
    }
    if (concepts.length === 0) return { ok: false, reason: '文件里没有任何概念' };

    const issues = validateContent(concepts);
    const { errors } = summarize(issues);
    if (errors.length > 0) {
      return { ok: false, reason: `未通过内容校验（${errors.length} 项）`, issues: errors.slice(0, 20) };
    }

    let backup: string;
    try {
      backup = this.updater.backupUserDb();
    } catch (e) {
      return { ok: false, reason: `备份失败，已中止导入：${(e as Error).message}` };
    }

    const version = typeof meta?.version === 'string' && meta.version ? meta.version : this.todayVersion();
    const updatedAt = typeof meta?.updatedAt === 'string' && meta.updatedAt ? meta.updatedAt : new Date().toISOString();

    const tmpNew = `${this.paths.contentDb}.new`;
    removeDbFiles(tmpNew);
    const db = initContentDb(tmpNew);
    try {
      buildContentDb(db, concepts, { version, updated_at: updatedAt, schema_version: 1 });
    } finally {
      db.close();
    }

    // 替换
    this.close();
    const tmpOld = `${this.paths.contentDb}.old`;
    removeDbFiles(tmpOld);
    renameSync(this.paths.contentDb, tmpOld);
    try {
      renameSync(tmpNew, this.paths.contentDb);
    } catch (e) {
      renameSync(tmpOld, this.paths.contentDb);
      return { ok: false, reason: `替换失败已回滚：${(e as Error).message}` };
    }
    rmSync(tmpOld, { force: true });
    // 重新打开
    (this as unknown as { contentDb: Db }).contentDb = initContentDb(this.paths.contentDb);
    this.user.setSetting('content_version', version);
    return { ok: true, version, count: concepts.length, backup };
  }

  importContentFile(path: string) {
    if (!existsSync(path)) return { ok: false as const, reason: `文件不存在：${path}` };
    const text = readFileSync(path, 'utf8');
    return this.importContentText(text, { filename: path });
  }

  /** 把当前内容库导出成 concepts.jsonl（便于本地自测或手工分发） */
  buildDistFiles(): { manifestPath: string; jsonlPath: string; count: number; version: string } {
    const concepts = allConcepts(this.contentDb);
    const meta = readMeta(this.contentDb);
    const jsonl = buildJsonl(concepts, meta.version, meta.updated_at);
    const outDir = join(this.paths.root, '..', 'content-dist-export');
    mkdirSync(outDir, { recursive: true });
    const jsonlPath = join(outDir, 'concepts.jsonl');
    const manifestPath = join(outDir, 'manifest.json');
    writeFileSync(jsonlPath, jsonl, 'utf8');
    const manifest = {
      version: meta.version,
      updatedAt: meta.updated_at,
      schemaVersion: meta.schema_version,
      counts: meta.counts,
      file: 'concepts.jsonl',
      sha256: createHash('sha256').update(jsonl).digest('hex'),
      size: Buffer.byteLength(jsonl, 'utf8'),
    };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return { manifestPath, jsonlPath, count: concepts.length, version: meta.version };
  }

  private todayVersion(): string {
    const d = new Date();
    return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
  }

  // ---------------- 备份与恢复 ----------------
  exportUserData(targetPath: unknown): { ok: true; path: string; count: number } | { ok: false; reason: string } {
    const p = resolvePathArg(targetPath);
    if (!p.ok) return p;

    const payload: ExportPayload = this.user.exportData({
      appVersion: this.appVersion,
      contentVersion: this.meta().version,
      titles: this.titles(),
    });
    mkdirSync(dirname(p.path), { recursive: true });
    writeFileSync(p.path, JSON.stringify(payload, null, 2), 'utf8');
    const d = new Date();
    this.user.setSetting(SETTING_KEYS.lastExport, d.toISOString());
    return { ok: true, path: p.path, count: payload.conceptState.length };
  }

  previewImportFile(rawPath: unknown): ImportPreview & { ok: boolean; reason?: string } {
    const rp = resolvePathArg(rawPath);
    if (!rp.ok) {
      return { ok: false, reason: rp.reason, total: 0, willUpdate: 0, unchanged: 0, older: 0, orphans: 0, favorites: 0, schemaVersion: -1, compatible: false, problems: [rp.reason] };
    }
    const path = rp.path;
    if (!existsSync(path)) {
      return { ok: false, reason: `文件不存在：${path}`, total: 0, willUpdate: 0, unchanged: 0, older: 0, orphans: 0, favorites: 0, schemaVersion: -1, compatible: false, problems: ['文件不存在'] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      return { ok: false, reason: `不是合法 JSON：${(e as Error).message}`, total: 0, willUpdate: 0, unchanged: 0, older: 0, orphans: 0, favorites: 0, schemaVersion: -1, compatible: false, problems: ['JSON 解析失败'] };
    }
    const known = new Set(listSummaries(this.contentDb).map((c) => c.id));
    const preview = this.user.previewImport(parsed, known);
    return { ok: true, ...preview, reason: preview.compatible ? undefined : preview.problems.join('；') };
  }

  applyImportFile(rawPath: unknown) {
    const rp = resolvePathArg(rawPath);
    if (!rp.ok) return { ok: false as const, reason: rp.reason };
    if (!existsSync(rp.path)) return { ok: false as const, reason: `文件不存在：${rp.path}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(rp.path, 'utf8')) as unknown;
    } catch (e) {
      return { ok: false as const, reason: `文件不是合法 JSON：${(e as Error).message}` };
    }
    const known = new Set(listSummaries(this.contentDb).map((c) => c.id));
    return this.user.applyImport(parsed, known);
  }

  resetProgress(confirmText: string, keepFavorites = true): { ok: boolean; cleared: number; reason?: string } {
    // 危险操作必须二次确认（PRD §6.7）：须输入确认文案
    if (confirmText.trim() !== '重置进度') {
      return { ok: false, cleared: 0, reason: '确认文案不正确，未执行重置' };
    }
    const cleared = this.user.resetProgress({ keepFavorites });
    return { ok: true, cleared };
  }

  listBackups(): string[] { return this.updater.listBackups(); }

  version(): string { return this.appVersion; }

  // ---------------- 统计 ----------------
  stats() {
    const meta = this.meta();
    const states = Object.values(this.user.getAllStates());
    return {
      meta,
      total: meta.counts.total,
      known: states.filter((s) => s.status === 'known').length,
      reading: states.filter((s) => s.status === 'reading').length,
      review: this.dueQueue().length,
      fuzzy: states.filter((s) => s.status === 'fuzzy').length,
      favorites: this.user.getFavorites().length,
      logs: this.user.countLogs(),
      tracks: listTracks(this.contentDb),
      countByDomain: countsOf(allConcepts(this.contentDb)),
    };
  }
}

export function buildJsonl(concepts: Concept[], version: string, updatedAt: string): string {
  const head = JSON.stringify({
    _meta: { version, updatedAt, schemaVersion: 1, counts: countsOf(concepts) },
  });
  const lines = concepts.map((c) => JSON.stringify(c));
  return [head, ...lines].join('\n') + '\n';
}

export { isoDay };
