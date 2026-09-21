import type { ConceptState, ConceptStatus } from '../../src/shared/types';
import { defaultState } from '../../src/shared/scheduler';
import type { Db } from './index';

export const USER_SCHEMA_VERSION = 1;

interface StateRow {
  concept_id: string; status: string; ease: number; interval_days: number;
  due_at: string | null; reps: number; lapses: number; last_review: string | null;
}

function rowToState(r: StateRow): ConceptState {
  return {
    concept_id: r.concept_id,
    status: r.status as ConceptStatus,
    ease: r.ease,
    interval_days: r.interval_days,
    due_at: r.due_at,
    reps: r.reps,
    lapses: r.lapses,
    last_review: r.last_review,
  };
}

export interface ExportPayload {
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  contentVersion: string;
  conceptState: {
    conceptId: string; title: string; status: string; ease: number;
    intervalDays: number; dueAt: string | null; reps: number;
    lapses: number; lastReview: string | null;
  }[];
  favorites: string[];
  settings: Record<string, string>;
  notes: unknown[];
}

export interface ImportPreview {
  total: number;
  willUpdate: number;
  unchanged: number;
  older: number;
  orphans: number;
  favorites: number;
  schemaVersion: number;
  compatible: boolean;
  problems: string[];
}

export class UserRepo {
  constructor(private db: Db) {}

  // ---------- 状态 ----------
  getState(id: string): ConceptState {
    const r = this.db.prepare('SELECT * FROM concept_state WHERE concept_id = ?').get(id) as StateRow | undefined;
    return r ? rowToState(r) : defaultState(id);
  }

  getAllStates(): Record<string, ConceptState> {
    const rows = this.db.prepare('SELECT * FROM concept_state').all() as unknown as StateRow[];
    const out: Record<string, ConceptState> = {};
    for (const r of rows) out[r.concept_id] = rowToState(r);
    return out;
  }

  /**
   * 手动设置状态（PRD §4.2.1 M2-O6）。各状态对 due_at 的影响：
   *   review  加入待复习 → 立即到期
   *   fuzzy   标记不懂   → 立即到期，且排在队列最前
   *   known   我掌握了   → **清空 due_at**，真正移出复习队列（用户主动断言）
   *   reading 在读       → 不动调度字段
   * 注意：复习页的「记得」走 applyReview，它保留 due_at 以形成间隔重复。
   */
  setStatus(id: string, status: ConceptStatus): ConceptState {
    const cur = this.getState(id);
    const next: ConceptState = { ...cur, status };
    if (status === 'review' || status === 'fuzzy') {
      next.due_at = isoToday();
    } else if (status === 'known') {
      next.due_at = null;
    }
    this.upsert(next);
    return next;
  }

  /** 复习评分落库：写状态 + 追加流水，单事务 */
  applyReview(id: string, out: {
    ease: number; interval_days: number; due_at: string;
    reps: number; lapses: number; status: ConceptStatus; last_review: string;
  }, rating: number): ConceptState {
    const next: ConceptState = { concept_id: id, ...out } as ConceptState;
    this.db.exec('BEGIN');
    try {
      this.upsert(next);
      this.db.prepare('INSERT INTO review_log(concept_id, rating, at) VALUES (?,?,?)')
        .run(id, rating, out.last_review);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return next;
  }

  private upsert(s: ConceptState): void {
    this.db.prepare(`INSERT INTO concept_state
      (concept_id, status, ease, interval_days, due_at, reps, lapses, last_review)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(concept_id) DO UPDATE SET
        status=excluded.status, ease=excluded.ease, interval_days=excluded.interval_days,
        due_at=excluded.due_at, reps=excluded.reps, lapses=excluded.lapses,
        last_review=excluded.last_review`)
      .run(s.concept_id, s.status, s.ease, s.interval_days, s.due_at, s.reps, s.lapses, s.last_review);
  }

  // ---------- 收藏 ----------
  getFavorites(): string[] {
    const rows = this.db.prepare('SELECT concept_id FROM favorites ORDER BY at').all() as { concept_id: string }[];
    return rows.map((r) => r.concept_id);
  }

  isFavorite(id: string): boolean {
    return !!this.db.prepare('SELECT 1 AS x FROM favorites WHERE concept_id = ?').get(id);
  }

  toggleFavorite(id: string): boolean {
    if (this.isFavorite(id)) {
      this.db.prepare('DELETE FROM favorites WHERE concept_id = ?').run(id);
      return false;
    }
    this.db.prepare('INSERT INTO favorites(concept_id, at) VALUES (?,?)').run(id, new Date().toISOString());
    return true;
  }

  // ---------- 设置 ----------
  getSetting(key: string, fallback = ''): string {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : fallback;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)').run(key, value);
  }

