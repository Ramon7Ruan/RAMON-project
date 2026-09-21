import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initContentDb, initUserDb, removeDbFiles } from '../app/db';
import { buildContentDb, getConcept, listSummaries, listTracks, readMeta, search, allConcepts } from '../app/db/content';
import { UserRepo } from '../app/db/user';
import { cleanup, makeConcept, makeGroup, tempDir } from './fixtures';
import type { Db } from '../app/db';

let dir: string;
let cdb: Db;
let udb: Db;

function tables(db: Db): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name").all() as { name: string }[])
    .map((r) => r.name);
}

describe('P4 双库初始化与 Schema', () => {
  beforeAll(() => {
    dir = tempDir();
    cdb = initContentDb(join(dir, 'content.db'));
    udb = initUserDb(join(dir, 'user.db'));
  });
  afterAll(() => { cleanup(dir); });

  it('content.db 建出全部表，含 FTS5 虚表', () => {
    const t = tables(cdb);
    for (const name of ['meta', 'tracks', 'concepts']) expect(t).toContain(name);
    // FTS5 虚表在 sqlite_master 里以 table 形式出现
    expect(t.some((x) => x.startsWith('concepts_fts'))).toBe(true);
  });

  it('user.db 建出全部表，且 notes 表按 PRD §6.3 首版不启用', () => {
    const t = tables(udb);
    for (const name of ['concept_state', 'review_log', 'favorites', 'settings']) expect(t).toContain(name);
    expect(t, 'notes 表首版不启用，不应被创建').not.toContain('notes');
  });

  it('两个库都启用 WAL 模式（异常退出时的一致性保障）', () => {
    expect((cdb.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    expect((udb.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
  });

  it('9 个专题已预置，且分属三大区', () => {
    const tracks = listTracks(cdb);
    expect(tracks.length).toBe(9);
    expect(tracks.filter((t) => t.domain === 'econ').length).toBe(3);
    expect(tracks.filter((t) => t.domain === 'finance').length).toBe(4);
    expect(tracks.filter((t) => t.domain === 'hotspot').length).toBe(2);
  });

  it('写入内容库后 meta / 概念 / 计数一致', () => {
    const concepts = [
      makeConcept({ id: 'econ.macro.alpha', title: '甲概念', links: [{ to: 'finance.bond.beta', reason: '测试' }] }),
      makeConcept({ id: 'finance.bond.beta', domain: 'finance', track: 'bond', title: '乙概念', links: [{ to: 'hotspot.event.gamma', reason: '测试' }] }),
      makeConcept({ id: 'hotspot.event.gamma', domain: 'hotspot', track: 'event', title: '丙概念', links: [{ to: 'econ.macro.alpha', reason: '测试' }] }),
      makeConcept({ id: 'econ.micro.delta', domain: 'econ', track: 'micro', title: '丁概念', links: [{ to: 'econ.macro.alpha', reason: '测试' }] }),
    ];
    const meta = buildContentDb(cdb, concepts, { version: '2026.09.21', updated_at: '2026-09-21T10:00:00+08:00', schema_version: 1 });
    expect(meta.counts).toEqual({ econ: 2, finance: 1, hotspot: 1, total: 4 });
    expect(readMeta(cdb).version).toBe('2026.09.21');
    expect(allConcepts(cdb).length).toBe(4);
    expect(getConcept(cdb, 'finance.bond.beta')?.title).toBe('乙概念');
    expect(getConcept(cdb, '不存在')).toBeNull();
  });

  it('要点速览所需字段齐备，且 summaries 不含 blocks/links', () => {
    const s = listSummaries(cdb);
    expect(s.length).toBe(4);
    const one = s.find((x) => x.id === 'econ.macro.alpha')!;
    expect(one.key_points.length).toBeGreaterThan(0);
    expect(one.recipe.length).toBeGreaterThan(0);
    expect((one as unknown as { blocks?: unknown }).blocks).toBeUndefined();
  });

  it('FTS5 能搜到中文子串（unicode61 + CJK 预分词）', () => {
    const hits = search(cdb, '概念', 20);
    expect(hits.length).toBeGreaterThan(0);
    // 子串命中：标题里是「甲概念」，搜「概念」必须能中
    expect(hits.map((h) => h.id)).toContain('econ.macro.alpha');
  });

  it('FTS5 能搜到跨字子串与中英混排', () => {
    const c = makeConcept({ id: 'econ.macro.delta', title: '流动性陷阱', one_liner: '利率降到零之后还剩什么？', key_points: ['货币需求曲线垂直'], links: [] });
    buildContentDb(cdb, [c], { version: '2026.09.22', updated_at: 'x', schema_version: 1 });
    expect(search(cdb, '陷阱', 10).map((h) => h.id)).toContain('econ.macro.delta');
    expect(search(cdb, '流动性', 10).map((h) => h.id)).toContain('econ.macro.delta');
  });

  it('搜索空串返回空，且不抛异常', () => {
    expect(search(cdb, '', 10)).toEqual([]);
    expect(search(cdb, '   ', 10)).toEqual([]);
  });

  it('removeDbFiles 会一并清掉 WAL 附属文件', () => {
    const p = join(dir, 'tmp-remove.db');
    const d = initContentDb(p);
    d.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('k', 'v');
    d.close();
    expect(existsSync(p)).toBe(true);
    removeDbFiles(p);
    expect(existsSync(p)).toBe(false);
    expect(existsSync(`${p}-wal`)).toBe(false);
  });
});

describe('P4 user.db 用户数据', () => {
  let d2: string;
  let repo: UserRepo;

  beforeAll(() => {
    d2 = tempDir();
    repo = new UserRepo(initUserDb(join(d2, 'user.db')));
  });
  afterAll(() => { cleanup(d2); });

  it('默认状态是 unread，未知概念读取不报错', () => {
    const s = repo.getState('从未见过的概念');
    expect(s.status).toBe('unread');
    expect(s.ease).toBe(2.5);
    expect(s.due_at).toBeNull();
  });

  it('设置状态；「加入待复习」立即到期', () => {
    repo.setStatus('a', 'known');
    expect(repo.getState('a').status).toBe('known');
    const r = repo.setStatus('b', 'review');
    expect(r.status).toBe('review');
    expect(r.due_at).toBeTruthy();
  });

  it('复习落库同时追加 review_log（单事务）', () => {
    const before = repo.countLogs();
    repo.applyReview('a', {
      ease: 2.6, interval_days: 5, due_at: '2026-09-26',
      reps: 1, lapses: 0, status: 'known', last_review: '2026-09-21T12:00:00.000Z',
    }, 2);
    const s = repo.getState('a');
    expect(s.ease).toBe(2.6);
    expect(s.interval_days).toBe(5);
    expect(repo.countLogs()).toBe(before + 1);
  });

  it('收藏可切换；设置可读写', () => {
    expect(repo.toggleFavorite('a')).toBe(true);
    expect(repo.isFavorite('a')).toBe(true);
    expect(repo.toggleFavorite('a')).toBe(false);
    repo.setSetting('theme', 'dark');
    expect(repo.getSetting('theme')).toBe('dark');
    expect(repo.getSetting('不存在', '兜底')).toBe('兜底');
  });

  it('重置进度默认保留收藏（PRD §6.7）', () => {
    repo.toggleFavorite('a');
    repo.setStatus('c', 'known');
    const n = repo.resetProgress({ keepFavorites: true });
    expect(n).toBeGreaterThan(0);
    expect(Object.keys(repo.getAllStates()).length).toBe(0);
    expect(repo.getFavorites()).toContain('a');
    expect(repo.countLogs()).toBe(0);
  });

  it('显式要求时才会清空收藏', () => {
    repo.toggleFavorite('a');
    repo.resetProgress({ keepFavorites: false });
    expect(repo.getFavorites()).toEqual([]);
  });
});

describe('P4 备份与恢复语义', () => {
  let d3: string;
  let repo: UserRepo;

  beforeAll(() => {
    d3 = tempDir();
    repo = new UserRepo(initUserDb(join(d3, 'user.db')));
    repo.applyReview('keep-me', {
      ease: 2.5, interval_days: 3, due_at: '2026-09-24', reps: 1, lapses: 0,
      status: 'known', last_review: '2026-09-21T00:00:00.000Z',
    }, 2);
  });
  afterAll(() => { cleanup(d3); });

  it('导出包含 schemaVersion / appVersion / contentVersion / 概念标题', () => {
    const p = repo.exportData({ appVersion: '1.0.0', contentVersion: '2026.09.21', titles: { 'keep-me': '被保留的概念' } });
    expect(p.schemaVersion).toBe(1);
    expect(p.appVersion).toBe('1.0.0');
    expect(p.contentVersion).toBe('2026.09.21');
    expect(p.conceptState[0].title).toBe('被保留的概念');
    expect(p.notes).toEqual([]);
  });

  it('导入预览要区分「更新 / 相同 / 更旧 / 孤儿」', () => {
    const known = new Set(['keep-me']);
    const older = { schemaVersion: 1, conceptState: [{ conceptId: 'keep-me', lastReview: '2026-01-01T00:00:00.000Z' }] };
    const pv1 = repo.previewImport(older, known);
    expect(pv1.older).toBe(1);
    expect(pv1.willUpdate).toBe(0);

    const newer = { schemaVersion: 1, conceptState: [
      { conceptId: 'keep-me', lastReview: '2026-12-01T00:00:00.000Z' },
      { conceptId: '已不存在的概念', lastReview: '2026-12-01T00:00:00.000Z' },
    ] };
    const pv2 = repo.previewImport(newer, known);
    expect(pv2.willUpdate).toBe(2);
    expect(pv2.orphans).toBe(1);
  });

  it('导入是合并式：同一条取 last_review 较新者', () => {
    // 更旧的应当被跳过
    repo.applyImport({ schemaVersion: 1, conceptState: [{ conceptId: 'keep-me', status: 'fuzzy', lastReview: '2026-01-01T00:00:00.000Z' }] });
    expect(repo.getState('keep-me').status).toBe('known');

    // 更新的应当覆盖
    repo.applyImport({ schemaVersion: 1, conceptState: [{ conceptId: 'keep-me', status: 'fuzzy', lastReview: '2026-12-01T00:00:00.000Z' }] });
    expect(repo.getState('keep-me').status).toBe('fuzzy');
  });

  it('概念已不存在时写成孤儿记录，不报错（PRD §6.3）', () => {
    const r = repo.applyImport({ schemaVersion: 1, conceptState: [{ conceptId: '孤儿概念', status: 'known', lastReview: '2026-12-02T00:00:00.000Z' }] }, new Set(['keep-me']));
    expect(r.orphans).toBe(1);
    expect(repo.getState('孤儿概念').status).toBe('known');
  });

  it('schema 版本高于当前支持时报不兼容', () => {
    const pv = repo.previewImport({ schemaVersion: 99, conceptState: [] }, new Set());
    expect(pv.compatible).toBe(false);
    expect(pv.problems.join()).toContain('schemaVersion');
  });

  it('非法载荷被识别为不兼容而不是崩溃', () => {
    expect(repo.previewImport(null, new Set()).compatible).toBe(false);
    expect(() => repo.applyImport(null)).not.toThrow();
    expect(repo.previewImport({ foo: 1 }, new Set()).compatible).toBe(false);
  });
});
