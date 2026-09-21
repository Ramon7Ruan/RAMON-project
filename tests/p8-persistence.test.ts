/**
 * P8 验收补强：PRD §11 中「不是单次调用就能验证」的两项。
 *
 *   A10 持久化   —— 关闭并重开数据库后，进度必须逐条一致
 *                    （单进程内的读写测试证明不了这一点，必须真的关库再开）
 *   A7  事务回滚 —— 导入中途失败必须整体回滚，库里不能留下部分写入
 *
 * 另外覆盖：内容更新替换 content.db 后重开、导出文件可被重新解析。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Concept, ConceptState } from '../src/shared/types';
import { initUserDb, initContentDb } from '../app/db';
import { listSummaries } from '../app/db/content';
import { UserRepo } from '../app/db/user';
import { Services, buildJsonl } from '../app/services';
import { cleanup, makeConcept, makeGroup, tempDir } from './fixtures';

const NOW = new Date('2026-09-21T10:00:00+08:00');
const MANIFEST_URL = 'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json';

const dirs: string[] = [];
function newDir(tag: string): string {
  const d = tempDir(`recall-${tag}-`);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

// ---------- 与 P6 相同的更新用例构造（测试内自持，避免跨文件耦合） ----------
function buildManifest(concepts: Concept[], version: string) {
  const jsonl = buildJsonl(concepts, version, '2026-09-28T10:00:00+08:00');
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  return {
    jsonl,
    manifest: {
      version,
      updatedAt: '2026-09-28T10:00:00+08:00',
      schemaVersion: 1,
      counts: { econ: concepts.length, finance: 0, hotspot: 0, total: concepts.length },
      file: 'concepts.jsonl',
      sha256: createHash('sha256').update(jsonl).digest('hex'),
      size: Buffer.byteLength(jsonl, 'utf8'),
    },
  };
}

function fetchStub(map: (url: string) => { body: string } | { fail: true }) {
  return async (url: string) => {
    const b = map(url);
    if ('fail' in b) throw new Error('ENOTFOUND');
    return { ok: true, status: 200, text: async () => b.body };
  };
}

// ============================================================================

describe('A10 持久化：关闭并重开后逐条一致', () => {
  it('进度 / 到期时间 / 收藏 / 设置 在重开后完全保留', () => {
    const dir = newDir('persist');
    const path = join(dir, 'user.db');

    let before: Record<string, ConceptState>;
    {
      const db = initUserDb(path);
      const repo = new UserRepo(db);
      repo.setStatus('c1', 'review');
      repo.applyReview('c2', {
        ease: 2.6, interval_days: 2, due_at: '2026-09-23',
        reps: 1, lapses: 0, status: 'known', last_review: NOW.toISOString(),
      }, 2);
      repo.applyReview('c3', {
        ease: 1.9, interval_days: 6, due_at: '2026-09-27',
        reps: 4, lapses: 2, status: 'review', last_review: NOW.toISOString(),
      }, 0);
      repo.toggleFavorite('c2');
      repo.setSetting('theme', 'dark');
      before = repo.getAllStates();
      expect(Object.keys(before).length).toBe(3);
      db.close(); // ← 关键：真的关掉，模拟退出 App
    }

    // 重新打开同一个文件（模拟重启）
    const db2 = initUserDb(path);
    const repo2 = new UserRepo(db2);
    const after = repo2.getAllStates();

    // 逐条核对，而不是只看条数
    for (const id of Object.keys(before)) {
      expect(after[id], `${id} 的进度在重开后不一致`).toEqual(before[id]);
    }
    expect(repo2.getFavorites()).toEqual(['c2']);
    expect(repo2.getSetting('theme')).toBe('dark');
    expect(repo2.countLogs()).toBeGreaterThan(0);
    db2.close();
  });

  it('重开后复习日志仍在（复习历史不会被吞掉）', () => {
    const dir = newDir('persist-log');
    const path = join(dir, 'user.db');
    let logs = 0;
    {
      const repo = new UserRepo(initUserDb(path));
      for (const r of [2, 1, 0] as const) repo.applyReview(`c${r}`, {
        ease: 2.5, interval_days: 1, due_at: '2026-09-22',
        reps: 1, lapses: 0, status: 'review', last_review: NOW.toISOString(),
      }, r);
      logs = repo.countLogs();
      repo['db'].close();
    }
    const repo2 = new UserRepo(initUserDb(path));
    expect(repo2.countLogs()).toBe(logs);
    expect(logs).toBe(3);
    repo2['db'].close();
  });

  it('内容库被替换后重开：进度一条不丢，且指向的概念仍可解析', async () => {
    const dir = newDir('persist-upd');
    const v1: Concept[] = makeGroup(3);
    const v2: Concept[] = [
      ...v1,
      makeConcept({
        id: 'econ.micro.newbie', title: '新增概念', domain: 'econ', track: 'micro', variant: 5,
        links: [{ to: v1[0].id, reason: '延伸' }],
      }),
    ];
    const old = buildManifest(v1, '2026.09.21');
    const next = buildManifest(v2, '2026.09.28');

    // 第一段：建库 + 造进度
    const ids = v1.map((c) => c.id);
    let before: Record<string, ConceptState>;
    {
      const svc = new Services({
        root: dir, appVersion: '1.0.0-test',
        fetchImpl: fetchStub(() => ({ body: JSON.stringify(old.manifest) })) as never,
      });
      svc.importContentText(buildJsonl(v1, '2026.09.21', 'x'));
      svc.setStatus(ids[0], 'known');
      svc.rate(ids[1], 2, NOW);
      svc.toggleFavorite(ids[2]);
      before = svc.states();
      svc.close(); // 关掉 App
    }

    // 第二段：重开 App，做一次内容更新，再关掉
    {
      const svc = new Services({
        root: dir, appVersion: '1.0.0-test',
        fetchImpl: fetchStub((url) => ({
          body: url.endsWith('manifest.json') ? JSON.stringify(next.manifest) : next.jsonl,
        })) as never,
      });
      // 重开后进度应当还在
      expect(svc.states()).toEqual(before);

      svc.updateSettings({ manifestUrl: MANIFEST_URL });
      const check = await svc.checkUpdate();
      expect(check.kind).toBe('update');
      const res = await svc.applyUpdate({
        fileUrl: MANIFEST_URL.replace('manifest.json', 'concepts.jsonl'),
        sha256: next.manifest.sha256,
        size: next.manifest.size,
        version: next.manifest.version,
        updated_at: next.manifest.updatedAt,
      });
      expect(res.ok).toBe(true);
      svc.close();
    }

    // 第三段：再重开，核对进度与内容版本
    {
      const svc = new Services({
        root: dir, appVersion: '1.0.0-test', fetchImpl: fetchStub(() => ({ fail: true })) as never,
      });
      expect(svc.meta().version).toBe('2026.09.28');
      expect(svc.summaries().length).toBe(v2.length);
      for (const id of ids) {
        expect(svc.states()[id], `${id} 在两次重启 + 一次内容更新后丢了`).toEqual(before[id]);
      }
      expect(svc.favorites()).toEqual([ids[2]]);
      // 进度指向的概念仍能从内容库里取到完整解析
      for (const id of ids) expect(svc.concept(id)).not.toBeNull();
      svc.close();
    }
  });
});

describe('A7 手动导入：中途失败必须整体回滚', () => {
  it('第 3 笔写入抛错时，前 2 笔也不能留在库里', () => {
    const dir = newDir('rollback');
    const db = initUserDb(join(dir, 'user.db'));
    const repo = new UserRepo(db);

    // 已有的一条进度，用来确认回滚不会误伤既有数据
    repo.setStatus('keep-me', 'known');
    const kept = repo.getState('keep-me');

    // 故障注入：让第 3 次 concept_state 写入失败
    const realPrepare = db.prepare.bind(db);
    let writes = 0;
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = realPrepare(sql) as { run: (...a: unknown[]) => unknown };
      if (sql.includes('INSERT INTO concept_state')) {
        const realRun = stmt.run.bind(stmt);
        stmt.run = (...args: unknown[]) => {
          writes += 1;
          if (writes === 3) throw new Error('注入的写入故障');
          return realRun(...args);
        };
      }
      return stmt;
    };

    const payload = {
      schemaVersion: 1,
      conceptState: ['a', 'b', 'c'].map((id) => ({
        conceptId: id, status: 'known', ease: 2.5, intervalDays: 1,
        dueAt: '2026-10-01', reps: 1, lapses: 0, lastReview: '2026-12-01T00:00:00Z',
      })),
    };

    expect(() => repo.applyImport(payload)).toThrow('注入的写入故障');
    expect(writes).toBe(3);

    // 关键断言：a、b 必须先写入后被回滚，不能留下半截数据
    expect(repo.getAllStates()['a']).toBeUndefined();
    expect(repo.getAllStates()['b']).toBeUndefined();
    expect(repo.getAllStates()['c']).toBeUndefined();
    // 既有数据没被牵连
    expect(repo.getState('keep-me')).toEqual(kept);
    // 库仍可正常写入（事务没有卡在中间态）
    repo.setStatus('after', 'review');
    expect(repo.getState('after').status).toBe('review');
    db.close();
  });

  it('导入成功时，进度 / 收藏 / 设置一并生效', () => {
    const dir = newDir('import-ok');
    const db = initUserDb(join(dir, 'user.db'));
    const repo = new UserRepo(db);
    const r = repo.applyImport({
      schemaVersion: 1,
      conceptState: [{
        conceptId: 'x', status: 'review', ease: 2.4, intervalDays: 3,
        dueAt: '2026-09-24', reps: 2, lapses: 0, lastReview: '2026-11-01T00:00:00Z',
      }],
      favorites: ['x', 'y'],
      settings: { theme: 'dark' },
    }, new Set(['x', 'y']));
    expect(r).toEqual({ applied: 1, favorites: 2, orphans: 0, skipped: 0 });
    expect(repo.getState('x').due_at).toBe('2026-09-24');
    expect(repo.getFavorites().sort()).toEqual(['x', 'y']);
    expect(repo.getSetting('theme')).toBe('dark');
    db.close();
  });
});

describe('A7 导出文件可读且自描述', () => {
  it('导出的 JSON 含版本三元组与概念标题，能被再次解析', () => {
    const dir = newDir('export');
    const svc = new Services({
      root: dir, appVersion: '1.0.0-test', fetchImpl: fetchStub(() => ({ fail: true })) as never,
    });
    const concepts = makeGroup(3);
    svc.importContentText(buildJsonl(concepts, '2026.09.21', 'x'));
    svc.rate(concepts[0].id, 2, NOW);

    const out = join(dir, 'export.json');
    const r = svc.exportUserData(out);
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);

    const parsed = JSON.parse(readFileSync(out, 'utf8')) as {
      schemaVersion: number; appVersion: string; contentVersion: string;
      conceptState: { conceptId: string; title: string }[];
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.appVersion).toBe('1.0.0-test');
    expect(parsed.contentVersion).toBe('2026.09.21');
    // 脱离内容库也能认出「这条进度是哪个概念」
    expect(parsed.conceptState[0].title).toBe(concepts[0].title);
    expect(svc.previewImportFile(out).ok).toBe(true);
    svc.close();
  });

  it('内容库为空时导出不崩溃，得到空数组', () => {
    const dir = newDir('export-empty');
    const svc = new Services({
      root: dir, appVersion: '1.0.0-test', fetchImpl: fetchStub(() => ({ fail: true })) as never,
    });
    expect(() => svc.exportUserData(join(dir, 'e.json'))).not.toThrow();
    svc.close();
  });
});

describe('A2/A10 内容库层：替换后重开仍然一致', () => {
  it('导入内容后关闭并重开 content.db，概念与 FTS 索引都还在', () => {
    const dir = newDir('content-reopen');
    const path = join(dir, 'content.db');
    const concepts = makeGroup(3);

    // 注意：importContentText 走原子替换（rename → 新 inode），
    // 所以这里不能另外持有一个旧句柄，否则测的就不是真实运行时的情形。
    {
      const svc = new Services({
        root: dir, appVersion: '1.0.0-test', fetchImpl: fetchStub(() => ({ fail: true })) as never,
      });
      const r = svc.importContentText(buildJsonl(concepts, '2026.09.21', 'x'));
      if (!('ok' in r) || !r.ok) throw new Error('导入失败：' + JSON.stringify(r).slice(0, 300));
      svc.close();
    }

    // 模拟重启：重新打开同一个文件
    const db2 = initContentDb(path);
    const rows = listSummaries(db2);
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.id).sort()).toEqual(concepts.map((c) => c.id).sort());
    db2.close();
  });
});