  allSettings(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ---------- 复习日志 ----------
  countLogs(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM review_log').get() as { n: number }).n;
  }

  // ---------- 重置 ----------
  /**
   * 重置进度。PRD §6.7：需二次确认（由 UI 负责），且**默认不清空收藏**。
   * 返回被清掉的进度条数。
   */
  resetProgress(opts: { keepFavorites: boolean } = { keepFavorites: true }): number {
    const n = (this.db.prepare('SELECT COUNT(*) AS n FROM concept_state').get() as { n: number }).n;
    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM concept_state');
      this.db.exec('DELETE FROM review_log');
      if (!opts.keepFavorites) this.db.exec('DELETE FROM favorites');
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return n;
  }

  // ---------- 导出 ----------
  exportData(opts: {
    appVersion: string; contentVersion: string;
    titles: Record<string, string>;
  }): ExportPayload {
    const states = this.getAllStates();
    return {
      schemaVersion: USER_SCHEMA_VERSION,
      appVersion: opts.appVersion,
      exportedAt: new Date().toISOString(),
      contentVersion: opts.contentVersion,
      conceptState: Object.values(states).map((s) => ({
        conceptId: s.concept_id,
        title: opts.titles[s.concept_id] ?? '',
        status: s.status,
        ease: s.ease,
        intervalDays: s.interval_days,
        dueAt: s.due_at,
        reps: s.reps,
        lapses: s.lapses,
        lastReview: s.last_review,
      })),
      favorites: this.getFavorites(),
      settings: this.allSettings(),
      notes: [],
    };
  }

  // ---------- 导入：先预览，再合并 ----------
  /**
   * 恢复是**合并式**而不是覆盖式（PRD §6.5）：
   * 同一条进度按 last_review 取较新者；概念已不存在则仍写入（孤儿记录），不报错。
   */
  previewImport(payload: unknown, knownIds: Set<string>): ImportPreview {
    // 载荷来自外部文件，必须是 null 安全的
    const p = (payload && typeof payload === 'object' ? payload : {}) as Partial<ExportPayload>;
    const problems: string[] = [];
    if (!p || typeof p !== 'object') problems.push('文件内容不是合法 JSON 对象');
    if (!Array.isArray(p?.conceptState)) problems.push('缺少 conceptState 数组');
    if (typeof p?.schemaVersion !== 'number') problems.push('缺少 schemaVersion');
    if (p.schemaVersion !== undefined && p.schemaVersion > USER_SCHEMA_VERSION) {
      problems.push(`文件 schemaVersion=${p.schemaVersion} 高于当前支持的 ${USER_SCHEMA_VERSION}`);
    }

    const cur = this.getAllStates();
    let willUpdate = 0, unchanged = 0, older = 0, orphans = 0;
    const list = Array.isArray(p?.conceptState) ? p!.conceptState : [];
    for (const item of list) {
      const id = item?.conceptId;
      if (typeof id !== 'string' || !id) continue;
      if (!knownIds.has(id)) orphans += 1;
      const prev = cur[id];
      const incomingAt = item.lastReview ?? null;
      if (!prev || !prev.last_review) { willUpdate += 1; continue; }
      if (!incomingAt) { older += 1; continue; }
      const a = Date.parse(incomingAt);
      const b = Date.parse(prev.last_review);
      if (!Number.isFinite(a) || !Number.isFinite(b)) { willUpdate += 1; continue; }
      if (a > b) willUpdate += 1;
      else if (a === b) unchanged += 1;
      else older += 1;
    }

    return {
      total: list.length,
      willUpdate, unchanged, older, orphans,
      favorites: Array.isArray(p?.favorites) ? p!.favorites.length : 0,
      schemaVersion: typeof p?.schemaVersion === 'number' ? p.schemaVersion : -1,
      compatible: problems.length === 0,
      problems,
    };
  }

  applyImport(payload: unknown, knownIds?: Set<string>): { applied: number; favorites: number; orphans: number; skipped: number } {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Partial<ExportPayload>;
    const list = Array.isArray(p?.conceptState) ? p!.conceptState : [];
    const cur = this.getAllStates();
    let applied = 0, skipped = 0, orphanCount = 0;

    this.db.exec('BEGIN');
    try {
      const upsert = this.db.prepare(`INSERT INTO concept_state
        (concept_id, status, ease, interval_days, due_at, reps, lapses, last_review)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(concept_id) DO UPDATE SET
          status=excluded.status, ease=excluded.ease, interval_days=excluded.interval_days,
          due_at=excluded.due_at, reps=excluded.reps, lapses=excluded.lapses,
          last_review=excluded.last_review`);

      for (const item of list) {
        const id = item?.conceptId;
        if (typeof id !== 'string' || !id) { skipped += 1; continue; }
        const prev = cur[id];
        const incomingAt = item.lastReview ?? null;
        // 合并规则：取较新者
        if (prev?.last_review && incomingAt) {
          const a = Date.parse(incomingAt);
          const b = Date.parse(prev.last_review);
          if (Number.isFinite(a) && Number.isFinite(b) && a <= b) { skipped += 1; continue; }
        } else if (prev?.last_review && !incomingAt) {
          skipped += 1; continue;
        }
        upsert.run(
          id,
          typeof item.status === 'string' ? item.status : 'unread',
          Number.isFinite(item.ease) ? item.ease : 2.5,
          Number.isFinite(item.intervalDays) ? item.intervalDays : 0,
          item.dueAt ?? null,
          Number.isFinite(item.reps) ? item.reps : 0,
          Number.isFinite(item.lapses) ? item.lapses : 0,
          incomingAt,
        );
        applied += 1;
        if (knownIds && !knownIds.has(id)) orphanCount += 1;
      }

      let favs = 0;
      if (Array.isArray(p?.favorites)) {
        const insF = this.db.prepare('INSERT OR IGNORE INTO favorites(concept_id, at) VALUES (?,?)');
        for (const id of p!.favorites) {
          if (typeof id === 'string' && id) { insF.run(id, new Date().toISOString()); favs += 1; }
        }
      }

      if (p?.settings && typeof p.settings === 'object') {
        const insS = this.db.prepare('INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)');
        for (const [k, v] of Object.entries(p.settings)) {
          if (typeof v === 'string') insS.run(k, v);
        }
      }
      this.db.exec('COMMIT');
      return { applied, favorites: favs, orphans: orphanCount, skipped };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
}

export function isoToday(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
