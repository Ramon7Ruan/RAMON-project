import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { CONTENT_DDL, USER_DDL, DEFAULT_TRACKS } from './schema';

export type Db = DatabaseSync;

export function ensureDir(file: string): void {
  const d = dirname(file);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

export interface PragmaReport {
  wal: boolean;
  note?: string;
}

/**
 * WAL 提升并发与崩溃恢复能力，属于**增强**而非前提：
 * 某些文件系统 / 受限环境下切 WAL 会失败，此时退回默认的 rollback journal，
 * 数据库依然是一致且可恢复的，只是并发弱一些。
 * 重点是：这种情况下应用必须照常可用，而不是启动失败。
 */
export function applyPragmas(db: Db): PragmaReport {
  let wal = false;
  let note: string | undefined;
  try {
    db.exec('PRAGMA journal_mode = WAL');
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
    wal = (row?.journal_mode ?? '').toLowerCase() === 'wal';
    if (!wal) note = `WAL 未启用（当前 ${row?.journal_mode ?? '未知'}），已退回默认日志模式`;
  } catch (e) {
    note = `启用 WAL 失败（${(e as Error).message}），已退回默认日志模式`;
  }
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA busy_timeout = 5000');
  return { wal, note };
}

/** 打开（必要时创建并初始化）内容库 */
export const lastPragmaReport: { content?: PragmaReport; user?: PragmaReport } = {};

export function initContentDb(path: string): Db {
  ensureDir(path);
  const db = new DatabaseSync(path);
  lastPragmaReport.content = applyPragmas(db);
  db.exec(CONTENT_DDL);
  seedTracks(db);
  return db;
}

/** 打开（必要时创建并初始化）用户库 */
export function initUserDb(path: string): Db {
  ensureDir(path);
  const db = new DatabaseSync(path);
  lastPragmaReport.user = applyPragmas(db);
  db.exec(USER_DDL);
  return db;
}

function seedTracks(db: Db): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number };
  if (row && row.n > 0) return;
  const ins = db.prepare('INSERT OR REPLACE INTO tracks(key, domain, label, sort) VALUES (?,?,?,?)');
  for (const t of DEFAULT_TRACKS) ins.run(t.key, t.domain, t.label, t.sort);
}

/** 删除一个 sqlite 文件及其 WAL 附属文件（用于替换前的清理） */
export function removeDbFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = path + suffix;
    if (existsSync(f)) rmSync(f, { force: true });
  }
}
